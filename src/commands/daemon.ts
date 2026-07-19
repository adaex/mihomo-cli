import { hasKernel } from '../config.js';
import { DAEMON_BOOT_WAIT_MS, disableDaemon, enableDaemon, getDaemonStatus, isDaemonEnabled, isDaemonRunning } from '../daemon.js';
import * as subscription from '../subscription.js';
import { colors, sleep } from '../utils.js';

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

export async function cmdDaemon(args: string[]): Promise<void> {
  const action = args?.[1];

  if (action === 'on' || action === 'enable') {
    if (!hasKernel()) {
      console.error('错误: 未找到内核，请运行 "mihomo kernel"');
      process.exit(1);
    }
    const sub = subscription.getActiveSubscription();
    if (!sub) {
      console.error('错误: 没有订阅，请先添加订阅');
      process.exit(1);
    }

    let configInfo: { proxies: number; proxyGroups: number };
    try {
      configInfo = subscription.prepareConfigForStart('mixed', sub.name);
    } catch (e) {
      console.error(`${colors.red('配置错误:')} ${(e as Error).message}`);
      process.exit(1);
    }

    console.log(colors.gray('将请求管理员权限以安装系统级保活服务（LaunchDaemon）'));
    console.log(colors.gray('系统级保活需要 root，以解决局域网访问受限问题'));
    try {
      enableDaemon();
    } catch (e) {
      console.error(`${colors.red('启用保活失败:')} ${(e as Error).message}`);
      process.exit(1);
    }

    console.log(`${colors.green('已启用保活')} · ${sub.name} · ${subscription.formatProxySummary(configInfo)}`);
    console.log(colors.gray('开机自启 + 崩溃自动重启，代理将在后台常驻'));
    console.log('');
    await sleep(DAEMON_BOOT_WAIT_MS);
    printDaemonStatus();
    return;
  }

  if (action === 'off' || action === 'disable') {
    if (!isDaemonEnabled()) {
      console.log('保活已是关闭状态');
      console.log('');
      printDaemonStatus();
      return;
    }

    console.log(colors.gray('将请求管理员权限以移除系统级保活服务'));
    try {
      disableDaemon();
    } catch (e) {
      console.error(`${colors.red('关闭保活失败:')} ${(e as Error).message}`);
      process.exit(1);
    }

    console.log(`${colors.green('已关闭保活')}，代理已停止`);
    console.log(colors.gray('重新启用: mihomo daemon on'));
    console.log('');
    return;
  }

  if (action !== undefined && action !== 'status') {
    console.error(`错误: 未知的 daemon 子命令: ${action}`);
    console.log('');
    console.log('可用子命令: on, off, status');
    process.exit(1);
  }

  console.log('');
  printDaemonStatus();
}
