import { hasKernel } from '../config.js';
import { DEFAULT_TEST_CONCURRENCY, DEFAULT_TEST_TIMEOUT } from '../constants.js';
import { getDaemonStatus, isDaemonEnabled, restartDaemon } from '../daemon.js';
import * as processManager from '../process.js';
import * as subscription from '../subscription.js';
import { colors, hasFlag, parseIntArg, sleep } from '../utils.js';
import { printStatus } from './status.js';
import { handleStopResult } from './stop.js';
import { createProgressPrinter, formatCleanSummary, formatTestSummary } from './subscription.js';

/** kickstart 后等待 launchd 拉起进程、再查询 PID 的时间 */
const DAEMON_RESTART_WAIT_MS = 500;

export async function cmdStart(args: string[]): Promise<void> {
  if (!hasKernel()) {
    console.error('错误: 未找到内核，请运行 "mihomo kernel"');
    process.exit(1);
  }

  const targetMode = args[1] === 'tun' ? 'tun' : 'mixed';
  const daemonEnabled = isDaemonEnabled();

  if (targetMode === 'tun' && daemonEnabled) {
    console.error(`${colors.red('错误:')} 保活已启用（仅支持 Mixed 模式），无法启动 TUN`);
    console.error('请先关闭保活: mihomo daemon off');
    process.exit(1);
  }

  const rounds = parseIntArg(args, '-r', '--rounds', subscription.DEFAULT_CLEAN_ROUNDS);
  const timeout = parseIntArg(args, '-t', '--timeout', DEFAULT_TEST_TIMEOUT);
  const concurrency = parseIntArg(args, '-j', '--concurrency', DEFAULT_TEST_CONCURRENCY);
  const skipUpdate = hasFlag(args, '-s', '--no-update');
  const updateTimeout = parseIntArg(args, '-u', '--update-timeout', subscription.DEFAULT_AUTO_UPDATE_TIMEOUT);

  const sub = subscription.getActiveSubscription();
  if (!sub) {
    console.error('错误: 没有订阅，请先添加订阅');
    process.exit(1);
  }

  if (!skipUpdate) {
    await subscription.autoUpdateStaleSubscription({ timeout: updateTimeout });
  }

  // 保活模式下由 launchd 托管进程，重启走 kickstart（不裸 kill，避免与 KeepAlive 打架）；
  // 非保活模式沿用 stop() + start()。
  async function launchOrRestart(): Promise<number | null> {
    if (daemonEnabled) {
      await restartDaemon();
      await sleep(DAEMON_RESTART_WAIT_MS);
      return getDaemonStatus().pid;
    }
    const result = await processManager.start(targetMode);
    return result.pid;
  }

  if (!daemonEnabled) {
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
    const pid = await launchOrRestart();
    const label = daemonEnabled ? '已启动 (保活)' : '已启动';
    console.log(`${colors.green(label)}${pid ? ` (PID ${pid})` : ''}`);
  } catch (e) {
    const msg = (e as Error).message;
    const lines = msg.split('\n');
    console.error(`${colors.red('启动失败:')} ${lines[0]}`);
    if (lines.length > 1) {
      for (const line of lines.slice(1)) console.error(line);
    }
    process.exit(1);
  }

  const cleanThreshold = subscription.isGithubUrl(sub.url) ? subscription.AUTO_CLEAN_THRESHOLD_GITHUB : subscription.AUTO_CLEAN_THRESHOLD;

  if (configInfo.proxies > cleanThreshold) {
    console.log('');
    console.log(`节点数 ${configInfo.proxies} 超过 ${cleanThreshold}，自动清理...`);
    console.log('');

    await sleep(1000);

    const progress = createProgressPrinter(rounds);
    const cleanResult = await subscription.autoCleanSubscription(sub.name, {
      timeout,
      concurrency,
      rounds,
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
      if (!daemonEnabled) handleStopResult(processManager.stop());
      try {
        configInfo = subscription.prepareConfigForStart(targetMode, sub.name);
        const pid = await launchOrRestart();
        console.log(`${colors.green('已重启')}${pid ? ` (PID ${pid})` : ''} · ${subscription.formatProxySummary(configInfo)}`);
      } catch (e) {
        console.error(`${colors.red('重启失败:')} ${(e as Error).message.split('\n')[0]}`);
        process.exit(1);
      }
    }
  }

  printStatus();
}
