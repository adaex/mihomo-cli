import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { getKernelVersion, hasConfig, hasKernel } from './config.js';
import { PATHS } from './paths.js';
import type { ProcessInfo, ProcessStatus, StaleState } from './types.js';
import { escapeRegExp } from './utils.js';

/**
 * 进程探测：ps/pgrep 查询、pid 文件、运行状态。只读、无副作用，是启停与状态展示的共同底层。
 * 依赖 config 仅为 getStatus 顺带返回 hasConfig/hasKernel/kernelVersion（均为只读文件检查）。
 */

/** ps 查询超时：探测进程存活/属主/命令行的统一上限，卡住时按不存在处理 */
const PS_TIMEOUT_MS = 5000;

export function isProcessRunning(pid: number): boolean {
  if (!pid) return false;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
    return (result.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 校验 pid 对应进程的命令行是否包含指定子串（防 PID 复用误杀：pid 文件残留后该 pid 可能已被
 * 系统分配给无关进程）。读不到命令行时保守返回 false。
 *
 * 必须带 `-ww`：BSD/macOS 的 ps 即使 stdout 不是终端也会把 command 列截断到 79 列。
 * 当前唯一的 needle 是 binary 路径（偏移 0，截不掉），但偏移靠后的 needle 会越过 79 列
 * → 匹配恒 false → 该停的进程跳过 SIGKILL 却仍删掉 pid 文件，残留进程再无记录可查。
 * 新增调用方时别把 `-ww` 去掉。
 */
export function isProcessCommandMatching(pid: number, needle: string): boolean {
  if (!pid) return false;
  try {
    const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
    return (result.stdout || '').includes(needle);
  } catch {
    return false;
  }
}

export function isProcessRoot(pid: number): boolean {
  if (!pid) return false;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'uid='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
    return (result.stdout || '').trim() === '0';
  } catch {
    return false;
  }
}

/**
 * pgrep/pkill -f 用于识别「主实例」的正则:内核路径 + 主 configFile 两段拼接。
 * service(plist)、tun(脚本)两种启动的命令行都是 `<binary> -d <data> -f <configFile>`,
 * 均含这两段;而仅用编辑器打开配置文件的进程(命令行无 binary)不会命中,
 * 从而避免误杀/误判为残留。escapeRegExp 防止路径里的 `.` 当通配符。
 *
 * **内核路径必须匹配两种形式**:服务经符号链 `kernel/mihomo-cli-service` 启动,
 * tun 经真实二进制 `kernel/mihomo` 启动,而进程命令行记录的是**启动时用的那个路径**——
 * 实测 `ps -ww -o command=` 对符号链启动的进程输出符号链名,用真实文件名 pgrep 匹配不到。
 * 只认一种会漏掉另一种:残留进程杀不掉、getMihomoPids 漏报、状态误判。
 */
const BINARY_ALTERNATION = `(?:${escapeRegExp(PATHS.serviceBinary)}|${escapeRegExp(PATHS.mihomoBinary)})`;
export const MAIN_INSTANCE_PATTERN = `${BINARY_ALTERNATION}.*${escapeRegExp(PATHS.configFile)}`;

/**
 * pid 文件**只有 tun 在用**：服务由 launchd 托管，PID 从 `launchctl print` 取，不写 pid 文件。
 * 故 getPid/isRunning 是「tun 是否在跑」的判断，服务状态一律走 service.ts 的 getServiceStatus。
 */
export function getPid(): number | null {
  if (!fs.existsSync(PATHS.pidFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(PATHS.pidFile, 'utf8').trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isRunning(): boolean {
  const pid = getPid();
  if (!pid) return false;
  // 同时校验命令行含内核路径：pidFile 残留 + 系统重启后 PID 可能被无关进程复用，
  // 只看存活会把无关进程误判成运行中的 mihomo。
  // 两种路径都要认：pid 文件虽只由 tun 写（真实二进制），但用户可能手工介入，
  // 只认真实路径会把符号链启动的实例判成「不是 mihomo」
  return isProcessRunning(pid) && (isProcessCommandMatching(pid, PATHS.mihomoBinary) || isProcessCommandMatching(pid, PATHS.serviceBinary));
}

export function getMihomoPids(): number[] {
  try {
    const result = spawnSync('pgrep', ['-f', MAIN_INSTANCE_PATTERN], { encoding: 'utf8', timeout: 10_000 });
    const output = (result.stdout || '').trim();
    if (!output) return [];
    return output
      .split('\n')
      .filter(Boolean)
      .map(p => parseInt(p, 10))
      .filter(p => Number.isInteger(p) && p > 0);
  } catch {
    return [];
  }
}

export function isPidFileOwnedByRoot(): boolean {
  if (!fs.existsSync(PATHS.pidFile)) return false;
  try {
    const stat = fs.statSync(PATHS.pidFile);
    return stat.uid === 0;
  } catch {
    return false;
  }
}

export function checkStaleState(): StaleState {
  const allPids = getMihomoPids();
  const hasRootProcess = allPids.some(p => isProcessRoot(p));
  const hasRootPidFile = isPidFileOwnedByRoot();

  return {
    needsCleanup: allPids.length > 0 || hasRootPidFile,
    allPids,
    hasRootProcess,
    hasRootPidFile,
    needsSudo: hasRootProcess || hasRootPidFile,
  };
}

function getProcessInfo(pid: number): ProcessInfo | null {
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'rss='], { encoding: 'utf8', timeout: 5000 });
    const psOutput = (result.stdout || '').trim();
    if (!psOutput) return null;

    const rss = parseInt(psOutput, 10);

    return {
      pid,
      memory: rss ? `${(rss / 1024).toFixed(1)} MB` : '未知',
      isRoot: isProcessRoot(pid),
    };
  } catch {
    return { pid, memory: '未知', isRoot: false };
  }
}

export function getStatus(): ProcessStatus {
  const running = isRunning();
  const pid = getPid();

  return {
    running,
    pid: running ? pid : null,
    processInfo: running && pid ? getProcessInfo(pid) : null,
    hasConfig: hasConfig(),
    hasKernel: hasKernel(),
    kernelVersion: getKernelVersion(),
  };
}
