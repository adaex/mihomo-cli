import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { DIRS, ensureDirs, PATHS, rmrf } from './paths.js';
import { getMihomoPids, isPidFileOwnedByRoot, isProcessRoot, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import type { CleanupResult, StopResult } from './types.js';
import { sleep } from './utils.js';

/**
 * 内核进程的停止与残留清理。与启动（process-start.ts）分家：
 * stop 被 start/stop/reset 三处调用，cleanupAll 还被 start 复用，
 * 合在一起会让「停」依赖「启」的全部家当。
 *
 * 「等进程退出」的轮询用 async 的 `sleep` 而非 `sleepSync`：后者是 `Atomics.wait`，
 * 会阻塞整个事件循环，**期间 SIGINT 完全不被处理**（实测 50×100ms 的忙等要等循环
 * 全部走完、5.3 秒后才响应 Ctrl+C）。用户在 `mihomo stop` 卡住时按 Ctrl+C 会以为
 * CLI 挂死。改 async 后信号在下一个 await 间隙即可送达。
 * （`withFileLock` 里的忙等是另一回事，那里必须同步——持锁期间让出事件循环，
 * 慢速网络下另一进程会等到强夺陈旧锁，等于没锁。）
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

/** 清理 pid 文件。root 属主（TUN 残留）走 sudo 删除，普通用户态直接 unlink。 */
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

/**
 * 批量终止内核。**返回值是「pkill 真的跑成功了」，不是「调用没抛异常」**。
 *
 * 早先无条件 `return true`，于是 pkill 因 pattern 编译失败退 2 时（v4.2.1 那个 bug），
 * `cleanupAll` 照样把 `killedCount` 记成全部、`stop` 照样打印「已停止」。
 * pkill 的退出码：0 = 有匹配且已发信号，1 = 无匹配（此时本就无事可做，算成功），
 * 2 = 语法/正则错误，3 = 内部错误——后两者是「这次调用根本没执行」，必须报 false。
 *
 * 注意 sudo 分支：退出码 1 在这里有歧义（sudo 鉴权失败也是 1），但 pkill 无匹配同样是 1，
 * 两者都不该让调用方误以为杀干净了。真正的把关在调用方——`cleanupAll` 之后会重新
 * `getMihomoPids()` 复核，本函数的返回值只用于统计。
 */
function killAllMihomo(forceSudo = false): boolean {
  const pattern = MAIN_INSTANCE_PATTERN;
  const argv: [string, string[]] = forceSudo ? ['sudo', ['pkill', '-9', '-f', pattern]] : ['pkill', ['-9', '-f', pattern]];
  const options = forceSudo ? { stdio: 'inherit' as const, timeout: 15_000 } : { timeout: 10_000 };

  try {
    const result = spawnSync(argv[0], argv[1], options);
    if (result.error) return false;
    // 0 = 已发信号，1 = 无匹配（无事可做）；2/3 = pkill 自身出错，没有任何进程被处理
    return result.status === 0 || result.status === 1;
  } catch {
    return false;
  }
}

export async function cleanupAll(forceSudo = false): Promise<CleanupResult> {
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
      // 与 sudo 分支同构：批量 pkill 失败时不能照记 killedCount。
      // 早先无视返回值直接记全部，pkill 编译失败（退 2）时统计与事实完全相反
      if (killAllMihomo(false)) {
        killedCount = pids.length;
      } else {
        failedPids.push(...pids);
      }
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
    await sleep(PROCESS_WAIT_INTERVAL);
  }

  clearPid();

  return { killed: killedCount, failed: failedPids.length, remaining: getMihomoPids() };
}

export async function stop(forceSudo = false): Promise<StopResult> {
  const allPids = getMihomoPids();
  if (allPids.length === 0) {
    clearPid();
    clearRuntime();
    return { success: true, notRunning: true };
  }

  const result = await cleanupAll(forceSudo);

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
