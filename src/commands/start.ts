import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { AUTO_CLEAN_COOLDOWN_HOURS, DEFAULT_TEST_CONCURRENCY, DEFAULT_TEST_TIMEOUT } from '../constants.js';
import { isDaemonEnabled } from '../daemon.js';
import { CliError } from '../errors.js';
import { PATHS } from '../paths.js';
import * as processManager from '../process.js';
import { createProgressPrinter, formatCleanSummary, formatTestSummary } from '../progress.js';
import * as runtime from '../runtime.js';
import { readSubscriptionCache, saveSubscriptionCache } from '../settings.js';
import * as subscription from '../subscription.js';
import { hasFlag, parseIntArg, sleep } from '../utils.js';
import { printStatus } from './status.js';
import { handleStopResult } from './stop.js';

export async function cmdStart(args: string[]): Promise<void> {
  // args[1] 为非 flag token 时才是模式参数；拼错模式名（如 start tn）必须报错，
  // 不能静默按 Mixed 启动（用户会误以为已切到 TUN）。参数校验先于环境检查（内核/订阅）
  const modeToken = args[1] && !args[1].startsWith('-') ? args[1].toLowerCase() : undefined;
  if (modeToken !== undefined && modeToken !== 'tun' && modeToken !== 'mixed') {
    throw new CliError(`未知的启动模式: ${args[1]}`, { hint: '用法: mihomo start [tun|mixed]（默认 mixed）' });
  }
  const targetMode = modeToken === 'tun' ? 'tun' : 'mixed';

  if (!hasKernel()) {
    throw new CliError('未找到内核，请运行 "mihomo kernel"');
  }

  const daemonEnabled = isDaemonEnabled();

  if (targetMode === 'tun' && daemonEnabled) {
    throw new CliError('保活已启用（仅支持 Mixed 模式），无法启动 TUN', { hint: '请先关闭保活: mihomo daemon off' });
  }

  const rounds = parseIntArg(args, '-r', '--rounds', subscription.DEFAULT_CLEAN_ROUNDS);
  const timeout = parseIntArg(args, '-t', '--timeout', DEFAULT_TEST_TIMEOUT);
  const concurrency = parseIntArg(args, '-j', '--concurrency', DEFAULT_TEST_CONCURRENCY);
  const skipUpdate = hasFlag(args, '-s', '--no-update');
  const skipClean = hasFlag(args, '--no-clean');
  const updateTimeout = parseIntArg(args, '-u', '--update-timeout', subscription.DEFAULT_AUTO_UPDATE_TIMEOUT);

  const sub = subscription.requireActiveSubscription('没有订阅，请先添加订阅');

  if (!skipUpdate) {
    await subscription.autoUpdateStaleSubscription({ timeout: updateTimeout });
  }

  // 保活模式下由 launchd 托管进程,重启走 kickstart(不裸 kill,避免与 KeepAlive 打架);
  // 非保活模式沿用 stop() + start()。差异收敛在 runtime.launchOrRestart。

  if (!daemonEnabled) {
    // 隐式停止不应意外弹 sudo：有 root 残留时直接报错引导（与 startMixedMode 的设计一致）
    if (processManager.hasRootResidue()) {
      throw new CliError('存在需要 root 权限清理的残留进程/文件', {
        hint: [`请先手动清理: sudo pkill -9 mihomo && sudo rm -f ${PATHS.pidFile}`, '或切换到 TUN 模式启动（自动清理）: mihomo start tun'],
      });
    }

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
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, { label: '配置错误' });
  }

  const modeLabel = targetMode === 'tun' ? 'TUN' : 'Mixed';
  console.log([colors.cyan(modeLabel), sub.name, subscription.formatProxySummary(configInfo)].join(' · '));

  try {
    const pid = await runtime.launchOrRestart(targetMode);
    const label = daemonEnabled ? '已启动 (保活)' : '已启动';
    console.log(`${colors.green(label)}${pid ? ` (PID ${pid})` : ''}`);
  } catch (e) {
    if (e instanceof CliError) throw e;
    const lines = (e as Error).message.split('\n');
    throw new CliError(lines[0], { label: '启动失败', hint: lines.slice(1) });
  }

  const cleanThreshold = subscription.isGithubUrl(sub.url) ? subscription.AUTO_CLEAN_THRESHOLD_GITHUB : subscription.AUTO_CLEAN_THRESHOLD;

  if (!skipClean && configInfo.proxies > cleanThreshold) {
    // 冷却：上次自动清理在 AUTO_CLEAN_COOLDOWN_HOURS 内则跳过，避免每次 start 都全量测速
    const cache = readSubscriptionCache();
    const lastCleanAt = cache[sub.name]?.last_auto_clean_at;
    const withinCooldown = !!lastCleanAt && Date.now() - new Date(lastCleanAt).getTime() < AUTO_CLEAN_COOLDOWN_HOURS * 60 * 60 * 1000;

    if (!withinCooldown) {
      console.log('');
      console.log(`节点数 ${configInfo.proxies} 超过 ${cleanThreshold}，自动清理（${AUTO_CLEAN_COOLDOWN_HOURS}h 内仅一次，--no-clean 跳过）...`);
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
          const pid = await runtime.launchOrRestart(targetMode);
          console.log(`${colors.green('已重启')}${pid ? ` (PID ${pid})` : ''} · ${subscription.formatProxySummary(configInfo)}`);
        } catch (e) {
          if (e instanceof CliError) throw e;
          throw new CliError((e as Error).message.split('\n')[0], { label: '重启失败' });
        }
      }

      // 记录本次自动清理时间（含 skipped：已测过一轮，冷却内不再测）
      saveSubscriptionCache(sub.name, { last_auto_clean_at: new Date().toISOString() });
    }
  }

  printStatus();
}
