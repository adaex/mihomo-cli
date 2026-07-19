import { DEFAULT_TEST_CONCURRENCY, DEFAULT_TEST_TIMEOUT } from '../constants.js';
import { isDaemonEnabled } from '../daemon.js';
import * as processManager from '../process.js';
import * as runtime from '../runtime.js';
import * as subscription from '../subscription.js';
import type { Subscription } from '../types.js';
import { colors, parseIntArg } from '../utils.js';
import { handleStopResult } from './stop.js';
import { createProgressPrinter, formatCleanSummary, formatTestSummary } from './subscription.js';

function requireRunning(): void {
  // 运行状态由门面统一(保活看 launchd,普通看 pidFile);提示语按模式区分启动命令。
  const state = runtime.getRunningState();
  if (!state.running) {
    const hint = state.daemon ? 'mihomo daemon on' : 'mihomo start';
    console.error(`错误: mihomo 未运行，请先启动 (${hint})`);
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

    // 模式与重启方式由门面统一:保活恒 mixed 走 kickstart(不 stop);普通保留当前模式、先 stop 再 start。
    const mode = runtime.getRuntimeMode();
    const daemonManaged = isDaemonEnabled();
    try {
      if (!daemonManaged) handleStopResult(processManager.stop());
      const configInfo = subscription.prepareConfigForStart(mode, activeSub.name);
      const pid = await runtime.launchOrRestart(mode);
      const label = daemonManaged ? '已重启 (保活)' : '已重启';
      console.log(`${colors.green(label)}${pid ? ` (PID ${pid})` : ''} · ${subscription.formatProxySummary(configInfo)}`);
    } catch (e) {
      console.error(`${colors.red('重启失败:')} ${(e as Error).message.split('\n')[0]}`);
      process.exit(1);
    }
  }
}
