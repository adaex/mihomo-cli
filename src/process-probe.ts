import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { CliError } from './errors.js';
import { PATHS } from './paths.js';
import { escapeRegExp } from './text.js';
import type { ProcessStatus, StaleState } from './types.js';

/**
 * 进程探测：ps/pgrep 查询、pid 文件、运行状态。只读、无副作用，是启停与状态展示的共同底层。
 * 依赖 config 仅为 getStatus 顺带返回 hasConfig/hasKernel/kernelVersion（均为只读文件检查）。
 */

/** ps 查询超时：探测进程存活/属主/命令行的统一上限，卡住时按不存在处理 */
const PS_TIMEOUT_MS = 5000;

/**
 * 一次 ps 取一个 pid 的存活、属主、RSS 与命令行四个事实——存活/属主/命令行匹配/
 * 内存展示与逐 pid 清理都从这同一份结果派生，不再各发一次 ps（一次清理对每个 pid
 * 曾最多连发四次：uid 一次、存活一次、两条 needle 各一次）。
 *
 * 必须带 `-ww`：BSD/macOS 的 ps 即使 stdout 不是终端也会把 command 列截断到 79 列。
 * needle 是 binary 路径（偏移 0，截不掉），但命令行其余部分越过 79 列就会被截断，
 * `-ww` 不能去掉。
 * ps 失败或查不到统一为 NOT_RUNNING：存活、属主与命令行匹配的所有派生判定在查询
 * 失败时都取保守默认，与旧的四个独立函数一致。
 */
export interface ProbedProcess {
  alive: boolean;
  uid: string | null;
  rss: number | null;
  command: string;
}

const NOT_RUNNING: ProbedProcess = { alive: false, uid: null, rss: null, command: '' };

export function probeProcess(pid: number): ProbedProcess {
  if (!pid) return NOT_RUNNING;
  try {
    const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'pid=,uid=,rss=,command='], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
    });
    // command 自身含空格，只拆前三段（数字右对齐带前导空格，trim 后统一解析）
    const match = (result.stdout || '').trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return NOT_RUNNING;
    return { alive: true, uid: match[2], rss: Number.parseInt(match[3], 10), command: match[4] };
  } catch {
    return NOT_RUNNING;
  }
}

/** 命令行是否含任一内核二进制路径（服务走符号链、TUN 走真实文件，两种都要认） */
export function isProbedMihomo(p: ProbedProcess): boolean {
  return p.alive && (p.command.includes(PATHS.mihomoBinary) || p.command.includes(PATHS.serviceBinary));
}

/**
 * pgrep/pkill -f 用于识别「主实例」的正则:内核路径 + 主 configFile 两段拼接。
 * service(plist)、tun(脚本)两种启动的命令行都是 `<binary> -d <data> -f <configFile>`,
 * 均含这两段;而仅用编辑器打开配置文件的进程(命令行无 binary)不会命中,
 * 从而避免误杀/误判为残留。escapeRegExp 防止路径里的 `.` 当通配符。
 *
 * **内核路径必须匹配两种形式**:服务经符号链 `kernel/mihomo-service` 启动,
 * tun 经真实二进制 `kernel/mihomo` 启动,而进程命令行记录的是**启动时用的那个路径**——
 * 实测 `ps -ww -o command=` 对符号链启动的进程输出符号链名,用真实文件名 pgrep 匹配不到。
 * 只认一种会漏掉另一种:残留进程杀不掉、getMihomoPids 漏报、状态误判。
 *
 * **分组必须是 POSIX ERE 的 `(a|b)`,不能写 JS 的非捕获组 `(?:a|b)`**:pgrep/pkill 用
 * `regcomp(REG_EXTENDED)` 编译,ERE 里 `(` 后面紧跟 `?` 是「重复操作符缺少操作数」的语法错误。
 * 实测报 `Cannot compile regular expression ... (repetition-operator operand invalid)` 并以
 * **退出码 2** 结束——而 pgrep 无匹配也只是非 0,pkill 更是全程无副作用地返回,于是
 * `getMihomoPids()` 恒为空、`pkill -9 -f` 一个进程都不杀,`stop` 照常打印「已停止」。
 * 这正是「探测失败 ≠ 目标不存在」的典型案例。
 */
const BINARY_ALTERNATION = `(${escapeRegExp(PATHS.serviceBinary)}|${escapeRegExp(PATHS.mihomoBinary)})`;
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
  return isMihomoProcess(pid);
}

/**
 * 判定某 pid 是否仍是我们的内核进程（活着 + 命令行含任一二进制路径）。
 * kill 前的最后一道复核：探测（pgrep）到发信号之间隔着逐 pid 的 ps 查询，目标
 * 自行退出且 pid 被复用时，盲目 SIGKILL 会误杀无关进程——批量 pkill 分支在发信号
 * 前由 pkill 自身重估 pattern，逐 pid 分支此前没有等价防线（两侧安全性倒挂）。
 */
export function isMihomoProcess(pid: number): boolean {
  return isProbedMihomo(probeProcess(pid));
}

/**
 * 查询所有主实例 PID。
 *
 * **pgrep 的退出码 0/1 之外一律抛错,不能吞成空数组**:`2` 是正则编译失败、`3` 是 fatal error,
 * 两者都表示「这次探测根本没跑成」,而非「没有进程」。探测失败伪装成「不在运行」时，
 * stop 会认为无事可做、start 会认为没有残留，内核一直在跑而 CLI 全程报告成功。
 * 宁可报错让用户看见,也不能让探测失败伪装成「不在运行」。
 */
export function getMihomoPids(): number[] {
  const result = spawnSync('pgrep', ['-f', MAIN_INSTANCE_PATTERN], { encoding: 'utf8', timeout: 10_000 });

  // spawnSync 自身失败(ENOENT/超时): status 为 null。pgrep 不存在于 macOS 之外的环境时不该崩,
  // 但也不能假装「没有进程」——同样归入探测失败
  if (result.error || result.status === null) {
    throw new CliError('无法探测内核进程（pgrep 执行失败）', {
      hint: ['这不代表内核未运行，只表示查不到。', '请手动确认: pgrep -fl mihomo-cli'],
    });
  }

  if (result.status !== 0 && result.status !== 1) {
    throw new CliError(`进程探测失败（pgrep 退出码 ${result.status}）`, {
      hint: [(result.stderr || '').trim(), '', '这是 CLI 的缺陷，请反馈。手动确认内核状态: pgrep -fl mihomo-cli'].filter(Boolean),
    });
  }

  return parsePidList(result.stdout);
}

/**
 * 解析「每行一个 pid」的命令输出（pgrep -f 与 lsof -t 同形态）：空白行/非数字/
 * 非正整数一律滤掉。两个探测出口共用这一份解析口径
 */
export function parsePidList(stdout: string): number[] {
  const output = stdout.trim();
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map(p => parseInt(p, 10))
    .filter(p => Number.isInteger(p) && p > 0);
}

function isPidFileOwnedByRoot(): boolean {
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
  return {
    needsCleanup: allPids.length > 0 || isPidFileOwnedByRoot(),
    allPids,
  };
}

export function getStatus(): ProcessStatus {
  const pid = getPid();
  if (!pid) return { running: false, pid: null, processInfo: null };

  // 存活判定与内存/属主同源一次 ps：旧实现先 isMihomoProcess（最多三次 ps）再
  // getProcessInfo（又一次），同一拍四个查询；probe 不匹配（PID 被复用/已退出）
  // 即未运行，不附带信息
  const p = probeProcess(pid);
  if (!isProbedMihomo(p)) return { running: false, pid: null, processInfo: null };

  return {
    running: true,
    pid,
    processInfo: {
      pid,
      memory: p.rss ? `${(p.rss / 1024).toFixed(1)} MB` : '未知',
      isRoot: p.uid === '0',
    },
  };
}
