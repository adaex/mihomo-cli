/**
 * 静默 SIGINT 标志：tail -f 等场景下 Ctrl+C 是常规退出，
 * 置位后全局 SIGINT 处理器不再打印"正在退出..."（仍正常退出）。
 */
let silentSigint = false;

export function setSilentSigint(value: boolean): void {
  silentSigint = value;
}

export function isSilentSigint(): boolean {
  return silentSigint;
}
