import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { colors } from './colors.js';
import { CliError } from './errors.js';
import { DIRS, ensureDirs, PATHS, rmrf } from './paths.js';
import { getMihomoPids, isProbedMihomo, MAIN_INSTANCE_PATTERN, probeProcess } from './process-probe.js';
import { describeSudoFailure, runSudoScript, SudoAuthError } from './sudo.js';
import { shellQuote } from './text.js';
import type { CleanupResult, StopResult } from './types.js';
import { sleep } from './utils.js';

/**
 * 内核进程的停止与残留清理。与启动（process-start.ts）分家：
 * 游离内核的 stop()、服务路径（service.ts）的残留收口、reset 的停机清理
 * 都走本文件唯一的 cleanupAll，不再各维护一份杀进程实现；
 * cleanupAll 结果的处置（抛错/警告与包装）也收口在此。
 *
 * 「等进程退出」的轮询用 async 的 `sleep` 而非 `sleepSync`：后者是 `Atomics.wait`，
 * 会阻塞整个事件循环，**期间 SIGINT 完全不被处理**（实测 50×100ms 的忙等要等循环
 * 全部走完、5.3 秒后才响应 Ctrl+C）。用户在 `mihomo-cli stop` 卡住时按 Ctrl+C 会以为
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

/**
 * 杀不掉的内核进程的幂等兜底命令，五处提示（stop/handleStopResult/reset/
 * 残留错误包装/uninstall）共用——前缀曾漂移出「请手动运行/手动命令/手动清理」三种说法
 */
export const MANUAL_PKILL_HINT = '手动清理: sudo pkill -9 mihomo';

/**
 * 卸载/重置完成后仍残留的用户态内核进程提示（uninstall 与纯 reset service 共用
 * 同一份渲染）。语境是「主操作已成功、只剩进程没杀掉」，
 * 与 stop 的多行残留块不是同一语境，那个由 stop 自己组装
 */
export function printResidueWarning(remaining: readonly number[]): void {
  console.log(colors.yellow(`仍有内核进程残留 (PID ${remaining.join(', ')})`));
  console.log(MANUAL_PKILL_HINT);
}

/**
 * 清理 pid 文件，免提权。判据：文件在 runtime/ 下（用户属主目录、无 sticky bit），
 * 目录可写即可 unlink 其中任意文件、与文件属主无关——root 属主的 TUN 残留也一样，
 * 走 sudo rm 是误把「文件属主」当成删除权限的判据，白白多弹一次管理员密码
 */
export function clearPid(): Error | null {
  try {
    fs.unlinkSync(PATHS.pidFile);
    return null;
  } catch (e) {
    // 文件本就不在 = 干净状态，与删除成功同归
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return e as Error;
  }
}

/**
 * pid 是否仍占着进程表（无信号存活探测）：ESRCH = 已死；EPERM = 进程在但无权
 * （按在算）。只用于死亡等待轮询的快路径，终态结论一律以 pgrep pattern 复核为准
 * ——pid 被无关进程复用会让本探测误判「还在」，多等几轮而已，不会错杀也不会
 * 错报终态；launchd 新拉起的实例是新 pid，本探测看不到，正需要终态 pgrep 兜住
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * 轮询等待主实例进程全部退出（发信号 / bootout 后的死亡收割）。零进程提前返回，
 * 超时也正常返回——是否仍有进程由调用方另行复核，不在此抛错。
 *
 * 按持有的 pid 列表轮询（无 spawn，等待窗内 SIGINT 可达，不被每次约 11ms 的
 * pgrep 阻塞）；终态复核始终是 pgrep，判据不因这条快路径改变
 */
async function waitUntilNoMihomo(pids: readonly number[]): Promise<void> {
  for (let i = 0; i < PROCESS_WAIT_ATTEMPTS; i++) {
    if (!pids.some(pidAlive)) return;
    await sleep(PROCESS_WAIT_INTERVAL);
  }
}

/** 发信号失败（进程已退出、无权限）不在此判：结论由 cleanupAll 的 remaining 复核给出 */
function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 见函数头 */
  }
}

/**
 * 批量终止**用户态**内核。pkill 失败（退 2/3：pattern 编译错误等）不在此判——
 * 停止是否成功只看 cleanupAll 死亡等待后的 remaining 复核（终态观察，不信调用回执）。
 * root 属主进程不走这里（见 buildKernelCleanupScript 的 sudo 路径）。
 */
function killAllMihomo(): void {
  spawnSync('pkill', ['-9', '-f', MAIN_INSTANCE_PATTERN], { timeout: 10_000 });
}

/**
 * root 残留（TUN 内核）的一次性清理脚本：sudo 内只做 pkill，
 * **只弹一次密码**。pkill 的 pattern 匹配所有主实例（含用户态进程），故调用方
 * 只要发现 root 残留即可整体交给本脚本。
 *
 * 脚本里**不删 pid 文件**——pid 收口唯一在 cleanupAll 末尾（复核 remaining 为空
 * 才免提权删）。sudo 被取消时脚本根本不执行、pkill 失败时 `exit 2`，两者都可能
 * 留下活进程；在提权脚本里无条件 `rm pid` 会绕过「活进程不删 isRunning 真相源」。
 * 且 root 属主 pid 在用户拥有的 runtime/ 下本就能免提权 unlink，放进 sudo 删没有收益。
 *
 * 退出码协议：2 = 脚本内真实失败，1 留给 sudo 鉴权取消。
 */
export function buildKernelCleanupScript(): string {
  return [
    '#!/bin/bash',
    // pkill 退出码 2/3 是 pattern 编译失败等探测性错误，不能当「没有进程」吞掉
    `pkill -9 -f ${shellQuote(MAIN_INSTANCE_PATTERN)} 2>/dev/null`,
    'rc=$?',
    '[ $rc -le 1 ] || exit 2',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * 清理全部主实例内核并等待死亡，是所有停止/卸载/重置路径的唯一入口。
 *
 * - 零进程：免提权清掉 pid 文件（clearPid 对 root 属主残留同样直接删），
 *   删不掉经 incomplete 带出、只警告，不挡任何命令
 * - 无 root 进程：≤3 个逐 pid 复核命令行后 SIGKILL（防 pid 复用误杀），更多走批量 pkill
 * - 有 root 进程：一次 sudo 脚本（只 pkill，不删 pid 文件）；sudo 非 TTY/取消/失败不抛，
 *   经返回值的 incomplete 与 remaining 交给调用方按各自语境包装
 * - 发信号后**轮询等待死亡**（最多 5s）再复核 pgrep：root 进程被信号终止后由
 *   launchd 收养/收割，立即复核可能仍列到濒死 pid，误报「部分进程未终止」
 */
export async function cleanupAll(): Promise<CleanupResult> {
  const pids = getMihomoPids();
  if (pids.length === 0) {
    return { remaining: [], incomplete: clearPid() };
  }

  let scriptError: Error | null = null;

  // 每个 pid 一次 ps 取全存活/属主/命令行：root 判定与逐 pid 复核读同一份 probe，
  // 不再先查 uid、再查存活、再两 needle 连跑数次
  const probes = new Map(pids.map(pid => [pid, probeProcess(pid)]));
  const rootPids = pids.filter(pid => probes.get(pid)?.uid === '0');
  if (rootPids.length > 0) {
    // root 属主进程用户态 kill 不掉；sudo 脚本的 pkill 同时覆盖用户态主实例，
    // 故不再分别处理。先给一句人话预告再弹英文 Password:，与 TUN 路径同款；
    // 预告只列 root 属主的 PID（sudo 的动因），用户态游离内核混在其中时全列会失实
    console.log(`检测到 root 属主的内核残留（PID ${rootPids.join(', ')}），清理需要一次管理员密码`);
    try {
      runSudoScript(buildKernelCleanupScript(), {
        action: '清理残留进程',
        file: 'cleanup-residue.sh',
        codeMessages: { 2: '终止残留内核失败（pkill 退出码异常）' },
      });
    } catch (e) {
      // 取消/密码错误（SudoAuthError）与脚本失败都不抛：remaining 复核与本字段
      // 交给调用方按各自语境包装（stop 报残留、服务路径报「已取消」）
      scriptError = e as Error;
    }
  } else if (pids.length > BATCH_KILL_THRESHOLD) {
    // 批量 pkill 失败（退 2/3）不在此判：结论统一由下方死亡等待后的 remaining 复核给出
    killAllMihomo();
  } else {
    for (const pid of pids) {
      // 发信号前复核命令行：pgrep 探测到此发信号隔着上面的 probe（与 root 判定同一份），
      // 目标自行退出且 pid 被复用的话，盲目 SIGKILL 会误杀无关进程——
      // 复核不匹配按「无事可做」计成功（与 pkill 无匹配退 1 的口径一致）
      const probed = probes.get(pid);
      if (probed && isProbedMihomo(probed)) killProcess(pid);
    }
  }

  await waitUntilNoMihomo(pids);

  // pid 文件的**唯一收口**：先复核 remaining，**有进程活着时不得删**——pid 文件是
  // isRunning/status 的真相源（getPid 只信它），sudo 被取消、root TUN 仍在路由时
  // 把文件删掉，status 从此对活着的内核报「未运行」。零进程才在此免提权清理
  // （无交互代价；sudo 脚本只 pkill、不碰 pid，root 属主文件同样在此直接 unlink）
  const remaining = getMihomoPids();
  const pidError = remaining.length === 0 ? clearPid() : null;
  return { remaining, incomplete: scriptError ?? pidError };
}

// === cleanupAll 结果的处置 ===

/** 残留清理失败包装的上下文：主体动作进行到哪一步、重试入口 */
export interface RootResidueCleanupContext {
  /** 主体动作的结果描述，如「服务已停止，登录自启已关闭」；start 路径是「服务尚未启动」 */
  mainOutcome: string;
  /** 重新尝试清理的命令，如 'mihomo-cli stop' */
  retryCommand: string;
}

/**
 * 把未走完的清理包成 CliError（纯函数，供测试）：主体动作到了哪一步、仍在的 PID、
 * 重试入口与手动兜底（pkill 幂等，覆盖「其实还有进程」）。sudo 取消按「已取消」渲染
 */
export function buildRootResidueCleanupError(result: CleanupResult, ctx: RootResidueCleanupContext): CliError {
  const state = result.remaining.length > 0 ? `残留内核仍在运行（PID ${result.remaining.join(', ')}）` : '进程目前已不在，但清理未走完';
  const hint = [ctx.mainOutcome, state, `重新运行可再次尝试清理: ${ctx.retryCommand}`, MANUAL_PKILL_HINT];
  if (result.incomplete instanceof SudoAuthError) {
    return new CliError(`${describeSudoFailure(result.incomplete)}，残留未被清理`, { label: '已取消', hint });
  }
  return new CliError(result.incomplete?.message ?? '残留未清理干净', { label: '清理残留进程失败', hint });
}

/** 清理已清空进程但没走完（incomplete）时的警告渲染：服务路径与 reset 的无服务分支共用 */
export function warnResidueCleanup(result: CleanupResult, ctx: RootResidueCleanupContext): void {
  const err = buildRootResidueCleanupError(result, ctx);
  console.warn(colors.yellow(`警告: ${err.message}`));
  for (const line of err.hint) console.warn(colors.gray(line));
}

/**
 * 服务路径的残留内核收口：进程仍在且清理没走通（root 脚本失败/取消）→ 抛；进程已清空但
 * 收尾没走完 → 只警告；用户态残留（清理走完了仍杀不掉）交各命令外层复核
 * （cmdStop 抛、cmdUninstall 提示、start 健康确认）。返回原始结果供外层消费
 */
export async function cleanupKernelsOrThrow(ctx: RootResidueCleanupContext): Promise<CleanupResult> {
  const result = await cleanupAll();
  if (result.incomplete !== null) {
    if (result.remaining.length > 0) throw buildRootResidueCleanupError(result, ctx);
    warnResidueCleanup(result, ctx);
  }
  return result;
}

export async function stop(): Promise<StopResult> {
  const allPids = getMihomoPids();
  if (allPids.length === 0) {
    // 进程已不在：pid 文件删不掉（罕见权限异常）只警告——没有进程读它，文件无害
    const pidError = clearPid();
    if (pidError) console.warn(colors.yellow(`警告: pid 文件未能清理（${pidError.message}），下次 stop 会再次尝试`));
    clearRuntime();
    return {};
  }

  const result = await cleanupAll();
  if (result.remaining.length === 0 && result.incomplete !== null) {
    warnResidueCleanup(result, { mainOutcome: '内核已停止', retryCommand: 'mihomo-cli stop' });
  }

  // 残留的报错与手动清理指引由调用方（cmdStop 的 handleStopResult）统一渲染，此处只返回
  if (result.remaining.length > 0) return { remaining: result.remaining };

  clearRuntime();
  return {};
}
