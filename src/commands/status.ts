import { colors } from '../colors.js';
import { getConfigInfo, getKernelVersion, hasKernel } from '../config.js';
import { VERSION } from '../constants.js';
import { isOverwriteEnabled, listOverwriteFile } from '../overwrite.js';
import { probeProxyConnectivity } from '../proxy-probe.js';
import { getRunningState } from '../runtime.js';
import { detectLegacySystemInstall, getServiceStatus } from '../service.js';
import { getSubscriptionsWithCache } from '../settings.js';
import { formatProxySummary, getActiveSubscription, isSubscriptionStale, resolveUpdateInterval } from '../subscription.js';
import type { ProxyProbeResult, StatusJson, SubscriptionUrgency } from '../types.js';
import { assertKnownFlags, formatDate, formatRelativeTime, formatTimestamp, formatTraffic, hasFlag, subscriptionUrgency } from '../utils.js';

/** 运行中但代理不通时的归因提示（订阅过期/流量用尽优先，其余归到节点） */
function connectivityHint(urgency: SubscriptionUrgency): string {
  if (urgency === 'expired') return '订阅已过期，请续费或更换订阅';
  if (urgency === 'traffic-exhausted') return '订阅流量已用尽，请续费或更换订阅';
  return '节点可能失效，可在 Web UI 中切换节点 (mihomo ui)';
}

/** 流量行的着色：用尽红、>=90% 黄 */
function trafficColor(line: string, urgency: SubscriptionUrgency, total: number | undefined, upload: number | undefined, download: number | undefined): string {
  if (urgency === 'traffic-exhausted') return colors.red(line);
  if (total && total > 0) {
    const used = (upload || 0) + (download || 0);
    if (used / total >= 0.9) return colors.yellow(line);
  }
  return line;
}

/** 到期行的着色：过期红、7 天内黄 */
function expireColor(line: string, urgency: SubscriptionUrgency): string {
  if (urgency === 'expired') return colors.red(line);
  if (urgency === 'expiring') return colors.yellow(line);
  return line;
}

/** 组装 status 的机器可读快照（与文本展示同源数据） */
function buildStatusJson(args: {
  running: boolean;
  kind: 'service' | 'tun' | null;
  pid: number | null;
  probe: ProxyProbeResult | null;
  info: ReturnType<typeof getConfigInfo>;
  activeSub: ReturnType<typeof getActiveSubscription>;
  cached: ReturnType<typeof getSubscriptionsWithCache>[number] | undefined;
  overwriteEnabled: boolean;
  overwriteFiles: string[];
  service: ReturnType<typeof getServiceStatus>;
  legacy: boolean;
}): StatusJson {
  const urgency = args.cached ? subscriptionUrgency(args.cached) : null;
  return {
    version: VERSION,
    running: args.running,
    connectivity: args.probe ? { ok: args.probe.ok, statusCode: args.probe.statusCode, error: args.probe.error, durationMs: args.probe.durationMs } : null,
    mode: args.info ? (args.info.tun ? 'tun' : 'mixed') : null,
    carrier: args.kind,
    pid: args.pid,
    kernel: getKernelVersion(),
    kernelInstalled: hasKernel(),
    ports: args.info
      ? args.info.tun
        ? { tun: true, ...(args.info.mixedPort ? { mixed: args.info.mixedPort } : {}) }
        : {
            ...(args.info.mixedPort ? { mixed: args.info.mixedPort } : {}),
            ...(args.info.httpPort ? { http: args.info.httpPort } : {}),
            ...(args.info.socksPort ? { socks: args.info.socksPort } : {}),
          }
      : {},
    subscription: args.activeSub
      ? {
          name: args.activeSub.name,
          proxies: args.info?.proxies ?? 0,
          proxyGroups: args.info?.proxyGroups ?? 0,
          ...(args.cached?.upload !== undefined ? { upload: args.cached.upload } : {}),
          ...(args.cached?.download !== undefined ? { download: args.cached.download } : {}),
          ...(args.cached?.total !== undefined ? { total: args.cached.total } : {}),
          ...(args.cached?.expire !== undefined ? { expire: args.cached.expire } : {}),
          ...(args.cached?.updated_at !== undefined ? { updatedAt: args.cached.updated_at } : {}),
          stale: args.cached ? isSubscriptionStale(args.cached) : false,
          urgency,
        }
      : null,
    overwrite: { enabled: args.overwriteEnabled, files: args.overwriteFiles },
    service: {
      installed: args.service.installed,
      loaded: args.service.loaded,
      running: args.service.running,
      disabled: args.service.disabled,
      lastExitCode: args.service.lastExitCode,
      legacySystemInstall: args.legacy,
    },
  };
}

/** 全程免 sudo：launchctl print / print-disabled 均可读，pgrep/ps 亦然。 */
export async function printStatus(args: string[] = []): Promise<void> {
  assertKnownFlags(args, ['-j', '--json', '--no-probe'], 'status [--json] [--no-probe]');
  const asJson = hasFlag(args, '-j', '--json');
  const skipProbe = hasFlag(args, '--no-probe');
  // 服务状态只查一次：getRunningState 与 buildStatusJson/printServiceLines 共用，
  // 避免 getServiceStatus 内部的 launchctl print + print-disabled 重复执行
  const service = getServiceStatus();
  const state = getRunningState(service);
  const info = getConfigInfo();
  const overwriteEnabled = isOverwriteEnabled();
  const overwriteFiles = listOverwriteFile().files;
  const activeSub = getActiveSubscription();
  const cached = activeSub ? getSubscriptionsWithCache().find(s => s.name === activeSub.name) : undefined;
  const legacy = detectLegacySystemInstall();

  const { running, pid, kind } = state;

  // 连通性探测：运行中且有混合端口才发（TUN 模式下混合端口同样在监听，可作备用入口）。
  // --no-probe 跳过（脚本场景或已知不通时避免 2s 等待）
  let probe: ProxyProbeResult | null = null;
  if (running && info?.mixedPort && !skipProbe) {
    probe = await probeProxyConnectivity(info.mixedPort);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        buildStatusJson({
          running,
          kind,
          pid,
          probe,
          info,
          activeSub,
          cached,
          overwriteEnabled,
          overwriteFiles: overwriteFiles.map(f => f.name),
          service,
          legacy,
        }),
        null,
        2,
      ),
    );
    return;
  }

  const urgency = cached ? subscriptionUrgency(cached) : null;

  console.log('');
  // 模式取自配置文件：未运行时也展示上次构建的模式
  let modeLabel = '';
  if (info) {
    const mode = info.tun ? 'TUN' : 'Mixed';
    const carrier = kind === 'service' ? ' · 服务' : kind === 'tun' ? ' · 临时' : '';
    modeLabel = colors.cyan(` (${mode}${carrier})`) as string;
  }
  // 三态灯：进程在跑 ≠ 代理通。运行中但探测不通时黄灯并给归因，
  // 与「不在运行」区分开——前者最容易让用户误以为代理正常
  let statusText: string;
  if (!running) {
    statusText = colors.yellow('不在运行');
  } else if (probe && !probe.ok) {
    statusText = colors.yellow('● 运行中（代理不通）');
  } else {
    statusText = colors.green('● 运行中');
  }
  console.log(`${colors.gray('状态: ')}${statusText}${modeLabel}`);
  if (running && probe && !probe.ok) {
    console.log(colors.yellow(`  异常: ${connectivityHint(urgency)}`));
  }
  // 装着、自启开着、却没在跑且上次非 0 退出 —— 内核在被 KeepAlive 反复拉起。
  // 不提示的话这与「用户自己 stop 掉了」显示完全一样，用户无从判断为何代理不通
  if (!running && service.installed && !service.disabled && service.lastExitCode !== null && service.lastExitCode !== 0) {
    console.log(colors.yellow(`  异常: 内核上次异常退出（退出码 ${service.lastExitCode}），launchd 正在反复拉起`));
    console.log(colors.gray('  查看原因: mihomo logs 0    停止重试: mihomo stop'));
  }
  const kernelVersion = getKernelVersion();
  console.log(
    kernelVersion ? `${colors.gray('内核: ')}${kernelVersion}` : `${colors.gray('内核: ')}${colors.yellow('未安装')} ${colors.gray('(下载: mihomo kernel)')}`,
  );

  if (pid) {
    console.log(`${colors.gray('PID:  ')}${pid}`);
    if (kind === 'tun' && state.processInfo) {
      console.log(`${colors.gray('内存: ')}${state.processInfo.memory}`);
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
    // 新鲜度：服务模式下用户可能数周不跑 start（唯一的自动更新触发点），
    // 订阅陈旧是「运行中（代理不通）」的高频根因，超龄时黄标并给动作
    if (cached?.updated_at) {
      const rel = formatRelativeTime(cached.updated_at) || formatDate(cached.updated_at);
      if (isSubscriptionStale(cached)) {
        console.log(colors.yellow(`更新: ${rel}（已超过 ${resolveUpdateInterval(cached.update_interval)} 小时间隔，建议 mihomo sub update）`));
      } else {
        console.log(`${colors.gray('更新: ')}${rel}`);
      }
    }
    // 订阅流量/到期来自缓存（上次下载响应头），仅缓存里有才展示
    const traffic = cached ? formatTraffic(cached.upload, cached.download, cached.total) : null;
    if (traffic) {
      console.log(`${colors.gray('流量: ')}${trafficColor(traffic, urgency, cached?.total, cached?.upload, cached?.download)}`);
    }
    if (cached?.expire !== undefined) {
      console.log(`${colors.gray('到期: ')}${expireColor(formatTimestamp(cached.expire), urgency)}`);
    }
  } else {
    console.log(`${colors.gray('订阅: ')}未配置 ${colors.gray('(添加: mihomo sub add <url>)')}`);
  }

  if (overwriteEnabled && overwriteFiles.length > 0) {
    const names = overwriteFiles.map(f => f.name.replace(/^overwrite\.?/, '').replace(/\.ya?ml$/, '') || '主文件').join(', ');
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (${names})`);
  } else if (overwriteEnabled) {
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (无文件)`);
  } else {
    console.log(`${colors.gray('覆写: ')}${colors.yellow('已禁用')}`);
  }

  printServiceLines(service, legacy);

  console.log('');
}

function printServiceLines(service: ReturnType<typeof getServiceStatus>, legacy: boolean): void {
  if (!service.installed && !service.loaded) {
    console.log(`${colors.gray('服务: ')}${colors.yellow('未安装')} ${colors.gray('(mihomo install 安装后可用 Mixed 模式)')}`);
  } else if (!service.installed) {
    // plist 被手动删除但任务仍装载：KeepAlive 会持续拉起内核。不能报「已安装」——
    // 那与紧随其后的异常提示自相矛盾，用户无法判断到底装没装
    console.log(`${colors.gray('服务: ')}${colors.yellow('异常')} ${colors.gray('(plist 不存在，但服务仍处装载状态)')}`);
    console.log(colors.gray('  KeepAlive 会持续拉起内核，清理: mihomo uninstall'));
    printAutoStart(service);
  } else {
    console.log(`${colors.gray('服务: ')}${colors.green('已安装')}`);
    printAutoStart(service);
  }

  // 旧版本（v4.0 及更早）的 root LaunchDaemon 会与用户级服务抢端口，且用户态动不了它
  if (legacy) {
    console.log(colors.yellow('  异常: 检测到旧版本的系统级服务（root LaunchDaemon）'));
    console.log(colors.gray('  它会抢占同一组端口，清理: mihomo uninstall（需一次管理员密码）'));
  }
}

/** 自启位独立于 plist 与运行状态：stop 之后重新登录不会自动回来，这一行让用户能确认 */
function printAutoStart(service: ReturnType<typeof getServiceStatus>): void {
  const autoStart = service.disabled ? colors.yellow('已关闭') : colors.green('已开启');
  console.log(`${colors.gray('自启: ')}${autoStart}`);
}
