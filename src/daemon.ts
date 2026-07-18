import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { LAUNCH_AGENT_LABEL } from './constants.js';
import { atomicWriteFileSync, DIRS, PATHS } from './paths.js';
import { cleanupAll, getAllMihomoPids } from './process.js';
import type { DaemonStatus } from './types.js';

const LAUNCHCTL_TIMEOUT_MS = 10_000;

interface LaunchctlResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function launchctl(args: string[]): LaunchctlResult {
  const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: LAUNCHCTL_TIMEOUT_MS });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/** 获取当前用户 UID。launchd 用户域为 gui/<uid>，仅 macOS/Unix 提供 process.getuid。 */
function getUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('无法获取用户 UID，保活功能仅支持 macOS');
  }
  return uid;
}

function guiDomain(uid: number): string {
  return `gui/${uid}`;
}

function serviceTarget(uid: number): string {
  return `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
}

function launchctlError(action: string, result: LaunchctlResult): Error {
  const detail = (result.stderr || result.stdout || '').trim() || `退出码 ${result.status}`;
  return new Error(`launchctl ${action} 失败: ${detail}`);
}

/** XML 文本节点转义，防御主目录/数据目录路径中出现 & < > 等字符。 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 生成 LaunchAgent plist。
 * ProgramArguments 与 startMixedMode 的 spawn 参数保持一致（process.ts）。
 * KeepAlive: 崩溃/被杀后由 launchd 拉起；RunAtLoad: 登录/开机自启。
 * 日志复用 mihomo.log，与 log/logs 命令无缝衔接。
 */
function buildPlist(): string {
  const programArguments = [PATHS.mihomoBinary, '-d', DIRS.data, '-f', PATHS.configFile];
  const argsXml = programArguments.map(a => `    <string>${escapeXml(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCH_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(PATHS.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(PATHS.logFile)}</string>
  <key>WorkingDirectory</key>
  <string>/tmp</string>
</dict>
</plist>
`;
}

/** 保活是否已启用（以 plist 文件是否存在为准）。 */
export function isDaemonEnabled(): boolean {
  return fs.existsSync(PATHS.launchAgentPlist);
}

/** 查询保活状态：plist 存在性 + launchd 装载状态 + 托管进程 PID。 */
export function getDaemonStatus(): DaemonStatus {
  if (!isDaemonEnabled()) {
    return { enabled: false, loaded: false, pid: null };
  }

  const uid = process.getuid?.();
  if (uid === undefined) {
    // 降级：无法查询 launchctl，用进程列表兜底
    const pids = getAllMihomoPids();
    return { enabled: true, loaded: pids.length > 0, pid: pids[0] ?? null };
  }

  const result = launchctl(['print', serviceTarget(uid)]);
  if (result.status !== 0) {
    // plist 在但未装载（如手动 bootout 后未删 plist）
    return { enabled: true, loaded: false, pid: null };
  }

  const pidMatch = result.stdout.match(/\bpid = (\d+)/);
  const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
  return { enabled: true, loaded: true, pid };
}

/** 保活托管的内核是否真在运行：已装载且有活动 PID。统一"运行中"的判定口径。 */
export function isDaemonRunning(status: DaemonStatus): boolean {
  return status.loaded && status.pid !== null;
}

/**
 * 启用保活：生成 plist 并装载。
 * 前置：内核与运行时配置须已就绪（由调用方负责生成 config.yaml）。
 */
export function enableDaemon(): void {
  if (!fs.existsSync(PATHS.mihomoBinary)) {
    throw new Error('未找到 mihomo 内核，请先下载内核');
  }
  if (!fs.existsSync(PATHS.configFile)) {
    throw new Error('未找到运行时配置，请先添加订阅');
  }

  const uid = getUid();

  // 顺序关键：必须先 bootout 卸载可能存在的旧任务（使 KeepAlive 失效），
  // 再 cleanupAll 清理残留进程——否则被 pkill 的托管进程会被 KeepAlive 立即拉起，清理形同虚设。
  // 未装载时 bootout 报错，忽略即可（幂等）。
  launchctl(['bootout', serviceTarget(uid)]);

  // 清理可能残留的手动启动进程，避免与 launchd 托管实例端口冲突
  cleanupAll();

  fs.mkdirSync(path.dirname(PATHS.launchAgentPlist), { recursive: true });
  atomicWriteFileSync(PATHS.launchAgentPlist, buildPlist(), { mode: 0o600 });

  const result = launchctl(['bootstrap', guiDomain(uid), PATHS.launchAgentPlist]);
  if (result.status !== 0) {
    // 装载失败：先 bootout 兜底（防 bootstrap 部分注册了服务导致孤儿），再删 plist 回滚，
    // 避免留下 CLI 无法清除的半启用状态
    launchctl(['bootout', serviceTarget(uid)]);
    try {
      fs.unlinkSync(PATHS.launchAgentPlist);
    } catch {
      /* ignore */
    }
    throw launchctlError('bootstrap', result);
  }
}

/** 停用保活：卸载任务、删除 plist。bootout 会终止托管的内核进程（KeepAlive 随之失效）。 */
export function disableDaemon(): void {
  const uid = process.getuid?.();
  if (uid !== undefined) {
    // bootout 后 KeepAlive 失效，launchd 会终止其托管的内核进程；
    // 不额外 cleanupAll——那会按二进制路径误杀用户手动 start 的非保活实例。
    launchctl(['bootout', serviceTarget(uid)]);
  }

  try {
    fs.unlinkSync(PATHS.launchAgentPlist);
  } catch {
    /* ignore */
  }
}

/**
 * 重启托管内核（配置变更后使更改生效）。
 * kickstart -k = 先 kill 再重启，是命令式重启，launchd 内部协调，不与 KeepAlive 冲突。
 * 若任务未装载（plist 在但被手动 bootout / 上次 bootstrap 残留），自动重新 bootstrap 以自愈，
 * 而非直接失败——保证 start/clean/sub use 等重启路径在"半启用"状态下仍能恢复。
 */
export function restartDaemon(): void {
  const uid = getUid();

  // plist 缺失说明保活并未真正启用，调用方不应到达这里
  if (!fs.existsSync(PATHS.launchAgentPlist)) {
    throw new Error('保活未启用，无法重启');
  }

  // 任务已装载：kickstart -k 命令式重启
  if (launchctl(['print', serviceTarget(uid)]).status === 0) {
    const result = launchctl(['kickstart', '-k', serviceTarget(uid)]);
    if (result.status !== 0) {
      throw launchctlError('kickstart', result);
    }
    return;
  }

  // 任务未装载：重新 bootstrap 自愈（plist 已在，直接用它装载）
  const result = launchctl(['bootstrap', guiDomain(uid), PATHS.launchAgentPlist]);
  if (result.status !== 0) {
    throw launchctlError('bootstrap', result);
  }
}
