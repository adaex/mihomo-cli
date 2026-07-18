import { getConfigInfo } from '../config.js';
import { DEFAULT_TEST_CONCURRENCY, DEFAULT_TEST_TIMEOUT } from '../constants.js';
import * as processManager from '../process.js';
import * as subscription from '../subscription.js';
import type { Subscription } from '../types.js';
import { colors, parseIntArg } from '../utils.js';
import { handleStopResult } from './stop.js';
import { createProgressPrinter, formatCleanSummary, formatTestSummary } from './subscription.js';

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

  const timeout = parseIntArg(args, '-t', '--timeout', DEFAULT_TEST_TIMEOUT);
  const concurrency = parseIntArg(args, '-j', '--concurrency', DEFAULT_TEST_CONCURRENCY);

  console.log(`测试 "${activeSub.name}" 节点连通性...`);
  console.log(`超时: ${timeout}ms  并发: ${concurrency}`);
  console.log('');

  const progress = createProgressPrinter();

  const summary = await subscription.testSubscriptionProxies(activeSub.name, {
    timeout,
    concurrency,
    onResult: progress.onResult,
  });

  progress.finish();
  console.log(formatTestSummary(summary));
}

export async function cmdClean(args: string[]): Promise<void> {
  requireRunning();
  const activeSub = requireActiveSub();

  const timeout = parseIntArg(args, '-t', '--timeout', DEFAULT_TEST_TIMEOUT);
  const concurrency = parseIntArg(args, '-j', '--concurrency', DEFAULT_TEST_CONCURRENCY);
  const rounds = parseIntArg(args, '-r', '--rounds', subscription.DEFAULT_CLEAN_ROUNDS);

  console.log(`清理 "${activeSub.name}" 失败节点...`);
  console.log(`超时: ${timeout}ms  并发: ${concurrency}`);
  console.log('');

  const progress = createProgressPrinter(rounds);

  const result = await subscription.autoCleanSubscription(activeSub.name, {
    timeout,
    concurrency,
    rounds,
    onResult: progress.onResult,
    onRetryRound: progress.onRetryRound,
  });

  progress.finish();
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

    // 保留当前运行模式，避免 TUN 用户被静默降级为 mixed
    const currentMode = getConfigInfo()?.tun ? 'tun' : 'mixed';
    handleStopResult(processManager.stop());
    const configInfo = subscription.prepareConfigForStart(currentMode, activeSub.name);
    const startResult = await processManager.start(currentMode);
    console.log(`${colors.green('已重启')} (PID ${startResult.pid}) · ${subscription.formatProxySummary(configInfo)}`);
  }
}
