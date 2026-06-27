type CleanupFn = () => void;

const cleanupFns = new Set<CleanupFn>();

/**
 * 注册一个进程退出前需要同步执行的清理函数（如杀掉测试实例）。
 * 返回取消注册的函数，正常流程结束后应调用以避免重复清理。
 */
export function registerCleanup(fn: CleanupFn): () => void {
  cleanupFns.add(fn);
  return () => {
    cleanupFns.delete(fn);
  };
}

/**
 * 同步执行所有已注册的清理函数。由信号处理器在 process.exit 前调用，
 * 确保 Ctrl+C 时 finally 块被跳过也不会泄漏子进程/临时目录。
 */
export function runCleanup(): void {
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  cleanupFns.clear();
}
