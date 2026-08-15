import { DEFAULT_TEST_CONCURRENCY, DEFAULT_TEST_TIMEOUT } from '../constants.js';
import { isDaemonEnabled } from '../daemon.js';
import * as processManager from '../process.js';
import { createProgressPrinter, formatCleanSummary, formatTestSummary } from '../progress.js';
import * as runtime from '../runtime.js';
import * as subscription from '../subscription.js';
import { CliError, colors, parseIntArg } from '../utils.js';
import { requireRunning } from './shared.js';
import { handleStopResult } from './stop.js';

export async function cmdTest(args: string[]): Promise<void> {
  requireRunning();
  const activeSub = subscription.requireActiveSubscription('没有活跃订阅');

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
  const activeSub = subscription.requireActiveSubscription('没有活跃订阅');

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
      if (!daemonManaged) {
        // 隐式停止不应意外弹 sudo：root（TUN）实例引导用户用 sub clean（隔离测速，无需停止）
        if (processManager.hasRootResidue()) {
          throw new CliError('主实例以 root 运行（TUN），停止它需要 sudo', { hint: '请改用 mihomo sub clean（隔离实例测速，无需停止主实例）' });
        }
        handleStopResult(processManager.stop());
      }
      const configInfo = subscription.prepareConfigForStart(mode, activeSub.name);
      const pid = await runtime.launchOrRestart(mode);
      const label = daemonManaged ? '已重启 (保活)' : '已重启';
      console.log(`${colors.green(label)}${pid ? ` (PID ${pid})` : ''} · ${subscription.formatProxySummary(configInfo)}`);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError((e as Error).message.split('\n')[0], { label: '重启失败' });
    }
  }
}
