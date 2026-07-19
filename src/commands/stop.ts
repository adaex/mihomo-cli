import { isDaemonEnabled } from '../daemon.js';
import * as processManager from '../process.js';
import type { StopResult } from '../types.js';
import { colors } from '../utils.js';

/** 检查停止结果：若有进程未终止则报错并退出。start/stop/clean 命令共用。 */
export function handleStopResult(result: StopResult): void {
  if (result.remaining && result.remaining.length > 0) {
    console.error(`${colors.red('部分进程未终止:')} ${result.remaining.join(', ')}`);
    console.error('请手动运行: sudo pkill -9 mihomo');
    process.exit(1);
  }
}

export async function cmdStop(): Promise<void> {
  if (isDaemonEnabled()) {
    console.log(colors.yellow('保活已启用，代理由 launchd 托管'));
    console.log('直接停止会被自动重新拉起，请用: mihomo daemon off');
    return;
  }

  const pids = processManager.getMihomoPids();
  if (pids.length === 0) {
    console.log(colors.yellow('不在运行'));
    return;
  }

  console.log(`停止 ${pids.length} 个进程...`);
  handleStopResult(processManager.stop());
  console.log(colors.green('已停止进程'));
}
