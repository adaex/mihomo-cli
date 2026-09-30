import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { colors } from './colors.js';
import { DIRS, ensureDirs, PATHS, rmrf } from './paths.js';
import { getMihomoPids, isMihomoProcess, isPidFileOwnedByRoot, isProcessRoot, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import { runSudoScript, SUDO_TIMEOUT_MS, SudoAuthError } from './sudo.js';
import { shellQuote } from './text.js';
import type { CleanupResult, StopResult } from './types.js';
import { sleep } from './utils.js';

/**
 * 内核进程的停止与残留清理。与启动（process-start.ts）分家：
 * 游离内核的 stop()、服务路径（service.ts）的残留收口、reset 的停机清理
 * 都走本文件唯一的 cleanupAll，不再各维护一份杀进程实现。
 *
 * 「等进程退出」的轮询用 async 的 `sleep` 而非 `sleepSync`：后者是 `Atomics.wait`，
 * 会阻塞整个事件循环，**期间 SIGINT 完全不被处理**（实测 50×100ms 的忙等要等循环
 * 全部走完、5.3 秒后才响应 Ctrl+C）。用户在 `mihomo stop` 卡住时按 Ctrl+C 会以为
 * CLI 挂死。改 async 后信号在下一个 await 间隙即可送达。
 * （`withFileLock` 里的忙等是另一回事，那里必须同步——持锁期间让出事件循环，
 * 慢速网络下另一进程会等到强夺陈旧锁，等于没锁。）
 */

const PROCESS_WAIT_ATTEMPTS = 50;
const PROCESS_WAIT_INTERVAL = 100;

const BATCH_KILL_THRESHOLD = 3;

function clearRuntime(): void {
  if (fs.existsSync(DIRS.runtime)) {
    rmrf(DIRS.runtime);
  }
  ensureDirs();
}

/** 无 pid 文件/普通用户态删除成功；'cancelled' = sudo 退出码 1（取消或密码错误）；'failed' = 其余失败 */
type PidCleanupOutcome = 'cancelled' | 'failed' | null;

/**
 * pid 文件清理失败的可见警告（进程已不在时的唯一出口）。旧 clearPid 内部自行
 * console.warn；改为返回结果后由调用方决定语气——游离 stop 与服务路径都要让用户
 * 知道文件还在、下次会再试，不能静默
 */
function warnPidCleanupFailed(outcome: PidCleanupOutcome | Error | null): void {
  if (outcome === null) return;
  const cancelled = outcome === 'cancelled' || outcome instanceof SudoAuthError;
  const reason = cancelled ? 'sudo 取消或密码错误' : 'sudo 执行失败';
  console.warn(colors.yellow(`警告: root 属主的 pid 文件未能清理（${reason}），下次 stop 会再次尝试`));
}

/** clearPid 的结果转错误对象（与 sudo 脚本路径的错误同形态，供 cleanupAll 统一带出） */
function pidCleanupError(outcome: PidCleanupOutcome): Error | null {
  if (outcome === 'cancelled') return new SudoAuthError();
  if (outcome === 'failed') return new Error('删除 root 属主的 pid 文件失败');
  return null;
}

/** 清理 pid 文件。root 属主（TUN 残留）走 sudo 删除，普通用户态直接 unlink。 */
export function clearPid(): PidCleanupOutcome {
  if (!fs.existsSync(PATHS.pidFile)) return null;
  if (isPidFileOwnedByRoot()) {
    // sudo 分支引用 SUDO_TIMEOUT_MS（与 runSudoScript 同一常量，不自抄一份）：
    // spawnSync 超时会把密码提示连同 sudo+rm 一起杀掉，超时不抛异常
    // （只置 error/signal），失败结果必须显式检查，不能只 try/catch 同步异常
    const result = spawnSync('sudo', ['rm', '-f', PATHS.pidFile], { stdio: 'inherit', timeout: SUDO_TIMEOUT_MS });
    if (result.status === 1) return 'cancelled';
    if (result.error || result.status !== 0) return 'failed';
    return null;
  }
  try {
    fs.unlinkSync(PATHS.pidFile);
  } catch {
    /* ignore */
  }
  return null;
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
 * 批量终止**用户态**内核。**返回值是「pkill 真的跑成功了」，不是「调用没抛异常」**。
 *
 * pkill 的退出码：0 = 有匹配且已发信号，1 = 无匹配（此时本就无事可做，算成功），
 * 2 = 语法/正则错误，3 = 内部错误——后两者是「这次调用根本没执行」，必须报 false，
 * 否则 pattern 编译失败时调用方照样把 killedCount 记成全部、stop 照样打印「已停止」。
 * root 属主进程不走这里（见 buildKernelCleanupScript 的 sudo 路径）。
 */
function killAllMihomo(): boolean {
  try {
    const result = spawnSync('pkill', ['-9', '-f', MAIN_INSTANCE_PATTERN], { timeout: 10_000 });
    if (result.error) return false;
    // 0 = 已发信号，1 = 无匹配（无事可做）；2/3 = pkill 自身出错，没有任何进程被处理
    return result.status === 0 || result.status === 1;
  } catch {
    return false;
  }
}

/**
 * root 残留（TUN 内核、旧系统级服务）的一次性清理脚本：sudo 内完成
 * pkill + rm pid 文件，**只弹一次密码**。pkill 的 pattern 匹配所有主实例
 * （含用户态进程），故调用方只要发现 root 残留即可整体交给本脚本。
 * 退出码协议与 legacy 清理脚本同款：2 = 脚本内真实失败，1 留给 sudo 鉴权取消。
 */
export function buildKernelCleanupScript(): string {
  return [
    '#!/bin/bash',
    // pkill 退出码 2/3 是 pattern 编译失败等探测性错误，不能当「没有进程」吞掉
    `pkill -9 -f ${shellQuote(MAIN_INSTANCE_PATTERN)} 2>/dev/null`,
    'rc=$?',
    '[ $rc -le 1 ] || exit 2',
    `rm -f ${shellQuote(PATHS.pidFile)} 2>/dev/null || true`,
    'exit 0',
    '',
  ].join('\n');
}

/**
 * 清理全部主实例内核并等待死亡，是所有停止/卸载/重置路径的唯一入口。
 *
 * - 零进程：直接返回，**不碰 pid 文件**——root 属主的文件要弹密码，而没有任何
 *   进程读它，为无害残留提权不值得（服务路径的 stop/uninstall 旧语义即不动它）。
 *   游离 stop 的零进程分支自行调用 clearPid，那里的提权是既有行为
 * - 无 root 进程：≤3 个逐 pid 复核命令行后 SIGKILL（防 pid 复用误杀），更多走批量 pkill
 * - 有 root 进程：一次 sudo 脚本（pkill + rm pid）；sudo 非 TTY/取消/失败不抛，
 *   经返回值的 scriptError/pidError 与 remaining 交给调用方按各自语境包装
 * - 发信号后**轮询等待死亡**（最多 5s）再复核 pgrep：root 进程被信号终止后由
 *   launchd 收养/收割，立即复核可能仍列到濒死 pid，误报「部分进程未终止」
 */
export async function cleanupAll(): Promise<CleanupResult> {
  const pids = getMihomoPids();
  if (pids.length === 0) {
    return { killed: 0, failed: 0, remaining: [], scriptError: null, pidError: null };
  }

  let killedCount = 0;
  const failedPids: number[] = [];
  let scriptError: Error | null = null;

  const rootPids = pids.filter(isProcessRoot);
  if (rootPids.length > 0) {
    // root 属主进程用户态 kill 不掉；sudo 脚本的 pkill 同时覆盖用户态主实例，
    // 故不再分别处理。先给一句人话预告再弹英文 Password:，与 TUN/legacy 路径同款；
    // 预告只列 root 属主的 PID（sudo 的动因），用户态游离内核混在其中时全列会失实
    console.log(`检测到 root 属主的内核残留（PID ${rootPids.join(', ')}），清理需要一次管理员密码`);
    try {
      runSudoScript(buildKernelCleanupScript(), {
        action: '清理残留进程',
        file: 'cleanup-residue.sh',
        codeMessages: { 2: '终止残留内核失败（pkill 退出码异常）' },
      });
      killedCount = pids.length;
    } catch (e) {
      // 取消/密码错误（SudoAuthError）与脚本失败都不抛：remaining 复核与本字段
      // 交给调用方按各自语境包装（stop 报残留、服务路径报「已取消」）
      scriptError = e as Error;
    }
  } else if (pids.length > BATCH_KILL_THRESHOLD) {
    // 批量 pkill 失败（退 2/3）时不能照记 killedCount，由调用方按 remaining 复核
    if (killAllMihomo()) {
      killedCount = pids.length;
    } else {
      failedPids.push(...pids);
    }
  } else {
    for (const pid of pids) {
      // 发信号前复核命令行：pgrep 探测到此刻隔着逐 pid 的 ps（isProcessRoot），
      // 目标自行退出且 pid 被复用的话，盲目 SIGKILL 会误杀无关进程——
      // 复核不匹配按「无事可做」计成功（与 pkill 无匹配退 1 的口径一致）
      if (!isMihomoProcess(pid)) {
        killedCount++;
        continue;
      }
      if (killProcess(pid)) {
        killedCount++;
      } else {
        failedPids.push(pid);
      }
    }
  }

  for (let i = 0; i < PROCESS_WAIT_ATTEMPTS; i++) {
    if (getMihomoPids().length === 0) break;
    await sleep(PROCESS_WAIT_INTERVAL);
  }

  // sudo 脚本已自行 rm pid；其余路径在此收口（root 属主 pid 文件残留会再提一次权，
  // 但脚本成功时文件已不存在，clearPid 直接返回）。两类错误各自独立带出：
  // 进程死光但脚本没走完（scriptError）与仅 pid 文件没删掉（pidError）归因不同，
  // 合并成一个字段会让调用方的提示说错事
  const pidError = pidCleanupError(clearPid());

  return { killed: killedCount, failed: failedPids.length, remaining: getMihomoPids(), scriptError, pidError };
}

export async function stop(): Promise<StopResult> {
  const allPids = getMihomoPids();
  if (allPids.length === 0) {
    // 进程已不在：root 属主 pid 文件清理失败（非 TTY/取消）只警告，不把 stop 挡成失败——
    // 没有进程读它，文件无害，runtime/ 照常清理（旧 clearPid 也是 console.warn 不抛）
    warnPidCleanupFailed(clearPid());
    clearRuntime();
    return { success: true, notRunning: true };
  }

  const result = await cleanupAll();
  if (result.remaining.length === 0) {
    // 进程都清干净了，两类收尾错误都不改变停止结论，但归因必须分开：
    // pidError 是文件残留（下次 stop 再试）；scriptError 是清理脚本没走完——
    // 进程是在死亡等待内自行退光的，不是被 sudo 清掉的，用户应知道区别
    warnPidCleanupFailed(result.pidError);
    if (result.scriptError) {
      const reason = result.scriptError instanceof SudoAuthError ? 'sudo 已取消或密码错误' : 'sudo 脚本执行失败';
      console.warn(colors.yellow(`警告: root 残留清理未完成（${reason}），进程目前已不在；再发现残留可重试 mihomo stop`));
    }
  }

  const remaining = getMihomoPids();
  if (remaining.length > 0) {
    console.log('');
    console.log('仍有进程残留，需要手动清理:');
    console.log(`进程 PID: ${remaining.join(', ')}`);
    console.log('手动命令: sudo pkill -9 mihomo');
    console.log('');
    return { success: true, remaining };
  }

  clearRuntime();
  return { success: true, killed: result.killed };
}
