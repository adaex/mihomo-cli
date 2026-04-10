import { hasKernel } from '../config.js';
import * as processManager from '../process.js';
import * as subscription from '../subscription.js';
import type { StopResult } from '../types.js';
import { colors } from '../utils.js';
import { printStatus } from './status.js';

function handleStopResult(result: StopResult): void {
  if (result.remaining && result.remaining.length > 0) {
    console.error(`${colors.red('部分进程未终止:')} ${result.remaining.join(', ')}`);
    console.error('请手动运行: sudo pkill -9 mihomo');
    process.exit(1);
  }
}

export async function cmdStart(args: string[]): Promise<void> {
  if (!hasKernel()) {
    console.error('错误: 未找到内核，请运行 "mihomo kernel"');
    process.exit(1);
  }

  const targetMode = args[1] === 'tun' ? 'tun' : 'mixed';

  const sub = subscription.getActiveSubscription();
  if (!sub) {
    console.error('错误: 没有订阅，请先添加订阅');
    process.exit(1);
  }

  await subscription.autoUpdateStaleSubscription();

  const status = processManager.getStatus();
  const hasProcess = status.running || status.allProcesses.length > 0;

  if (hasProcess) {
    const count = status.allProcesses.length > 0 ? status.allProcesses.length : 1;
    console.log(`停止 ${count} 个进程...`);
  }

  handleStopResult(processManager.stop(true));

  if (hasProcess) {
    console.log(`${colors.green('已停止进程')}\n`);
  }

  let configInfo: { proxies: number; proxyGroups: number };
  try {
    configInfo = subscription.prepareConfigForStart(targetMode, sub.name);
  } catch (e) {
    console.error(`${colors.red('配置错误:')} ${(e as Error).message}`);
    process.exit(1);
  }

  const modeLabel = targetMode === 'tun' ? 'TUN' : 'Mixed';
  console.log([colors.cyan(modeLabel), sub.name, subscription.formatProxySummary(configInfo)].join(' · '));

  try {
    const result = await processManager.start(targetMode);
    console.log(`${colors.green('已启动')} (PID ${result.pid})`);
    printStatus();
  } catch (e) {
    console.error(`${colors.red('启动失败:')} ${(e as Error).message.split('\n')[0]}`);
    process.exit(1);
  }
}
