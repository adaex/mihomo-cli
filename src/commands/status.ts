import { assertKnownFlags, assertPositionalCount, hasFlag } from '../argv.js';
import { colors } from '../colors.js';
import { deriveRuntimeMode, getConfigInfo, getKernelVersion, hasKernel, runtimeModeLabel } from '../config.js';
import { VERSION } from '../constants.js';
import { formatDate, formatRelativeTime, formatTimestamp, formatTraffic } from '../format.js';
import { getServiceStatus } from '../launchctl.js';
import { listOverwriteFile, shortOverwriteName } from '../overwrite.js';
import { probeProxyConnectivity } from '../proxy-probe.js';
import { getRunningState } from '../runtime.js';
import { describeAbnormalExit } from '../service.js';
import { getPortsOrNull, getSubscriptionsWithCache, subscriptionUrgency } from '../settings.js';
import { formatProxySummary, getActiveSubscription, isSubscriptionStale, resolveUpdateInterval } from '../subscription.js';
import type { OverwriteFileInfo, ProxyProbeResult, StatusJson, SubscriptionUrgency } from '../types.js';

/** 运行中但代理不通时的归因提示（订阅过期/流量用尽优先，其余归到节点） */
function connectivityHint(urgency: SubscriptionUrgency): string {
  if (urgency === 'expired') return '订阅已过期，请续费或更换订阅';
  if (urgency === 'traffic-exhausted') return '订阅流量已用尽，请续费或更换订阅';
  return '节点可能失效，可在 Web UI 中切换节点 (mihomo-cli ui)';
}

/** 流量行的着色：用尽红、>=90% 黄。纯判定导出供单测（展示侧无色环境下分支不可观测） */
export function trafficColor(
  line: string,
  urgency: SubscriptionUrgency,
  total: number | undefined,
  upload: number | undefined,
  download: number | undefined,
): string {
  if (urgency === 'traffic-exhausted') return colors.red(line);
  // 手改缓存可能写入字符串：裸相加会字符串拼接（formatTraffic 同款防护），先 Number 化
  const used = Number(upload || 0) + Number(download || 0);
  if (Number.isFinite(used) && total && total > 0 && used / total >= 0.9) return colors.yellow(line);
  return line;
}

/** 到期行的着色：过期红、7 天内黄 */
function expireColor(line: string, urgency: SubscriptionUrgency): string {
  if (urgency === 'expired') return colors.red(line);
  if (urgency === 'expiring') return colors.yellow(line);
  return line;
}

/**
 * status 覆写「选中」清单的唯一谓词：文件未停用且 match 未明确不命中。
 * matched undefined（无活跃订阅或 JS 脚本）按选中算；这不是脚本实际修改配置的证据。
 * JSON applied 与文本主行共用，与合并闸门 selectActiveOverwriteFiles 平行（D7），
 * 两边判据一致但职责不同，不为复用而合并展示与构建路径。
 */
const isActiveOverwrite = (f: OverwriteFileInfo): boolean => f.enabled && f.matched !== false;

/** 组装 status 的机器可读快照（与文本展示同源数据） */
function buildStatusJson(args: {
  running: boolean;
  kind: 'service' | 'tun' | null;
  pid: number | null;
  probe: ProxyProbeResult | null;
  controllerPort: number | null;
  info: ReturnType<typeof getConfigInfo>;
  activeSub: ReturnType<typeof getActiveSubscription>;
  cached: ReturnType<typeof getSubscriptionsWithCache>[number] | undefined;
  overwriteEnabled: boolean;
  overwriteFiles: OverwriteFileInfo[];
  overwriteBroken: ReturnType<typeof listOverwriteFile>['broken'];
  service: ReturnType<typeof getServiceStatus>;
}): StatusJson {
  const urgency = args.cached ? subscriptionUrgency(args.cached) : null;
  return {
    version: VERSION,
    running: args.running,
    connectivity: args.probe,
    mode: args.info ? deriveRuntimeMode(args.info) : null,
    carrier: args.kind,
    pid: args.pid,
    kernel: getKernelVersion(),
    kernelInstalled: hasKernel(),
    ports: args.info
      ? {
          ...(args.info.mixedPort ? { mixed: args.info.mixedPort } : {}),
          ...(args.controllerPort !== null ? { controller: args.controllerPort } : {}),
          ...(args.info.tun ? { tun: true } : {}),
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
    overwrite: {
      enabled: args.overwriteEnabled,
      // 全局关闭时 buildConfig 不加载任何覆写，applied 必须为空；只滤文件 enabled/match
      // 会与同一份 JSON 里的 overwrite.enabled:false 自相矛盾
      applied: args.overwriteEnabled ? args.overwriteFiles.filter(isActiveOverwrite).map(f => f.name) : [],
      // 加载失败的文件不属于 applied（既没合并也无法判 enabled/match），单列 errors。
      // hint 必须带出：最有用的迁移指引（已移除操作符改 JS、*edu 加引号等）都在里面，
      // 只给 message 等于把可执行的修复步骤扔在启动硬失败那一条路径上
      errors: args.overwriteBroken.map(b => ({ name: b.name, message: b.message, hint: b.hint })),
    },
    service: {
      installed: args.service.installed,
      loaded: args.service.loaded,
      running: args.service.running,
      disabled: args.service.disabled,
      lastExitCode: args.service.lastExitCode,
      lastTerminatingSignal: args.service.lastTerminatingSignal,
    },
  };
}

/** 全程免 sudo：launchctl print / print-disabled 均可读，pgrep/ps 亦然。 */
export async function printStatus(args: string[] = []): Promise<void> {
  assertKnownFlags(args, ['-j', '--json', '--no-probe'], 'status [--json] [--no-probe]');
  assertPositionalCount(args, 0, 1, 'mihomo-cli status [-j|--json] [--no-probe]');
  const asJson = hasFlag(args, '-j', '--json');
  const skipProbe = hasFlag(args, '--no-probe');
  // 服务状态只查一次：getRunningState 与 buildStatusJson/printServiceLines 共用，
  // 避免 getServiceStatus 内部的 launchctl print + print-disabled 重复执行
  const service = getServiceStatus();
  const state = getRunningState(service);
  const info = getConfigInfo();
  const activeSub = getActiveSubscription();
  // 带上活跃订阅的作用域：status 与 `ow` 列表不同，它知道当前订阅是谁，因而能判 match。
  // 不判的话，只对别的订阅生效的文件会混在「已启用」里，看着像正在生效
  const {
    enabled: overwriteEnabled,
    files: overwriteFiles,
    broken: overwriteBroken,
  } = listOverwriteFile(activeSub ? { subName: activeSub.name, subUrl: activeSub.url } : undefined);
  const cached = activeSub ? getSubscriptionsWithCache().find(s => s.name === activeSub.name) : undefined;
  // 控制器端口在 settings 非法时不应让整个 status 崩掉（doctor 另有一项专查非法 ports）
  const controllerPort = getPortsOrNull()?.controller ?? null;

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
          controllerPort,
          info,
          activeSub,
          cached,
          overwriteEnabled,
          overwriteFiles,
          overwriteBroken,
          service,
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
    // 模式判据统一走 deriveRuntimeMode（与 JSON 输出同源），不再手写 info.tun 三元
    const mode = runtimeModeLabel(deriveRuntimeMode(info));
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
  // 装着、自启开着、却没在跑且上次异常退出 —— 内核在被 KeepAlive 反复拉起。
  // 不提示的话这与「用户自己 stop 掉了」显示完全一样，用户无从判断为何代理不通。
  // 判据经 describeAbnormalExit 收口：信号死亡（kill -9/OOM）不写 last exit code，
  // 只看退出码会让这类崩溃完全无提示
  const abnormalExit = describeAbnormalExit(service);
  if (!running && service.installed && !service.disabled && abnormalExit) {
    console.log(colors.yellow(`  异常: 内核上次异常退出（${abnormalExit}），launchd 正在反复拉起`));
    console.log(colors.gray('  查看原因: mihomo-cli logs 0    停止重试: mihomo-cli stop'));
  }
  const kernelVersion = getKernelVersion();
  console.log(
    kernelVersion
      ? `${colors.gray('内核: ')}${kernelVersion}`
      : `${colors.gray('内核: ')}${colors.yellow('未安装')} ${colors.gray('(下载: mihomo-cli kernel)')}`,
  );

  if (pid) {
    console.log(`${colors.gray('PID:  ')}${pid}`);
    if (kind === 'tun' && state.memory) {
      console.log(`${colors.gray('内存: ')}${state.memory}`);
    }
  }

  if (info) {
    // 控制器口一并展示：改过 ports.controller 后，托管 UI 默认连 9090 必然连不上，
    // 只读界面必须能看到实际端口（README 承诺「status 会显示实际端口」）
    const controllerSuffix = controllerPort !== null ? `，控制器 ${controllerPort}` : '';
    if (info.tun) {
      // TUN 模式由虚拟网卡接管全局流量；mixed-port 仍在监听可作备用入口，一并标注
      const extra = info.mixedPort ? `，混合端口 ${info.mixedPort}` : '';
      console.log(`${colors.gray('端口: ')}TUN 接管${extra}${controllerSuffix}`);
    } else if (info.mixedPort) {
      console.log(`${colors.gray('端口: ')}${info.mixedPort}${controllerSuffix}`);
    } else {
      console.log(`${colors.gray('端口: ')}未知${controllerSuffix}`);
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
        console.log(colors.yellow(`更新: ${rel}（已超过 ${resolveUpdateInterval(cached.update_interval)} 小时间隔，建议 mihomo-cli sub update）`));
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
    console.log(`${colors.gray('订阅: ')}未配置 ${colors.gray('(添加: mihomo-cli sub add <url>)')}`);
  }

  printOverwriteLines(overwriteEnabled, overwriteFiles, overwriteBroken);

  printServiceLines(service);

  // TUN 是临时 root 进程且不随终端退出消失，每次查看状态都提醒怎么收掉
  if (kind === 'tun') {
    console.log(colors.gray('TUN 为临时进程；停止: mihomo-cli stop（之后 mihomo-cli start 恢复 Mixed）'));
  }

  console.log('');
}

/**
 * 覆写展示：主行只列选中的文件；未选中的分「不适用」（YAML match 不命中当前订阅）
 * 与「已禁用」（文件内 enabled:false）分别计数。matched undefined（无活跃订阅/脚本）
 * 按选中处理；启用脚本被列入不代表实际修改了配置。
 */
function printOverwriteLines(enabled: boolean, files: OverwriteFileInfo[], broken: ReturnType<typeof listOverwriteFile>['broken']): void {
  if (!enabled) {
    console.log(`${colors.gray('覆写: ')}${colors.yellow('已禁用')}`);
    return;
  }

  const active = files.filter(isActiveOverwrite);
  const unmatchedCount = files.filter(f => f.enabled && f.matched === false).length;
  const disabledCount = files.filter(f => !f.enabled).length;

  // 两类未选中各自成句，都挂在主行的括号里；主行只列选中的文件
  const suffixes: string[] = [];
  if (unmatchedCount > 0) suffixes.push(`${unmatchedCount} 个不适用`);
  if (disabledCount > 0) suffixes.push(`${disabledCount} 个已禁用`);
  const suffix = suffixes.length > 0 ? `，${suffixes.join('，')}` : '';

  if (active.length > 0) {
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (${active.map(f => shortOverwriteName(f.name)).join(', ')}${suffix})`);
  } else {
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (${files.length > 0 ? `无选中文件${suffix}` : '无文件'})`);
  }

  // 加载失败的文件不参与任何分类，红字给出原因、灰字给出修复指引；
  // start 会硬失败，这里负责让原因与指引在自查界面就可见（不用先撞一次启动）
  for (const b of broken) {
    console.log(colors.red(`  ${b.message}`));
    for (const line of b.hint) console.log(colors.gray(`  ${line}`));
  }
}

function printServiceLines(service: ReturnType<typeof getServiceStatus>): void {
  if (!service.installed && !service.loaded) {
    console.log(`${colors.gray('服务: ')}${colors.yellow('未安装')} ${colors.gray('(mihomo-cli install 安装后可用 Mixed 模式)')}`);
  } else if (!service.installed) {
    // plist 被手动删除但任务仍装载：KeepAlive 会持续拉起内核。不能报「已安装」——
    // 那与紧随其后的异常提示自相矛盾，用户无法判断到底装没装
    console.log(`${colors.gray('服务: ')}${colors.yellow('异常')} ${colors.gray('(plist 不存在，但服务仍处装载状态)')}`);
    console.log(colors.gray('  KeepAlive 会持续拉起内核，清理: mihomo-cli uninstall'));
    printAutoStart(service);
  } else {
    console.log(`${colors.gray('服务: ')}${colors.green('已安装')}`);
    printAutoStart(service);
  }
}

/** 自启位独立于 plist 与运行状态：stop 之后重新登录不会自动回来，这一行让用户能确认 */
function printAutoStart(service: ReturnType<typeof getServiceStatus>): void {
  const autoStart = service.disabled ? colors.yellow('已关闭') : colors.green('已开启');
  console.log(`${colors.gray('自启: ')}${autoStart}`);
}
