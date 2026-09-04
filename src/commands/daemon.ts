import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { DAEMON_BOOT_WAIT_MS, disableDaemon, enableDaemon, getDaemonStatus, isDaemonEnabled, isDaemonRunning } from '../daemon.js';
import { CliError } from '../errors.js';
import { getMihomoPids, isProcessRoot } from '../process-probe.js';
import * as subscription from '../subscription.js';
import type { ConfigSummary } from '../types.js';
import { sleep, suggestSimilar } from '../utils.js';
import { dispatchSubcommand, type SubCommand } from './shared.js';

function printDaemonStatus(): void {
  const status = getDaemonStatus();
  const stateText = status.enabled ? colors.green('已启用') : colors.yellow('已禁用');
  console.log(`${colors.gray('保活: ')}${stateText}`);

  if (status.enabled) {
    const runText = isDaemonRunning(status) ? colors.green(`运行中 (PID ${status.pid})`) : colors.yellow('未运行');
    console.log(`${colors.gray('内核: ')}${runText}`);
  }

  console.log('');
  if (status.enabled) {
    console.log('关闭保活: mihomo daemon off');
  } else {
    console.log('开启保活: mihomo daemon on');
    console.log(colors.gray('  开机自启 + 崩溃自动重启（仅 Mixed 模式）'));
  }
  console.log('');
}

async function daemonOn(): Promise<void> {
  if (!hasKernel()) {
    throw new CliError('未找到内核，请运行 "mihomo kernel"');
  }
  const sub = subscription.requireActiveSubscription('没有订阅，请先添加订阅');

  let configInfo: ConfigSummary;
  try {
    configInfo = subscription.commitPreparedConfig(subscription.prepareConfigForStart('mixed', sub.name));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, { label: '配置错误' });
  }

  console.log(colors.gray('将请求管理员权限以安装系统级保活服务（LaunchDaemon）'));
  console.log(colors.gray('系统级保活需要 root，以解决局域网访问受限问题'));
  try {
    enableDaemon();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, { label: '启用保活失败' });
  }

  console.log(`${colors.green('已启用保活')} · ${sub.name} · ${subscription.formatProxySummary(configInfo)}`);
  console.log(colors.gray('开机自启 + 崩溃自动重启，代理将在后台常驻'));
  console.log('');
  await sleep(DAEMON_BOOT_WAIT_MS);
  printDaemonStatus();
}

function daemonOff(): void {
  // 判据与 disableDaemon 一致：plist 不在**且**没有 root 内核在跑，才算已关闭。
  // 只看 plist 会在「用户手动 sudo rm 掉 plist 但任务仍装载」时谎报「已是关闭状态」，
  // 而 KeepAlive 仍在把内核拉起，用户没有任何途径卸载它
  const residualRootKernel = getMihomoPids().some(isProcessRoot);
  if (!isDaemonEnabled() && !residualRootKernel) {
    console.log('保活已是关闭状态');
    console.log('');
    printDaemonStatus();
    return;
  }

  console.log(colors.gray('将请求管理员权限以移除系统级保活服务'));
  try {
    disableDaemon();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, { label: '关闭保活失败' });
  }

  console.log(`${colors.green('已关闭保活')}，代理已停止`);
  console.log(colors.gray('重新启用: mihomo daemon on'));
  console.log('');
}

const SUBCOMMANDS: SubCommand[] = [
  { name: 'on', aliases: ['enable'], handler: daemonOn },
  { name: 'off', aliases: ['disable'], handler: daemonOff },
];

export async function cmdDaemon(args: string[]): Promise<void> {
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无 action → 显示状态；未知 action → 报错
    fallback: () => {
      console.log('');
      printDaemonStatus();
    },
    onUnknown: action => {
      const names = SUBCOMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
      const suggestion = suggestSimilar(action, names);
      throw new CliError(`未知的 daemon 子命令: ${action}`, {
        hint: [
          ...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []),
          '',
          '可用子命令: on, off',
          '查看保活状态: mihomo daemon（无参）或 mihomo status',
        ],
      });
    },
  });
}
