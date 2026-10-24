import type { ChildProcess } from 'node:child_process';

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

/** 仅登记调用方拥有、且必须随 CLI 信号退出的非 detached 子进程。 */
const activeChildren = new Set<ChildProcess>();

/**
 * 登记受管子进程，返回幂等注销函数；正常 close 也会自动注销。
 * 调用方若另有收尾路径，应显式调用注销，避免进程对象滞留到命令结束。
 */
export function trackChildProcess(child: ChildProcess): () => void {
  activeChildren.add(child);
  const untrack = () => activeChildren.delete(child);
  child.once('close', untrack);
  return untrack;
}

/** 向当前仍受管的所有子进程发信号；已退出或无法发信号的进程不阻断其余清理。 */
export function terminateActiveChildren(signal: NodeJS.Signals): void {
  for (const child of activeChildren) {
    try {
      child.kill(signal);
    } catch {
      // 单个进程已退出或发信号失败时，其余受管子进程仍须收到信号
    }
  }
}
