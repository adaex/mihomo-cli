import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { isDaemonEnabled } from '../daemon.js';
import { CliError } from '../errors.js';
import { PATHS } from '../paths.js';
import * as processManager from '../process.js';
import * as runtime from '../runtime.js';
import { startAutoSshTunnels } from '../ssh.js';
import * as subscription from '../subscription.js';
import { hasFlag, parseIntArg } from '../utils.js';
import { printStatus } from './status.js';
import { handleStopResult } from './stop.js';

/**
 * 拉起 auto 隧道。失败只告警不抛——隧道只影响内网分流那部分规则，
 * 让整个 start 失败是过度反应。但告警必须显眼：前后留空行、黄色标题，
 * 并附上 ssh 自己说的原因（否则用户只能去翻日志）。
 */
async function startAutoSshTunnelsWithWarning(): Promise<void> {
  const outcomes = await startAutoSshTunnels();
  if (outcomes.length === 0) return;

  const started = outcomes.filter(o => o.ok && !o.alreadyRunning);
  if (started.length > 0) {
    console.log(`${colors.green('已启动隧道')}: ${started.map(o => o.name).join(', ')}`);
  }

  for (const failed of outcomes.filter(o => !o.ok)) {
    console.log('');
    console.log(colors.yellow(`警告: 隧道 "${failed.name}" 启动失败`));
    console.log(colors.gray(`  ${failed.error?.message ?? '未知错误'}`));
    for (const line of failed.error?.hint ?? []) {
      if (line.trim()) console.log(colors.gray(line.startsWith('  ') ? line : `  ${line}`));
    }
    console.log(colors.gray('  内网分流规则将不可用，其余流量正常'));
    console.log(colors.gray(`  排查: mihomo ssh status ${failed.name}`));
    console.log('');
  }
}

/**
 * v3.10.0 随测速清理一并移除的选项。显式报错而非静默忽略：
 * 用户敲了 `--no-clean` 却拿到「照常启动」，属于「不报错但行为不对」——
 * 何况这些选项原本控制的是会改写订阅文件的行为，静默吞掉最容易被误解为仍然生效。
 */
const REMOVED_OPTIONS: Record<string, string> = {
  '-r': '--rounds',
  '--rounds': '--rounds',
  '-t': '--timeout',
  '--timeout': '--timeout',
  '-j': '--concurrency',
  '--concurrency': '--concurrency',
  '--no-clean': '--no-clean',
};

function assertNoRemovedOptions(args: string[]): void {
  const hit = args.find(a => {
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    return Object.hasOwn(REMOVED_OPTIONS, name);
  });
  if (!hit) return;
  throw new CliError(`选项 ${hit} 已移除（v3.10.0，随节点测速清理一并删除）`, {
    label: '参数错误',
    hint: [
      'start 不再在启动后自动测速清理节点，故超时/并发/轮次选项均已失效。',
      '',
      '节点测速请用 Web 面板: mihomo ui',
      '自动选路请在订阅里配置 url-test 分组，由内核持续测速。',
      '',
      'start 现有选项: -s/--no-update, -u/--update-timeout <ms>, --no-ssh',
    ],
  });
}

export async function cmdStart(args: string[]): Promise<void> {
  // 参数校验先于环境检查（内核/订阅），与模式参数同口径
  assertNoRemovedOptions(args);

  // args[1] 为非 flag token 时才是模式参数；拼错模式名（如 start tn）必须报错，
  // 不能静默按 Mixed 启动（用户会误以为已切到 TUN）。
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

  const skipUpdate = hasFlag(args, '-s', '--no-update');
  const skipSsh = hasFlag(args, '--no-ssh');
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

  // 隧道放在内核启动成功之后：内核失败就直接抛错，没必要再起隧道。
  // 反之隧道失败不影响内核——它只影响内网分流那部分规则，其余流量照常走订阅节点。
  if (!skipSsh) {
    await startAutoSshTunnelsWithWarning();
  }

  await printStatus();
}
