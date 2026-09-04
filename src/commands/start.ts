import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { isDaemonEnabled } from '../daemon.js';
import { CliError } from '../errors.js';
import { PATHS } from '../paths.js';
import { getStatus, hasRootResidue } from '../process-probe.js';
import { stop } from '../process-stop.js';
import * as runtime from '../runtime.js';
import { startAutoSshTunnels } from '../ssh.js';
import * as subscription from '../subscription.js';
import type { PreparedConfig } from '../types.js';
import { getNonFlagArg, hasFlag, parseIntArg } from '../utils.js';
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
 * 从 argv 解析启动模式。取第一个非 flag token（而非固定 args[1]）：
 * `start -s tun` 里模式在 flag 之后，只看 args[1] 会把它当 flag 丢掉、
 * 静默按 Mixed 启动——正是拼错模式那条报错要防的情形。
 * 与 `sub remove -y foo` / `ssh rm -y foo` 的 getNonFlagArg 口径一致。
 */
export function resolveStartMode(args: string[]): 'tun' | 'mixed' {
  const modeArg = getNonFlagArg(args, 1);
  const modeToken = modeArg?.toLowerCase();
  if (modeToken !== undefined && modeToken !== 'tun' && modeToken !== 'mixed') {
    throw new CliError(`未知的启动模式: ${modeArg}`, { hint: '用法: mihomo start [tun|mixed]（默认 mixed）' });
  }
  return modeToken === 'tun' ? 'tun' : 'mixed';
}

export async function cmdStart(args: string[]): Promise<void> {
  const targetMode = resolveStartMode(args);

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

  // 先构建校验、后停机：坏覆写/不合法订阅在这里就抛错，此时运行中的内核还没被
  // stop() 带走，用户维持在可用状态。反过来（先停后建）失败就是「已停机 + 无
  // config.yaml」的半死态——stop() 的 clearRuntime() 已把 runtime/ 整个删了，无从回滚。
  let prepared: PreparedConfig;
  try {
    prepared = subscription.prepareConfigForStart(targetMode, sub.name);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, { label: '配置错误' });
  }

  // 保活模式下由 launchd 托管进程,重启走 kickstart(不裸 kill,避免与 KeepAlive 打架);
  // 非保活模式沿用 stop() + start()。差异收敛在 runtime.launchOrRestart。

  if (!daemonEnabled) {
    // 隐式停止不应意外弹 sudo：有 root 残留时直接报错引导（与 startMixedMode 的设计一致）。
    // 仅对 Mixed 生效：TUN 本来就要提权，且 buildTunLaunchScript 会以 root 跑
    // `pkill -9` + `rm -f pid`，自带清理能力。对 TUN 也拦的话，正在运行的 TUN
    // （root 属主进程）永远无法重启/切订阅，且报错 hint 会让人去执行刚失败的那条命令。
    if (targetMode !== 'tun' && hasRootResidue()) {
      throw new CliError('存在需要 root 权限清理的残留进程/文件', {
        hint: [`请先手动清理: sudo pkill -9 mihomo && sudo rm -f ${PATHS.pidFile}`, '或切换到 TUN 模式启动（自动清理）: mihomo start tun'],
      });
    }

    const status = getStatus();
    const hasProcess = status.running || status.allProcesses.length > 0;

    if (hasProcess) {
      const count = status.allProcesses.length > 0 ? status.allProcesses.length : 1;
      console.log(`停止 ${count} 个进程...`);
    }

    handleStopResult(await stop());

    if (hasProcess) {
      console.log(`${colors.green('已停止进程')}\n`);
    }
  }

  // 写盘必须在 stop() 之后：clearRuntime() 会 rmrf 整个 runtime/
  const configInfo = subscription.commitPreparedConfig(prepared);

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
