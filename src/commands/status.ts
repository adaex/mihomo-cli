import { assertKnownFlags, assertPositionalCount, hasFlag } from '../argv.js';
import { colors } from '../colors.js';
import { deriveRuntimeMode, getConfigInfo, getKernelVersion, hasKernel, judgeScriptMatches, runtimeModeLabel } from '../config.js';
import { VERSION } from '../constants.js';
import { formatDate, formatRelativeTime, formatTimestamp, formatTraffic } from '../format.js';
import { listOverwriteFile, shortOverwriteName } from '../overwrite.js';
import { probeProxyConnectivity } from '../proxy-probe.js';
import { getRunningState } from '../runtime.js';
import { describeAbnormalExit, detectLegacySystemInstall, getServiceStatus } from '../service.js';
import { getPortsOrNull, getSubscriptionsWithCache, readSubscriptionRawConfig, subscriptionUrgency } from '../settings.js';
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
 * 「本次真正生效的覆写文件」的唯一谓词：文件未被停用且 match 命中（matched 不是
 * 显式 false；undefined＝无法判定，按生效算）。JSON 的 applied 与文本主行共用——
 * 同一份命令输出的两个面不许各抄一份过滤式。注意这是**展示判定**，与合并闸门
 * selectActiveOverwriteFiles 的平行是 D7 的刻意设计，不要互相收拢
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
  legacy: boolean;
}): StatusJson {
  const urgency = args.cached ? subscriptionUrgency(args.cached) : null;
  return {
    version: VERSION,
    running: args.running,
    connectivity: args.probe ? { ok: args.probe.ok, statusCode: args.probe.statusCode, error: args.probe.error, durationMs: args.probe.durationMs } : null,
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
      files: args.overwriteFiles.filter(f => f.enabled).map(f => f.name),
      // 全局关闭时 buildConfig 不加载任何覆写，applied 必须空——只滤 enabled/match
      // 会列出「生效文件」，与同一份 JSON 里的 enabled:false 自相矛盾
      applied: args.overwriteEnabled ? args.overwriteFiles.filter(isActiveOverwrite).map(f => f.name) : [],
      // 加载失败的文件不属于 files/applied（既没合并也无法判 enabled/match），单列 errors。
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
      legacySystemInstall: args.legacy,
    },
  };
}

/** 全程免 sudo：launchctl print / print-disabled 均可读，pgrep/ps 亦然。 */
export async function printStatus(args: string[] = []): Promise<void> {
  assertKnownFlags(args, ['-j', '--json', '--no-probe'], 'status [--json] [--no-probe]');
  // 不接受位置参数：`status garbage` 此前被静默忽略
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
    entries: overwriteEntries,
    broken: overwriteBroken,
  } = listOverwriteFile(activeSub ? { subName: activeSub.name, subUrl: activeSub.url } : undefined);
  // 脚本没有 match 声明，静态判不了命中；有活跃订阅且目录里有脚本时，用订阅缓存
  // 正文跑一遍判定（judgeScriptMatches：复用上面同一次读目录的 entries、坏文件
  // 不抛——D7 判定旁路；无脚本时跳过，不为空判定白跑一次订阅解析）。无缓存/
  // 解析失败按「未判定」处理（matched 留 undefined，与无订阅时的语义一致）。
  // 手改 settings.json 写入非法订阅名时 readSubscriptionRawConfig 的路径防御会抛
  // CliError——富化是展示附加信息，不能让它击穿整个 status（doctor 同款姿态，
  // 坏状态留给专门的检查项去报），按「未判定」跳过
  if (activeSub && overwriteEnabled && overwriteFiles.some(f => f.kind === 'script')) {
    try {
      const rawContent = readSubscriptionRawConfig(activeSub.name);
      if (rawContent) {
        const { matches } = judgeScriptMatches(rawContent, deriveRuntimeMode(info), { subName: activeSub.name, subUrl: activeSub.url }, overwriteEntries);
        const matchedByName = new Map(matches.map(m => [m.file, m.matched]));
        for (const f of overwriteFiles) {
          if (f.kind === 'script' && matchedByName.has(f.name)) f.matched = matchedByName.get(f.name);
        }
      }
    } catch {
      /* 富化失败按未判定处理，不拦 status */
    }
  }
  const cached = activeSub ? getSubscriptionsWithCache().find(s => s.name === activeSub.name) : undefined;
  const legacy = detectLegacySystemInstall();
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
          // 两个数组在 buildStatusJson 里分出来：files 仍是旧契约（只滤文件级 enabled，
          // 不按 match、不随全局开关变空），applied 才是本次真正参与合并的
          overwriteFiles,
          overwriteBroken,
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
    if (kind === 'tun' && state.processInfo) {
      console.log(`${colors.gray('内存: ')}${state.processInfo.memory}`);
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

  printServiceLines(service, legacy);

  // TUN 是临时 root 进程且不随终端退出消失，每次查看状态都提醒怎么收掉
  if (kind === 'tun') {
    console.log(colors.gray('TUN 为临时进程；停止: mihomo-cli stop（之后 mihomo-cli start 恢复 Mixed）'));
  }

  console.log('');
}

/**
 * 覆写展示：主行只列**本次真正生效**的文件，未生效的分两类各折一句计数。
 *
 * 分两类而不是一句「已启用 (a, b)」：文件躺在目录里、没被 enabled:false 停用、
 * 却因 match 不命中当前订阅而完全没参与合并——这种文件混在主行里，看起来和生效的
 * 一模一样，用户会拿它解释自己看到的行为（「我明明覆写了」），排查方向整个跑偏。
 * 两类失效原因不同、操作也不同（停用的要改文件里的 enabled，未命中的要看作用域或
 * 切订阅），故不合并成一个计数。
 *
 * 两类都只计数、不逐行点名：不命中/停用是常态而非故障，逐行展开每次刷屏；
 * 想知道是哪个文件、作用域是什么，`ow` 列表有完整信息（含改法提示）。
 *
 * matched 为 undefined（无活跃订阅、没法判 match）时按「未被排除」处理：此时
 * 连订阅都没有，覆写本就无从谈起，不值得再分一类。
 */
function printOverwriteLines(enabled: boolean, files: OverwriteFileInfo[], broken: ReturnType<typeof listOverwriteFile>['broken']): void {
  if (!enabled) {
    console.log(`${colors.gray('覆写: ')}${colors.yellow('已禁用')}`);
    return;
  }

  const active = files.filter(isActiveOverwrite);
  const unmatchedCount = files.filter(f => f.enabled && f.matched === false).length;
  const disabledCount = files.filter(f => !f.enabled).length;

  // 两类失效各自成句，都挂在主行的括号里；主行永远只说生效的那些
  const suffixes: string[] = [];
  if (unmatchedCount > 0) suffixes.push(`${unmatchedCount} 个不适用`);
  if (disabledCount > 0) suffixes.push(`${disabledCount} 个已禁用`);
  const suffix = suffixes.length > 0 ? `，${suffixes.join('，')}` : '';

  if (active.length > 0) {
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (${active.map(f => shortOverwriteName(f.name)).join(', ')}${suffix})`);
  } else {
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (${files.length > 0 ? `无生效文件${suffix}` : '无文件'})`);
  }

  // 加载失败的文件不参与任何分类，红字给出原因、灰字给出修复指引；
  // start 会硬失败，这里负责让原因与指引在自查界面就可见（不用先撞一次启动）
  for (const b of broken) {
    console.log(colors.red(`  ${b.message}`));
    for (const line of b.hint) console.log(colors.gray(`  ${line}`));
  }
}

function printServiceLines(service: ReturnType<typeof getServiceStatus>, legacy: boolean): void {
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

  // 旧版本（v4.0 及更早）的 root LaunchDaemon 会与用户级服务抢端口，且用户态动不了它（D1）
  if (legacy) {
    console.log(colors.yellow('  异常: 检测到旧版本的系统级服务（root LaunchDaemon）'));
    console.log(colors.gray('  它会抢占同一组端口，清理: mihomo-cli uninstall（需一次管理员密码）'));
  }
}

/** 自启位独立于 plist 与运行状态：stop 之后重新登录不会自动回来，这一行让用户能确认 */
function printAutoStart(service: ReturnType<typeof getServiceStatus>): void {
  const autoStart = service.disabled ? colors.yellow('已关闭') : colors.green('已开启');
  console.log(`${colors.gray('自启: ')}${autoStart}`);
}
