import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { CliError } from '../errors.js';
import * as runtime from '../runtime.js';
import { getServiceStatus } from '../service.js';
import * as subscription from '../subscription.js';
import type { PreparedConfig } from '../types.js';
import { assertNoRemovedSshFlag, getNonFlagArg, hasFlag, parseIntArg } from '../utils.js';
import { printStatus } from './status.js';

/**
 * 从 argv 解析启动模式。取第一个非 flag token（而非固定 args[1]）：
 * `start -s tun` 里模式在 flag 之后，只看 args[1] 会把它当 flag 丢掉、
 * 静默按 Mixed 启动——正是拼错模式那条报错要防的情形。
 * 与 `sub remove -y foo` 的 getNonFlagArg 口径一致。
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
  assertNoRemovedSshFlag(args);
  const targetMode = resolveStartMode(args);

  if (!hasKernel()) {
    throw new CliError('未找到内核', { hint: '下载内核: mihomo kernel' });
  }

  const skipUpdate = hasFlag(args, '-s', '--no-update');
  const updateTimeout = parseIntArg(args, '-u', '--update-timeout', subscription.DEFAULT_AUTO_UPDATE_TIMEOUT);

  const serviceBefore = getServiceStatus();

  if (targetMode === 'tun') {
    // 判据是 loaded 而非 installed：`mh stop` 之后服务虽仍装着但不会被拉起，
    // 此时起 TUN 是正常用法。只看 installed 会把它一并拦掉，与「stop 后可用 tun」矛盾
    if (serviceBefore.loaded) {
      throw new CliError('服务正在运行，无法启动 TUN', {
        hint: ['两者会抢占同一组端口与配置。请先停止服务:', '  mihomo stop', '', 'TUN 用完后 mihomo start 可恢复服务'],
      });
    }
  } else if (!serviceBefore.installed) {
    // Mixed 恒由 launchd 服务托管，没有用户态直启路径。
    // 「plist 已删但任务仍装载」的孤儿态单独指引——此时叫用户 install 只会撞上
    // 「已装载」的旧任务，得先 uninstall 清干净
    if (serviceBefore.loaded) {
      throw new CliError('服务处于异常状态（plist 不存在，但任务仍装载）', {
        hint: ['先清理残留任务，再重新安装:', '  mihomo uninstall', '  mihomo install'],
      });
    }
    throw new CliError('服务未安装', {
      hint: ['Mixed 模式由 launchd 服务托管，需先安装:', '  mihomo install', '', '临时使用可走 TUN: mihomo tun'],
    });
  }

  const sub = subscription.requireActiveSubscription('没有订阅，请先添加订阅');

  if (!skipUpdate) {
    await subscription.autoUpdateStaleSubscription({ timeout: updateTimeout });
  }

  // 先构建校验、后落盘启动：坏覆写/不合法订阅在这里就抛错，此时运行中的内核还没被动过，
  // 用户维持在可用状态。反过来（先动手后构建）失败就是「已停机 + 无 config.yaml」的半死态。
  let prepared: PreparedConfig;
  try {
    prepared = subscription.prepareConfigForStart(targetMode, sub.name);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, { label: '配置错误' });
  }

  const configInfo = subscription.commitPreparedConfig(prepared);

  const modeLabel = targetMode === 'tun' ? 'TUN' : 'Mixed';
  console.log([colors.cyan(modeLabel), sub.name, subscription.formatProxySummary(configInfo)].join(' · '));

  try {
    const pid = await runtime.launchOrRestart(targetMode);
    console.log(`${colors.green('已启动')}${pid ? ` (PID ${pid})` : ''}`);
  } catch (e) {
    if (e instanceof CliError) throw e;
    const lines = (e as Error).message.split('\n');
    throw new CliError(lines[0], { label: '启动失败', hint: lines.slice(1) });
  }

  await printStatus();
}
