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
 * cleanupAll 结果的三档处置（classifyResidueCleanup 一族）也收口在此。
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
 * pid 文件清理失败的核心短语，三处警告（游离 stop / 服务路径 / reset）共用——
 * 各写一份会漂移出多种说法；语境后缀（重试入口等）由调用方自行拼接
 */
export function describePidCleanupFailure(err: Error): string {
  return `pid 文件未能清理（${err.message}）`;
}

/**
 * 杀不掉的内核进程的幂等兜底命令，五处提示（stop/handleStopResult/reset/
 * 残留错误包装/uninstall）共用——前缀曾漂移出「请手动运行/手动命令/手动清理」三种说法
 */
export const MANUAL_PKILL_HINT = '手动清理: sudo pkill -9 mihomo';

/**
 * 卸载/重置完成后仍残留的用户态内核进程提示（uninstall 与纯 reset service 共用
 * 同一份渲染——措辞曾在两处各抄一份）。语境是「主操作已成功、只剩进程没杀掉」，
 * 与 stop 的多行残留块不是同一语境，那个由 stop 自己组装
 */
export function printResidueWarning(remaining: readonly number[]): void {
  console.log(colors.yellow(`仍有内核进程残留 (PID ${remaining.join(', ')})`));
  console.log(MANUAL_PKILL_HINT);
}

/**
 * pid 文件清理失败的可见警告（进程已不在时的唯一出口）。语气由调用方决定——
 * 游离 stop 与服务路径都要让用户知道文件还在、下次会再试，不能静默
 */
function warnPidCleanupFailed(err: Error | null): void {
  if (!err) return;
  console.warn(colors.yellow(`警告: ${describePidCleanupFailure(err)}，下次 stop 会再次尝试`));
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
 * root 残留（TUN 内核）的一次性清理脚本：sudo 内只做 pkill，
 * **只弹一次密码**。pkill 的 pattern 匹配所有主实例（含用户态进程），故调用方
 * 只要发现 root 残留即可整体交给本脚本。
 *
 * 脚本里**不删 pid 文件**——pid 收口唯一在 cleanupAll 末尾（复核 remaining 为空
 * 才免提权删）。sudo 被取消时脚本根本不执行、pkill 失败时 `exit 2`，两者都可能
 * 留下活进程；在提权脚本里无条件 `rm pid` 会绕过「活进程不删 isRunning 真相源」
 * 这道唯一防线（此前仅靠这两条时序间接保证）。且 root 属主 pid 在用户拥有的
 * runtime/ 下本就能免提权 unlink，放进 sudo 删没有收益。
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
 *   删不掉只作 pidError 警告带出，不挡任何命令
 * - 无 root 进程：≤3 个逐 pid 复核命令行后 SIGKILL（防 pid 复用误杀），更多走批量 pkill
 * - 有 root 进程：一次 sudo 脚本（只 pkill，不删 pid 文件）；sudo 非 TTY/取消/失败不抛，
 *   经返回值的 scriptError/pidError 与 remaining 交给调用方按各自语境包装
 * - 发信号后**轮询等待死亡**（最多 5s）再复核 pgrep：root 进程被信号终止后由
 *   launchd 收养/收割，立即复核可能仍列到濒死 pid，误报「部分进程未终止」
 */
export async function cleanupAll(): Promise<CleanupResult> {
  const pids = getMihomoPids();
  if (pids.length === 0) {
    return { killed: 0, failed: 0, remaining: [], scriptError: null, pidError: clearPid() };
  }

  let killedCount = 0;
  const failedPids: number[] = [];
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
      // 发信号前复核命令行：pgrep 探测到此发信号隔着上面的 probe（与 root 判定同一份），
      // 目标自行退出且 pid 被复用的话，盲目 SIGKILL 会误杀无关进程——
      // 复核不匹配按「无事可做」计成功（与 pkill 无匹配退 1 的口径一致）
      const probed = probes.get(pid);
      if (!probed || !isProbedMihomo(probed)) {
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

  await waitUntilNoMihomo(pids);

  // pid 文件的**唯一收口**：先复核 remaining，**有进程活着时不得删**——pid 文件是
  // isRunning/status 的真相源（getPid 只信它），sudo 被取消、root TUN 仍在路由时
  // 把文件删掉，status 从此对活着的内核报「未运行」。零进程才在此免提权清理
  // （无交互代价；sudo 脚本只 pkill、不碰 pid，root 属主文件同样在此直接 unlink）
  const remaining = getMihomoPids();
  const pidError = remaining.length === 0 ? clearPid() : null;

  // 两类错误各自独立带出：进程死光但脚本没走完（scriptError）与仅 pid 文件没删掉
  // （pidError）归因不同，合并成一个字段会让调用方的提示说错事
  return { killed: killedCount, failed: failedPids.length, remaining, scriptError, pidError };
}

// === cleanupAll 结果的三档处置 ===

/** root 残留清理失败包装的上下文：主体动作进行到哪一步、重试入口，三个调用点各不相同 */
export interface RootResidueCleanupContext {
  /** 主体动作的结果描述，如「服务已停止，登录自启已关闭」；start 路径是「服务尚未启动」 */
  mainOutcome: string;
  /** 重新尝试清理的命令，如 'mihomo-cli stop' */
  retryCommand: string;
}

/**
 * 把 cleanupAll 的 root 清理结果包成 CliError——纯函数，供测试。
 * 统一说清三件关键事实：主体动作已完成到哪一步、root 残留还在（带 PID）、重试入口。
 * sudo 取消（scriptError 是 SudoAuthError；pidError 免提权、不可能是它）label 用
 * 「已取消」；其余失败保留原始消息（scriptError 优先——它先于 pid 收口发生）。
 * remaining 的归因按 scriptError 分：非空 = root 脚本没走通，残留按 root 论；
 * 空 = 没进过 root 分支，残留是用户态没能终止的，不许说成 root 属主。
 * remaining 为空时 **scriptError 优先于 pidError**：仅 pidError = pid 文件残留；
 * scriptError（无论是否并存 pidError）= 进程在死亡等待内自行退光、清理没走完，
 * 主归因随脚本、pid 文件错误只作附带——「可能仍有进程」比「文件残留」更需用户行动，
 * 被 pidError 盖成 rm 引导会漏掉潜在的存活内核
 */
export function buildRootResidueCleanupError(result: Pick<CleanupResult, 'remaining' | 'scriptError' | 'pidError'>, ctx: RootResidueCleanupContext): CliError {
  const { scriptError, pidError } = result;
  const hasKernelResidue = result.remaining.length > 0;
  const pidList = `PID ${result.remaining.join(', ')}`;
  const residueHint = hasKernelResidue
    ? scriptError
      ? `root 残留内核仍在运行（${pidList}），可能继续占用代理端口`
      : `残留内核仍在运行（${pidList}）——用户态未能终止，与提权无关`
    : scriptError
      ? `root 残留清理未完成，进程目前已不在（死亡等待内自行退出，非 sudo 清理）${pidError ? `；${describePidCleanupFailure(pidError)}` : ''}`
      : pidError
        ? `${describePidCleanupFailure(pidError)}: ${PATHS.pidFile}`
        : 'root 残留未清理干净';
  const hint = [ctx.mainOutcome, residueHint, `重新运行可再次尝试清理: ${ctx.retryCommand}`];
  // 有 kernel 残留、或脚本没走完（可能仍有进程）→ pkill 幂等兜底；仅 pid 文件残留才引导 rm
  hint.push(hasKernelResidue || scriptError ? MANUAL_PKILL_HINT : `手动清理: sudo rm -f ${PATHS.pidFile}`);
  if (scriptError instanceof SudoAuthError) {
    // 取消短语走 describeSudoFailure（全仓唯一说法）；此处只补「残留未被清理」的语境
    return new CliError(`${describeSudoFailure(scriptError)}，root 残留未被清理`, { label: '已取消', hint });
  }
  return new CliError(scriptError?.message ?? pidError?.message ?? 'root 残留未清理干净', { label: '清理残留进程失败', hint });
}

/**
 * 残留清理结果的三档处置（纯判据，供测试——真实 root/非 TTY 场景无法黑盒构造）：
 * - 'throw'：root 清理没走通且进程仍在（remaining + scriptError），主体动作结果要说清
 * - 'warn'：无残留进程但有收尾错误（pid 文件没删掉，或进程自行退光而清理没走完），
 *   无害不拦命令
 * - 'ok'：无问题；用户态残留（remaining 非空、无 scriptError）也归这档——交各命令
 *   外层既有的复核（cmdStop 抛、cmdUninstall 提示、start 健康确认）。pidError 是
 *   免提权 unlink 的小错，不参与 throw 分档：remaining 非空时它跟着外层的残留
 *   处置走，不单独拦命令
 */
export type ResidueCleanupVerdict = 'ok' | 'warn' | 'throw';

export function classifyResidueCleanup(result: Pick<CleanupResult, 'remaining' | 'scriptError' | 'pidError'>): ResidueCleanupVerdict {
  // 有进程活着：root 清理没走通（scriptError）才拦命令；用户态残留无论是否
  // 带着pidError 小错都交外层复核。进程清零：收尾错误只警告
  if (result.remaining.length > 0) return result.scriptError !== null ? 'throw' : 'ok';
  return result.scriptError !== null || result.pidError !== null ? 'warn' : 'ok';
}

/**
 * warn 档的统一渲染：服务路径（cleanupKernelsOrThrow）与 reset 的无服务分支共用——
 * 同一份 cleanupAll 结果只允许有一种说法（此前 reset 自组的「可能仍有残留进程」与
 * 这里的「进程目前已不在」互相矛盾）。throw 档的 CliError 也由同一个 builder 产出
 */
export function warnResidueCleanup(result: Pick<CleanupResult, 'remaining' | 'scriptError' | 'pidError'>, ctx: RootResidueCleanupContext): void {
  const err = buildRootResidueCleanupError(result, ctx);
  console.warn(colors.yellow(`警告: ${err.message}`));
  for (const line of err.hint) console.warn(colors.gray(line));
}

/**
 * 服务路径的残留内核收口。唯一实现是上面的 cleanupAll
 * （用户态逐 pid 复核 / root 一次 sudo 脚本 + 死亡等待），抛错/警告判据见
 * classifyResidueCleanup。pid 文件免提权清理、失败只警告，非 TTY 的
 * `mihomo-cli stop` 不会被一个无害残留挡成 exit 1。
 *
 * 返回 cleanupAll 的原始结果：stop/uninstall/reset 各自的外层残留判定（抛
 * 「部分进程未终止」/「重置中止」）消费同一份 remaining，不再重新 pgrep 或再跑一遍清理
 */
export async function cleanupKernelsOrThrow(ctx: RootResidueCleanupContext): Promise<CleanupResult> {
  const result = await cleanupAll();
  const verdict = classifyResidueCleanup(result);
  if (verdict === 'throw') throw buildRootResidueCleanupError(result, ctx);
  if (verdict === 'warn') warnResidueCleanup(result, ctx);
  return result;
}

export async function stop(): Promise<StopResult> {
  const allPids = getMihomoPids();
  if (allPids.length === 0) {
    // 进程已不在：pid 文件免提权清理，失败（罕见权限异常）只警告不挡停止——
    // 没有进程读它，文件无害，runtime/ 照常清理
    warnPidCleanupFailed(clearPid());
    clearRuntime();
    return {};
  }

  const result = await cleanupAll();
  if (result.remaining.length === 0) {
    // 进程都清干净了，两类收尾错误都不改变停止结论，但归因必须分开：
    // pidError 是文件残留（下次 stop 再试）；scriptError 是清理脚本没走完——
    // 进程是在死亡等待内自行退光的，不是被 sudo 清掉的，用户应知道区别
    warnPidCleanupFailed(result.pidError);
    if (result.scriptError) {
      console.warn(colors.yellow(`警告: root 残留清理未完成（${describeSudoFailure(result.scriptError)}），进程目前已不在；再发现残留可重试 mihomo-cli stop`));
    }
  }

  // cleanupAll 的返回值刚在死亡等待后复核过 remaining，中间只隔两条警告——
  // 重发一次 pgrep 是重复观察，且两次结果不一致时反而说不清哪份是真的
  const remaining = result.remaining;
  if (remaining.length > 0) {
    console.log('');
    console.log('仍有进程残留，需要手动清理:');
    console.log(`进程 PID: ${remaining.join(', ')}`);
    console.log(MANUAL_PKILL_HINT);
    console.log('');
    return { remaining };
  }

  clearRuntime();
  return {};
}
