import fs from 'node:fs';

import { atomicWriteFileSync, ensureDirs, PATHS } from './paths.js';

/**
 * 「服务被要求停止」的单调计数（epoch）与并发判定基线。为什么判计数而不判 disable 位见
 * docs/decisions.md D2，基线为何在命令入口捕获见 D4。只依赖 paths，使依赖方向单向。
 */

/**
 * 读停止计数。读失败一律返回 0（文件不存在是首次运行；损坏时退回「按无并发处理」，
 * 不能让 start 被辅助计数挡住）。导出供跨进程测试验证这一份实现本身。
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
 * 本进程的并发判定基线：main() 在命令入口捕获一次，所有消费点读同一份（D4）。
 * 未捕获时（测试直调 service 函数）退化为当前值，即不判并发。
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
 * 递增停止计数。调用点：disableServiceAutoStart（disable 复核后），以及没有 disable 可做、
 * 但已确认「不会自启且无内核在跑」的路径（cmdStop 提前返回/游离内核清理后、reset、TUN 分支）——
 * 必须在该路径最后一道失败检查之后（D2）。
 * 写失败静默忽略（stop 的真正职责已完成）；不自己取锁，锁外调用可能丢一次递增，
 * 判据只问「变没变」。
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
 * 停止计数是否变化（并发判定的唯一纯判据）。判 `!==` 而非 `>`：epoch 文件被删后回到 0
 * 同样视为期间发生过停止。为什么判计数而不判 disable 位，见 docs/decisions.md D2。
 */
export function epochChanged(before: number, now: number): boolean {
  return now !== before;
}

/** 启动路径各消费点的唯一读法：进程基线（命令入口捕获）对现值（D4） */
export function startAbortedByConcurrentStop(): boolean {
  return epochChanged(stopEpochBaseline(), readStopEpoch());
}
