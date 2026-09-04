import { colors } from '../colors.js';
import { getConfigInfo, getKernelVersion } from '../config.js';
import { isOverwriteEnabled, listOverwriteFile } from '../overwrite.js';
import { getRunningState } from '../runtime.js';
import { getDomainSpec, getServiceStatus, hasBothDomainsInstalled } from '../service.js';
import { getSubscriptionsWithCache } from '../settings.js';
import { formatProxySummary, getActiveSubscription } from '../subscription.js';
import { formatTimestamp, formatTraffic } from '../utils.js';

/** 全程免 sudo：launchctl print / print-disabled 对两个域都可读，pgrep/ps 亦然。 */
export async function printStatus(): Promise<void> {
  const state = getRunningState();
  const service = getServiceStatus();
  const info = getConfigInfo();
  const overwriteEnabled = isOverwriteEnabled();
  const overwriteFiles = listOverwriteFile().files;
  const activeSub = getActiveSubscription();

  const { running, pid, kind, processInfo } = state;

  console.log('');
  // 模式取自配置文件：未运行时也展示上次构建的模式
  let modeLabel = '';
  if (info) {
    const mode = info.tun ? 'TUN' : 'Mixed';
    const carrier = kind === 'service' ? ' · 服务' : kind === 'tun' ? ' · 临时' : '';
    modeLabel = colors.cyan(` (${mode}${carrier})`) as string;
  }
  const statusText = running ? colors.green('● 运行中') : colors.yellow('不在运行');
  console.log(`${colors.gray('状态: ')}${statusText}${modeLabel}`);
  console.log(`${colors.gray('内核: ')}${getKernelVersion() || '未安装'}`);

  if (pid) {
    console.log(`${colors.gray('PID:  ')}${pid}`);
    if (kind === 'tun' && processInfo) {
      console.log(`${colors.gray('内存: ')}${processInfo.memory}`);
    }
  }

  if (info) {
    if (info.tun) {
      // TUN 模式由虚拟网卡接管全局流量；mixed-port 仍在监听可作备用入口，一并标注
      const extra = info.mixedPort ? `，另监听 ${info.mixedPort}` : '';
      console.log(`${colors.gray('端口: ')}TUN 接管${extra}`);
    } else if (info.mixedPort) {
      console.log(`${colors.gray('端口: ')}${info.mixedPort}`);
    } else {
      const ports: string[] = [];
      if (info.httpPort) ports.push(`HTTP:${info.httpPort}`);
      if (info.socksPort) ports.push(`SOCKS:${info.socksPort}`);
      console.log(`${colors.gray('端口: ')}${ports.length > 0 ? ports.join(', ') : '未知'}`);
    }
  }

  if (activeSub) {
    let subLine = `${colors.gray('订阅: ')}${activeSub.name}`;
    if (info) {
      subLine += ` (${formatProxySummary(info)})`;
    }
    console.log(subLine);
    // 订阅流量/到期来自缓存（上次下载响应头），仅缓存里有才展示
    const cached = getSubscriptionsWithCache().find(s => s.name === activeSub.name);
    const traffic = cached ? formatTraffic(cached.upload, cached.download, cached.total) : null;
    if (traffic) {
      console.log(`${colors.gray('流量: ')}${traffic}`);
    }
    if (cached?.expire !== undefined) {
      console.log(`${colors.gray('到期: ')}${formatTimestamp(cached.expire)}`);
    }
  } else {
    console.log(`${colors.gray('订阅: ')}未配置`);
  }

  if (overwriteEnabled && overwriteFiles.length > 0) {
    const names = overwriteFiles.map(f => f.name.replace(/^overwrite\.?/, '').replace(/\.ya?ml$/, '') || '主文件').join(', ');
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (${names})`);
  } else if (overwriteEnabled) {
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (无文件)`);
  } else {
    console.log(`${colors.gray('覆写: ')}${colors.yellow('已禁用')}`);
  }

  printServiceLines(service);

  console.log('');
}

function printServiceLines(service: ReturnType<typeof getServiceStatus>): void {
  if (!service.installed && !service.loaded) {
    console.log(`${colors.gray('服务: ')}${colors.yellow('未安装')} ${colors.gray('(mihomo install 安装后可用 Mixed 模式)')}`);
    return;
  }

  const spec = getDomainSpec(service.domain ?? 'user');

  // plist 被手动删除但任务仍装载：KeepAlive 会持续拉起内核。不能报「已安装」——
  // 那与紧随其后的异常提示自相矛盾，用户无法判断到底装没装
  if (!service.installed) {
    console.log(`${colors.gray('服务: ')}${colors.yellow('异常')} ${colors.gray(`(${spec.label}：plist 不存在，但服务仍处装载状态)`)}`);
    console.log(colors.gray('  KeepAlive 会持续拉起内核，清理: mihomo uninstall'));
  } else {
    console.log(`${colors.gray('服务: ')}${colors.green('已安装')} ${colors.gray(`(${spec.label})`)}`);
  }

  // 自启位独立于 plist 与运行状态：stop 之后重启不会自动回来，这一行让用户能确认
  const autoStart = service.disabled ? colors.yellow('已关闭') : colors.green('已开启');
  console.log(`${colors.gray('自启: ')}${autoStart}`);

  if (hasBothDomainsInstalled()) {
    console.log(colors.yellow('  异常: 用户级与系统级同时装有服务，会抢占同一组端口'));
    console.log(colors.gray('  清理: mihomo uninstall（重复执行直至清空）'));
  }
}
