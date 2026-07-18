import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getKernelVersion, hasConfig, hasKernel } from './config.js';
import { DIRS, ensureDirs, PATHS, rmrf } from './paths.js';
import type { CleanupResult, LogList, ProcessInfo, ProcessStatus, StaleState, StartResult, StopResult } from './types.js';
import { isProcessRoot, isProcessRunning, sleepSync } from './utils.js';

export const PROCESS_WAIT_ATTEMPTS = 50;
export const PROCESS_WAIT_INTERVAL = 100;
const STARTUP_WAIT_MS = 800;
const SUDO_TIMEOUT_MS = 60_000;
const TUN_MODE_POST_WAIT_MS = 500;
const BATCH_KILL_THRESHOLD = 3;
const DEFAULT_LOG_RETENTION_DAYS = 7;

/**
 * 将路径转义为 pgrep/pkill -f 使用的正则字面量。
 * 否则路径中的 `.`（如 ~/.mihomo-cli）会被当作正则通配符，可能误匹配其他进程。
 */
function escapeForPgrep(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clearRuntime(): void {
  if (fs.existsSync(DIRS.runtime)) {
    rmrf(DIRS.runtime);
  }
  ensureDirs();
}

function getPid(): number | null {
  if (!fs.existsSync(PATHS.pidFile)) return null;
  try {
    const pid = parseInt(fs.readFileSync(PATHS.pidFile, 'utf8').trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(): boolean {
  const pid = getPid();
  return pid ? isProcessRunning(pid) : false;
}

export function getAllMihomoPids(): number[] {
  const binaryPath = PATHS.mihomoBinary;
  try {
    const result = spawnSync('pgrep', ['-f', escapeForPgrep(binaryPath)], { encoding: 'utf8', timeout: 10_000 });
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

function isPidFileOwnedByRoot(): boolean {
  if (!fs.existsSync(PATHS.pidFile)) return false;
  try {
    const stat = fs.statSync(PATHS.pidFile);
    return stat.uid === 0;
  } catch {
    return false;
  }
}

function checkStaleState(): StaleState {
  const allPids = getAllMihomoPids();
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

function savePid(pid: number): void {
  ensureDirs();
  fs.writeFileSync(PATHS.pidFile, pid.toString(), { mode: 0o600 });
}

function clearPid(): void {
  if (!fs.existsSync(PATHS.pidFile)) return;
  if (isPidFileOwnedByRoot()) {
    try {
      spawnSync('sudo', ['rm', '-f', PATHS.pidFile], { stdio: 'inherit', timeout: 10_000 });
    } catch {
      // ignore
    }
  } else {
    try {
      fs.unlinkSync(PATHS.pidFile);
    } catch {
      /* ignore */
    }
  }
}

function killProcess(pid: number, needsSudo = false): boolean {
  try {
    if (needsSudo) {
      const result = spawnSync('sudo', ['kill', '-9', String(pid)], { stdio: 'inherit', timeout: 10_000 });
      if (result.status === 0) {
        return true;
      }
      try {
        process.kill(pid, 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    } else {
      process.kill(pid, 'SIGKILL');
      return true;
    }
  } catch {
    return false;
  }
}

function killAllMihomo(forceSudo = false): boolean {
  const pattern = escapeForPgrep(PATHS.mihomoBinary);
  if (forceSudo) {
    try {
      spawnSync('sudo', ['pkill', '-9', '-f', pattern], { stdio: 'inherit', timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  } else {
    try {
      spawnSync('pkill', ['-9', '-f', pattern], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
}

export function cleanupAll(forceSudo = false): CleanupResult {
  const pids = getAllMihomoPids();
  if (pids.length === 0) {
    clearPid();
    return { killed: 0, failed: 0, remaining: [] };
  }

  const hasRootProcess = pids.some(p => isProcessRoot(p));
  const needsSudo = forceSudo || hasRootProcess;

  let killedCount = 0;
  const failedPids: number[] = [];

  if (needsSudo) {
    const success = killAllMihomo(true);
    if (success) {
      killedCount = pids.length;
    } else {
      failedPids.push(...pids);
    }
  } else {
    if (pids.length > BATCH_KILL_THRESHOLD) {
      killAllMihomo(false);
      killedCount = pids.length;
    } else {
      for (const pid of pids) {
        if (killProcess(pid, false)) {
          killedCount++;
        } else {
          failedPids.push(pid);
        }
      }
    }
  }

  for (let i = 0; i < PROCESS_WAIT_ATTEMPTS; i++) {
    if (getAllMihomoPids().length === 0) break;
    sleepSync(PROCESS_WAIT_INTERVAL);
  }

  clearPid();

  return { killed: killedCount, failed: failedPids.length, remaining: getAllMihomoPids() };
}

function createTunLaunchScript(): string {
  const binary = PATHS.mihomoBinary;
  const configFile = PATHS.configFile;
  const logFile = PATHS.logFile;
  const pidFile = PATHS.pidFile;
  const dataDir = DIRS.data;
  const killPattern = escapeForPgrep(binary);

  const scriptContent =
    '#!/bin/bash\n' +
    `BINARY="${binary}"\n` +
    `CONFIG_FILE="${configFile}"\n` +
    `LOG_FILE="${logFile}"\n` +
    `PID_FILE="${pidFile}"\n` +
    `DATA_DIR="${dataDir}"\n` +
    `KILL_PATTERN='${killPattern}'\n` +
    '\n' +
    '# 终止旧进程\n' +
    'pkill -9 -f "${KILL_PATTERN}" 2>/dev/null || true\n' +
    'sleep 0.2\n' +
    'rm -f "${PID_FILE}" 2>/dev/null || true\n' +
    '\n' +
    '# 写入启动标记\n' +
    'echo "=== TUN 启动: $(date) ===" >> "${LOG_FILE}"\n' +
    '\n' +
    '# 启动\n' +
    'cd /tmp\n' +
    '"${BINARY}" -d "${DATA_DIR}" -f "${CONFIG_FILE}" >> "${LOG_FILE}" 2>&1 &\n' +
    'NEW_PID=$!\n' +
    'echo ${NEW_PID} > "${PID_FILE}"\n' +
    '\n' +
    '# 验证\n' +
    'for i in 1 2 3 4 5; do\n' +
    '  sleep 0.4\n' +
    '  if kill -0 ${NEW_PID} 2>/dev/null; then\n' +
    '    exit 0\n' +
    '  fi\n' +
    'done\n' +
    '\n' +
    '# 失败，显示日志\n' +
    'echo "TUN 启动失败"\n' +
    'echo ""\n' +
    'echo "--- 日志 ---"\n' +
    'tail -25 "${LOG_FILE}" 2>/dev/null\n' +
    'exit 1\n';

  const scriptPath = path.join(DIRS.runtime, 'launch-tun.sh');
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o700 });
  return scriptPath;
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
  const allPids = getAllMihomoPids();

  return {
    running,
    pid: running ? pid : null,
    processInfo: running && pid ? getProcessInfo(pid) : null,
    hasConfig: hasConfig(),
    hasKernel: hasKernel(),
    kernelVersion: getKernelVersion(),
    allProcesses: allPids,
    hasStaleProcesses: allPids.length > (running ? 1 : 0),
  };
}

export async function start(mode = 'mixed'): Promise<StartResult> {
  const isTunMode = mode === 'tun';

  ensureDirs();
  rotateAndCleanupLogs();

  const binary = PATHS.mihomoBinary;
  if (!fs.existsSync(binary)) {
    throw new Error('未找到 mihomo 内核，请先下载内核');
  }

  const configFile = PATHS.configFile;
  if (!fs.existsSync(configFile)) {
    throw new Error('未找到配置文件，请先添加订阅并启动');
  }

  const staleState = checkStaleState();

  if (isTunMode) {
    return startTunMode(staleState);
  }
  return startMixedMode(staleState);
}

async function startMixedMode(staleState: StaleState): Promise<StartResult> {
  if (staleState.needsCleanup) {
    if (staleState.needsSudo) {
      console.log('\n发现需要 root 权限清理的残留进程/文件');
      console.log('请先手动清理: sudo pkill -9 mihomo');
      console.log('或者切换到 TUN 模式，启动时会自动清理');
      throw new Error('存在需要 root 权限清理的残留');
    }

    const cleanupResult = cleanupAll();
    if (cleanupResult.killed > 0) {
      console.log(`清理了 ${cleanupResult.killed} 个残留进程`);
    }
  }

  if (isRunning()) {
    const pid = getPid() as number;
    return { success: true, pid, alreadyRunning: true };
  }

  const configFile = PATHS.configFile;
  const logFile = PATHS.logFile;
  const args = ['-d', DIRS.data, '-f', configFile];

  const logFd = fs.openSync(logFile, 'a');

  const child = spawn(PATHS.mihomoBinary, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  fs.closeSync(logFd);

  child.unref();

  const pid = child.pid as number;
  savePid(pid);

  await new Promise(resolve => setTimeout(resolve, STARTUP_WAIT_MS));

  if (!isRunning()) {
    clearPid();
    let errorMsg = '启动失败';
    if (fs.existsSync(logFile)) {
      try {
        const logs = fs.readFileSync(logFile, 'utf8').slice(-3000);
        if (logs.trim()) {
          errorMsg +=
            '\n最近的日志:\n' +
            logs
              .split('\n')
              .map(l => `  ${l}`)
              .join('\n');
        }
      } catch {
        /* ignore */
      }
    }
    throw new Error(errorMsg);
  }

  return { success: true, pid, mode: 'mixed' };
}

async function startTunMode(staleState: StaleState): Promise<StartResult> {
  const launchScript = createTunLaunchScript();

  if (staleState.needsCleanup) {
    console.log(`清理 ${staleState.allPids.length} 个残留进程...`);
  }
  console.log('TUN 模式需要 sudo 权限...');

  try {
    const result = spawnSync('sudo', [launchScript], { stdio: 'inherit', timeout: SUDO_TIMEOUT_MS });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const err = new Error('TUN 启动脚本执行失败') as Error & { status?: number };
      err.status = result.status ?? undefined;
      throw err;
    }
  } catch (e) {
    try {
      fs.unlinkSync(launchScript);
    } catch {
      /* ignore */
    }
    if ((e as { status?: number }).status === 1) {
      throw new Error('密码错误或取消');
    }
    throw new Error((e as Error).message);
  }

  try {
    fs.unlinkSync(launchScript);
  } catch {
    /* ignore */
  }

  await new Promise(resolve => setTimeout(resolve, TUN_MODE_POST_WAIT_MS));

  const finalPid = getPid();
  if (!finalPid) {
    throw new Error('TUN 启动失败');
  }

  return { success: true, pid: finalPid, mode: 'tun' };
}

export function stop(forceSudo = false): StopResult {
  const allPids = getAllMihomoPids();
  if (allPids.length === 0) {
    clearPid();
    clearRuntime();
    return { success: true, notRunning: true };
  }

  const result = cleanupAll(forceSudo);

  const remaining = getAllMihomoPids();
  if (remaining.length > 0) {
    console.log('');
    console.log('仍有进程残留，需要手动清理:');
    console.log(`进程 PID: ${remaining.join(', ')}`);
    console.log('手动命令: sudo pkill -9 mihomo');
    console.log('');
    return { success: true, warning: '部分进程未终止', remaining };
  }

  clearRuntime();
  return { success: true, killed: result.killed };
}

// === Log management ===

function rotateAndCleanupLogs(): void {
  rotateLog();
  cleanupOldLogs(DEFAULT_LOG_RETENTION_DAYS);
}

export function getLogPath(): string {
  return PATHS.logFile;
}

function rotateLog(): string | null {
  const logFile = PATHS.logFile;
  if (!fs.existsSync(logFile)) return null;

  const stat = fs.statSync(logFile);
  if (stat.size === 0) return null;

  const timestamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '');
  const rotatedName = `mihomo.${timestamp}.log`;
  const rotatedPath = path.join(DIRS.logs, rotatedName);

  fs.renameSync(logFile, rotatedPath);
  return rotatedPath;
}

function cleanupOldLogs(maxAgeDays = DEFAULT_LOG_RETENTION_DAYS): { deleted: number; errors: number } {
  const logsDir = DIRS.logs;
  if (!fs.existsSync(logsDir)) return { deleted: 0, errors: 0 };

  const files = fs.readdirSync(logsDir);
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  let deleted = 0;
  let errors = 0;

  for (const file of files) {
    if (!file.match(/^mihomo\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/)) continue;

    try {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {
      errors++;
    }
  }

  return { deleted, errors };
}

export function listLogs(): LogList {
  const logsDir = DIRS.logs;
  const result: LogList = { current: null, archives: [] };

  if (fs.existsSync(PATHS.logFile)) {
    const stat = fs.statSync(PATHS.logFile);
    result.current = {
      name: 'mihomo.log (当前)',
      path: PATHS.logFile,
      size: stat.size,
      mtime: stat.mtime,
      isCurrent: true,
    };
  }

  if (!fs.existsSync(logsDir)) return result;

  const files = fs.readdirSync(logsDir);
  for (const file of files) {
    const match = file.match(/^mihomo\.(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.log$/);
    if (!match) continue;

    try {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      result.archives.push({
        name: file,
        path: filePath,
        size: stat.size,
        mtime: stat.mtime,
        isCurrent: false,
      });
    } catch {
      // ignore
    }
  }

  result.archives.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return result;
}

function isPathUnderDir(filePath: string, baseDir: string): boolean {
  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedPath === resolvedBase || resolvedPath.startsWith(resolvedBase + path.sep);
}

export function getLogPathByName(name: string): string | null {
  const logsDir = DIRS.logs;

  let targetName = name;
  if (!name.endsWith('.log')) targetName = `mihomo.${name}.log`;
  if (!targetName.startsWith('mihomo.')) targetName = `mihomo.${targetName}`;

  const filePath = path.join(logsDir, targetName);
  if (fs.existsSync(filePath) && isPathUnderDir(filePath, logsDir)) return filePath;

  if (fs.existsSync(logsDir)) {
    const files = fs.readdirSync(logsDir);
    for (const file of files) {
      if (file.includes(name)) {
        const candidatePath = path.join(logsDir, file);
        if (isPathUnderDir(candidatePath, logsDir)) return candidatePath;
      }
    }
  }

  return null;
}

export function openUrl(url: string): boolean {
  try {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true });
    child.unref();
    child.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}

export function openLogFile(logPath: string, label?: string): void {
  const displayLabel = label || logPath;
  console.log(`用系统默认程序打开: ${displayLabel}`);
  const success = openUrl(logPath);
  if (!success) {
    console.log(`请手动打开: ${logPath}`);
  }
}

export function viewLogWithTail(logPath: string, options?: { follow?: boolean; lines?: number }): void {
  const follow = options?.follow;
  const lines = options?.lines || 100;

  console.log(`日志: ${logPath}`);
  if (follow) {
    console.log('按 Ctrl+C 退出\n');
  } else {
    console.log(`显示最后 ${lines} 行\n`);
  }

  const tailArgs: string[] = [];
  if (follow) tailArgs.push('-f');
  tailArgs.push('-n', lines.toString());
  tailArgs.push(logPath);

  const tail = spawn('tail', tailArgs, { stdio: 'inherit' });

  tail.on('close', () => process.exit(0));
  tail.on('error', e => {
    console.error(`无法读取日志: ${e.message}`);
    process.exit(1);
  });
}
