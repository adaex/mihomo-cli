import { colors } from '../colors.js';
import { isDaemonEnabled } from '../daemon.js';
import { CliError } from '../errors.js';
import { getMihomoPids } from '../process-probe.js';
import { stop } from '../process-stop.js';
import { stopAutoSshTunnels } from '../ssh.js';
import type { StopResult } from '../types.js';
import { hasFlag } from '../utils.js';

/** 检查停止结果：若有进程未终止则报错并退出。start/stop 命令共用。 */
export function handleStopResult(result: StopResult): void {
  if (result.remaining && result.remaining.length > 0) {
    throw new CliError(result.remaining.join(', '), { label: '部分进程未终止', hint: '请手动运行: sudo pkill -9 mihomo' });
  }
}

/**
 * 停止随 start 拉起的隧道。只停 started_by === 'auto' 的——手动 `ssh up` 起的
 * 不该被 `stop` 带走，否则下次 start 又起一个，累积僵尸进程。
 */
function stopAutoSshTunnelsWithLog(): void {
  const stopped = stopAutoSshTunnels();
  if (stopped.length > 0) {
    console.log(`${colors.green('已停止隧道')}: ${stopped.join(', ')}`);
  }
}

export async function cmdStop(args: string[]): Promise<void> {
  if (isDaemonEnabled()) {
    // 保活下本命令整体是 no-op（代理会被 launchd 拉回来），故也不碰隧道——
    // 只停一半会得到「代理还在跑但内网分流断了」的割裂状态
    console.log(colors.yellow('保活已启用，代理由 launchd 托管'));
    console.log('直接停止会被自动重新拉起，请用: mihomo daemon off');
    return;
  }

  const skipSsh = hasFlag(args, '--no-ssh');
  const pids = getMihomoPids();

  if (pids.length === 0) {
    console.log(colors.yellow('不在运行'));
    // 不能在这里 return 就完事：内核没跑不代表隧道没跑（例如内核崩了、或只跑了 ssh up），
    // 隧道清理必须在此分支之外照常进行
    if (!skipSsh) stopAutoSshTunnelsWithLog();
    return;
  }

  console.log(`停止 ${pids.length} 个进程...`);
  handleStopResult(stop());
  console.log(colors.green('已停止进程'));

  if (!skipSsh) stopAutoSshTunnelsWithLog();
}
