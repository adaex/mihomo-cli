import fs from 'node:fs';

import { atomicWriteFileSync, ensureDirs, PATHS } from './paths.js';

/**
 * 「服务被要求停止」的单调计数（epoch）与并发判定基线。判据论证见 docs/decisions.md D2
 * （为什么是停止计数而非 disable 位）、D4（基线在命令入口捕获为进程状态）。
 * 自 service.ts 拆出：只依赖 paths，被 service / hot-reload / runtime / commands
 * 多方消费，独立成节使依赖方向单向。
 */

/**
 * 「服务被要求停止」的单调计数（背景与两版判据的失效形态见 docs/decisions.md D2）。
 *
 * 读失败一律返回 0：文件不存在是首次运行的正常形态；内容损坏时宁可退回「按无并发处理」
 * 也不能让 start 抛错——start 是用户显式意图，不该被一个辅助计数挡住。
 * 导出仅供测试：并发用例要验的就是**这一份**实现在跨进程下的行为，
 * 测试里另抄一份等于在验副本，两边一漂移就测了个假的。
 */
export function readStopEpoch(): number {
  try {
    const n = Number.parseInt(fs.readFileSync(PATHS.serviceStopEpoch, 'utf8').trim(), 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 本进程的并发判定基线。CLI 是单命令进程：main() 在命令入口 capture 一次，
 * 此后本进程所有消费点（锁内判定、热重载后复读、健康确认后复读）读同一份——
 * 停止计数的「命令开始时」基线是进程级事实，不需要跨层参数透传（docs/decisions.md D4）。
 * 未捕获时（测试直接调 service 函数、不经 main）stopEpochBaseline 退化为当前值，
 * 即不判并发——调用方要判并发须先 capture。
 */
let stopEpochBaselineCaptured: number | null = null;

/** 捕获当前停止计数为本进程的并发判定基线（命令入口调一次）。返回捕获值。 */
export function captureStopEpochBaseline(): number {
  stopEpochBaselineCaptured = readStopEpoch();
  return stopEpochBaselineCaptured;
}

/** 并发判定基线：命令入口捕获的值；未捕获时退化为当前值（不判并发）。 */
export function stopEpochBaseline(): number {
  return stopEpochBaselineCaptured ?? readStopEpoch();
}

/**
 * 递增停止计数。写失败**静默忽略**：它只用于并发判定，写不进去最坏退回无防线，
 * 不能让 `stop` 因辅助文件写不了就整体失败——stop 的真正职责（bootout + disable）
 * 已经完成了。
 *
 * **不自己取锁**（withFileLock 不可重入），在 stopService/uninstallService 的
 * serviceLock 临界区内调用是安全的；锁外调用点（install 首装、cmdStart 的 TUN 分支）
 * 的读-改-写可能与他人交错而丢一次递增——判据只问「值变没变」，不问增量准不准。
 */
export function bumpStopEpoch(): void {
  try {
    ensureDirs();
    atomicWriteFileSync(PATHS.serviceStopEpoch, String(readStopEpoch() + 1));
  } catch {
    /* ignore：见函数头注释 */
  }
}

/**
 * 记录一次「已确认停止」：没有 disable 可执行、但状态读取已证明「不会自启且无内核在跑」
 * 的路径（cmdStop 的提前返回、reset 在服务未装时的游离内核清理）。disableServiceAutoStart
 * 覆盖的是有 disable 动作的路径——两个递增入口的前提相同，见 docs/decisions.md D2。
 *
 * 不变式：调用点必须在该路径**最后一道失败检查之后**。走到这条路径本身就是独立依据
 * （相关读取失败都抛错而非降级：assertLaunchctlQueryOk、getMihomoPids 只收退出码 0/1）；
 * 放早了会让一次失败的停止把并发的 start 白白中止。
 * 不自己取锁（同 bumpStopEpoch）；多写者交错偶发用较小值覆盖较大值，判据是 `!==`
 * 而非 `>` 本就偏保守，接受之，不为此加锁。
 */
export function recordServiceStopped(): void {
  bumpStopEpoch();
}

/**
 * 锁内是否应放弃启动。判据只有一份，`startService` 与回归测试共用——
 * **别在别处散写 `isServiceDisabledInLaunchd()` 就 return**。
 *
 * 判据是**停止计数是否变化**，不是 disable 位的值：位是持久的，「上次 stop 留下的」与
 * 「本次并发置的」完全同形，而两者的语义相反——上次留下的位不拦 start（用户显式敲了
 * start，意图就是启动，照常 enable + bootstrap）；本次执行期间变化的计数才拦。
 * 两版判据各自的失效形态见 docs/decisions.md D2，别再退回任何一边。
 */
export function shouldAbortStartOnDisable(stopEpochBefore: number, stopEpochNow: number): boolean {
  return stopEpochNow !== stopEpochBefore;
}
