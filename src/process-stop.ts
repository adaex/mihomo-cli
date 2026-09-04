import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { DIRS, ensureDirs, PATHS, rmrf } from './paths.js';
import { getMihomoPids, isPidFileOwnedByRoot, isProcessRoot, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import type { CleanupResult, StopResult } from './types.js';
import { sleepSync } from './utils.js';

/**
 * 内核进程的停止与残留清理。与启动（process-start.ts）分家：
 * stop 被 start/stop/reset 三处调用，cleanupAll 还被 start 复用，
 * 合在一起会让「停」依赖「启」的全部家当。
 */

export const PROCESS_WAIT_ATTEMPTS = 50;
export const PROCESS_WAIT_INTERVAL = 100;

const BATCH_KILL_THRESHOLD = 3;

function clearRuntime(): void {
  if (fs.existsSync(DIRS.runtime)) {
    rmrf(DIRS.runtime);
  }
  ensureDirs();
}

/** 清理 pid 文件。root 属主（TUN/daemon 残留）走 sudo 删除，普通用户态直接 unlink。 */
export function clearPid(): void {
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

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function killAllMihomo(forceSudo = false): boolean {
  const pattern = MAIN_INSTANCE_PATTERN;
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
  const pids = getMihomoPids();
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
        if (killProcess(pid)) {
          killedCount++;
        } else {
          failedPids.push(pid);
        }
      }
    }
  }

  for (let i = 0; i < PROCESS_WAIT_ATTEMPTS; i++) {
    if (getMihomoPids().length === 0) break;
    sleepSync(PROCESS_WAIT_INTERVAL);
  }

  clearPid();

  return { killed: killedCount, failed: failedPids.length, remaining: getMihomoPids() };
}

export function stop(forceSudo = false): StopResult {
  const allPids = getMihomoPids();
  if (allPids.length === 0) {
    clearPid();
    clearRuntime();
    return { success: true, notRunning: true };
  }

  const result = cleanupAll(forceSudo);

  const remaining = getMihomoPids();
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
