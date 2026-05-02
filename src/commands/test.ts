import * as processManager from '../process.js';
import * as subscription from '../subscription.js';
import type { Subscription } from '../types.js';
import { colors, parseIntArg } from '../utils.js';
import { formatCleanSummary, formatTestSummary, printTestResult } from './subscription.js';

function requireRunning(): void {
  const status = processManager.getStatus();
  if (!status.running) {
    console.error('错误: mihomo 未运行，请先启动 (mihomo start)');
    process.exit(1);
  }
}

function requireActiveSub(): Subscription {
  const activeSub = subscription.getActiveSubscription();
  if (!activeSub) {
    console.error('错误: 没有活跃订阅');
    process.exit(1);
  }
  return activeSub;
}

export async function cmdTest(args: string[]): Promise<void> {
  requireRunning();
  const activeSub = requireActiveSub();

  const timeout = parseIntArg(args, '-t', '--timeout', 1500);
  const concurrency = parseIntArg(args, '-j', '--concurrency', 100);

  console.log(`测试 "${activeSub.name}" 节点连通性...`);
  console.log(`超时: ${timeout}ms  并发: ${concurrency}`);
  console.log('');

  const summary = await subscription.testSubscriptionProxies(activeSub.name, {
    timeout,
    concurrency,
    onResult: printTestResult,
  });

  console.log('');
  console.log(formatTestSummary(summary));
}

export async function cmdClean(args: string[]): Promise<void> {
  requireRunning();
  const activeSub = requireActiveSub();

  const timeout = parseIntArg(args, '-t', '--timeout', 1500);
  const concurrency = parseIntArg(args, '-j', '--concurrency', 100);

  console.log(`清理 "${activeSub.name}" 失败节点...`);
  console.log(`超时: ${timeout}ms  并发: ${concurrency}`);
  console.log('');

  const result = await subscription.autoCleanSubscription(activeSub.name, {
    timeout,
    concurrency,
    onResult: printTestResult,
  });

  console.log('');
  console.log(formatTestSummary(result.summary));

  if (result.skipped) {
    console.log('');
    console.log('存活节点不足 1%，跳过清理。请检查原始订阅是否有效');
  } else if (result.removedProxies === 0) {
    console.log('所有节点正常，无需清理');
  } else {
    console.log(`${colors.green('已清理')}: ${formatCleanSummary(result)}`);
    console.log('');
    console.log('重启 mihomo 使更改生效...');

    processManager.stop();
    const configInfo = subscription.prepareConfigForStart('mixed', activeSub.name);
    const startResult = await processManager.start('mixed');
    console.log(`${colors.green('已重启')} (PID ${startResult.pid}) · ${subscription.formatProxySummary(configInfo)}`);
  }
}
