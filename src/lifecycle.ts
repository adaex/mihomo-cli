/**
 * 静默 SIGINT 标志：tail -f 等场景下 Ctrl+C 是常规退出，
 * 置位后全局 SIGINT 处理器不再打印"正在退出..."（仍正常退出）。
 *
 * 曾另有一套「退出前清理 detached 子进程」的注册表（registerCleanup/runCleanup）。
 * v4.1.0 把 Mixed 改由 launchd 托管、删掉 detached spawn 后就再无注册方，
 * 注册表恒为空、runCleanup 恒空转——留着会让人误以为信号安全网仍在生效，故一并删除。
 * 真需要清理时再加回来，别留空壳。
 */
let silentSigint = false;

export function setSilentSigint(value: boolean): void {
  silentSigint = value;
}

export function isSilentSigint(): boolean {
  return silentSigint;
}
