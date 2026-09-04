import { colors } from '../colors.js';
import { isDaemonEnabled } from '../daemon.js';
import { CliError } from '../errors.js';
import { getMihomoPids } from '../process-probe.js';
import { stop } from '../process-stop.js';
import type { StopResult } from '../types.js';
import { assertNoRemovedSshFlag } from '../utils.js';

/** 检查停止结果：若有进程未终止则报错并退出。start/stop 命令共用。 */
export function handleStopResult(result: StopResult): void {
  if (result.remaining && result.remaining.length > 0) {
    throw new CliError(result.remaining.join(', '), { label: '部分进程未终止', hint: '请手动运行: sudo pkill -9 mihomo' });
  }
}

export async function cmdStop(args: string[]): Promise<void> {
  assertNoRemovedSshFlag(args);

  if (isDaemonEnabled()) {
    console.log(colors.yellow('保活已启用，代理由 launchd 托管'));
    console.log('直接停止会被自动重新拉起，请用: mihomo daemon off');
    return;
  }

  const pids = getMihomoPids();

  if (pids.length === 0) {
    console.log(colors.yellow('不在运行'));
    return;
  }

  console.log(`停止 ${pids.length} 个进程...`);
  handleStopResult(await stop());
  console.log(colors.green('已停止进程'));
}
