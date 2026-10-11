/**
 * 同步轮询原语：等待跨进程文件信号（子进程就绪标记、桩进程出现在 pgrep）的
 * 统一骨架，各 spec 不再各写「while + Atomics.wait + deadline」轮询体。
 *
 * 同步阻塞是刻意的：这类等待常发生在 withFileLock 持锁回调等同步上下文里，
 * 且测试主进程没有别的事件要派发。
 *
 * 文件名不带 .spec 后缀：测试只收 *.spec.ts 结尾的文件，本支撑模块不会被当套件执行。
 */

/** 同步睡 ms 毫秒。Node 主线程允许带超时的 Atomics.wait，进程内零开销。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 轮询等待谓词为真（50ms 步进，超时后再验一次并返回该次结果）。spawn 返回不代表
 * exec 完成：桩进程的命令行要等 ps/pgrep 能读到才算「在跑」。
 */
export function pollUntil(predicate: () => boolean, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    sleepSync(50);
  }
  return predicate();
}
