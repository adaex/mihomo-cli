import { hasKernel } from '../config.js';
import * as processManager from '../process.js';
import * as subscription from '../subscription.js';
import type { StopResult } from '../types.js';
import { colors, sleep } from '../utils.js';
import { printStatus } from './status.js';
import { createProgressPrinter, formatCleanSummary, formatTestSummary } from './subscription.js';

const AUTO_CLEAN_THRESHOLD = 50;

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

  handleStopResult(processManager.stop());

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
  } catch (e) {
    const msg = (e as Error).message;
    const lines = msg.split('\n');
    console.error(`${colors.red('启动失败:')} ${lines[0]}`);
    if (lines.length > 1) {
      for (const line of lines.slice(1)) console.error(line);
    }
    process.exit(1);
  }

  if (configInfo.proxies > AUTO_CLEAN_THRESHOLD) {
    console.log('');
    console.log(`节点数 ${configInfo.proxies} 超过 ${AUTO_CLEAN_THRESHOLD}，自动清理...`);
    console.log('');

    await sleep(1000);

    const progress = createProgressPrinter(subscription.DEFAULT_CLEAN_ROUNDS);
    const cleanResult = await subscription.autoCleanSubscription(sub.name, {
      onResult: progress.onResult,
      onRetryRound: progress.onRetryRound,
    });
    progress.finish();
    console.log(formatTestSummary(cleanResult.summary));

    if (cleanResult.skipped) {
      console.log(colors.yellow('存活节点不足 1%，跳过清理。请检查原始订阅是否有效'));
    } else if (cleanResult.removedProxies > 0) {
      console.log(`${colors.green('已清理')}: ${formatCleanSummary(cleanResult)}`);

      console.log('');
      console.log('重新加载配置...');
      handleStopResult(processManager.stop());
      try {
        configInfo = subscription.prepareConfigForStart(targetMode, sub.name);
        const result = await processManager.start(targetMode);
        console.log(`${colors.green('已重启')} (PID ${result.pid}) · ${subscription.formatProxySummary(configInfo)}`);
      } catch (e) {
        console.error(`${colors.red('重启失败:')} ${(e as Error).message.split('\n')[0]}`);
        process.exit(1);
      }
    }
  }

  printStatus();
}
