import fs from 'node:fs';

import { compareVersions } from 'compare-versions';
import { assertKnownFlags, assertPositionalCount } from '../argv.js';
import { colors } from '../colors.js';
import { deriveRuntimeMode, getConfigInfo, getKernelVersion, hasKernel, probeKernelVersion } from '../config.js';
import { DEFAULT_MIXED_PORT, VERSION } from '../constants.js';
import { CliError } from '../errors.js';
import { formatDate, formatRelativeTime } from '../format.js';
import { checkUpdate, hasGh, resolveReleaseQuery } from '../kernel.js';
import { KERNEL_SELF_BACKUP_DIR, KERNEL_SELF_UPDATE_DIR, PATHS, USER_DATA_DIR } from '../paths.js';
import { lsofListenPids, probeProxyConnectivity } from '../proxy-probe.js';
import { getRunningState } from '../runtime.js';
import { describeAbnormalExit, detectLegacySystemInstall, getServiceStatus } from '../service.js';
import { getMixedPortOrNull, getPorts, getSubscriptionsWithCache, isValidSettingsContent, requireSubscriptionRawConfig } from '../settings.js';
import { getActiveSubscription, isSubscriptionStale, prepareConfigForStart, resolveUpdateInterval } from '../subscription.js';
import type { KernelUpdateInfo } from '../types.js';
import { getLatestNpmVersion } from './update.js';

/** 限时等待：GitHub 查询在 doctor 里只给数秒，超时按「不可达」降级为 skip，不拖慢体检。
 * 用 AbortSignal 而非单纯弃掉 promise：弃置后子进程的 stdio 管道仍占住事件循环，
 * 报告打完后进程要等满子进程自身超时（curl --max-time 120s）才退——abort 会把
 * 子进程一并杀掉（checkUpdate 把 signal 透传给 gh/curl/直连三路）。
 * 刻意不叫 withTimeout：errors.ts 有同名函数接 Promise（无 AbortSignal 语义），
 * 同名异构是搬运陷阱——误用 errors 版会丢 abort，恰是本函数存在的理由 */
function withAbortableTimeout<T>(promise: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return promise(controller.signal).finally(() => clearTimeout(timer));
}

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
  /** 失败详情（如内核原文与本次生效的覆写清单）。行自带缩进，原样打印即挂在该项之下 */
  notes?: string[];
}

/** 端口是否有进程在监听（lsof；查不到/无 lsof 都按「未监听」处理，不夸大也不吓人） */
function isPortListening(port: number): boolean {
  return (lsofListenPids(port)?.length ?? 0) > 0;
}

async function collectChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const push = (name: string, status: CheckStatus, detail: string, fix?: string, notes?: string[]): void => {
    checks.push({ name, status, detail, fix, notes });
  };

  // npm registry 查询**先发起、最后 await**：它是纯网络往返（实测约 780ms），而 doctor
  // 其余全部本地检查加起来才约 75ms（无内核）到约 300ms（装了内核，含 `-t` 原生校验）——
  // 串在末尾就是让这段网络等待白占墙钟时间。它不依赖任何前面的结果（只与 VERSION 常量
  // 比对），故可与本地检查重叠。实测装了内核时 1070ms → 837ms（省 22%）；没装内核时
  // 本地部分太短，只省约 47ms，此时耗时下界就是 npm 查询本身。
  //
  // 尾随的 `.catch` 是**纵深防御，当前不承载行为**：promise 提前创建、await 推迟到函数
  // 末尾，中间任一 push 路径若抛错（如订阅名非法时 requireSubscriptionRawConfig 抛 CliError），
  // 这个 promise 就没人 await 了——真 reject 的话会被 index.ts 的 unhandledRejection
  // 处理器捕获、以退出码 1 终止，体检在报出真正的问题之前先崩掉。实测目前不会发生：
  // getLatestNpmVersion 自身 try/catch 吞掉一切并返回 null，摘掉这个 catch 行为不变
  // （已反向验证）。留着是因为一旦它的契约改成抛错，缺这层就会退化成「doctor 偶发崩溃」，
  // 而那种失败只在「另有检查项先抛错」时出现，极难复现。
  const latestVersionPromise = getLatestNpmVersion(4_000).catch(() => null);

  // 内核版本同样在开头并行发起：查询出网与 mihomo-cli kernel 同口径——代理在跑直接经代理，
  // 没跑才走 gh 认证（免未认证限流）。gh 不能优先于在跑的代理：gh 直连被墙时会挂到自身
  // 超时，4s 的体检预算被耗干，「内核版本 ok」退化成 skip，还拖住进程退出（子进程句柄）。
  // 4s 超时/失败一律降级 skip——体检不该被 registry 之外再多一个网络故障拖红。
  // 与 npm 项并列后，「CLI 与内核各有一条更新线、该更新哪个」不再需要用户自己记
  //
  // 服务状态与内核 -v 各只探测一次：earlyService/earlyState/kernelProbe 贯穿全函数
  // （服务/端口/内核各检查段之间没有任何 await，重复探测结论必然一致）；checkUpdate
  // 复用同一份 probe 结果，不再自行 spawn
  const earlyService = getServiceStatus();
  const earlyState = getRunningState(earlyService);
  // 端口只用于选通道：settings.ports 损坏时降级为「不探测本机代理」（getMixedPortOrNull），
  // 非法值由下方「端口配置」检查项单独报出
  const kernelProxyPort = earlyState.running ? getMixedPortOrNull() : null;
  const kernelProbe = hasKernel() ? probeKernelVersion() : null;
  // 版本查询出网与 mihomo-cli kernel 同口径（代理在跑直接经代理、无代理才 gh 认证），
  // 决策走 kernel.resolveReleaseQuery 唯一出口——doctor 无 --mirror/--proxy，按无覆盖传入。
  // gh 只在无代理时探测（同 kernel.ghProbeNeeded 的省探测守卫：代理在跑时查询必不经 gh）
  const releaseQuery = resolveReleaseQuery({
    mirror: null,
    isOverride: false,
    ghAvailable: kernelProxyPort === null && hasGh(),
    proxyRunning: earlyState.running,
    proxyPort: kernelProxyPort,
    proxyOverride: null,
  });
  const kernelVersionPromise: Promise<KernelUpdateInfo | null> = kernelProbe
    ? withAbortableTimeout(
        signal =>
          checkUpdate({
            proxy: releaseQuery.proxy,
            useGh: releaseQuery.useGh,
            signal,
            currentVersion: getKernelVersion(kernelProbe),
          }),
        4_000,
      ).catch(() => null)
    : Promise.resolve(null);

  // === 内核 ===
  if (!kernelProbe) {
    push('内核', 'fail', '未安装', 'mihomo-cli kernel');
  } else if (kernelProbe.status === 0 && kernelProbe.version !== null) {
    push('内核', 'ok', getKernelVersion(kernelProbe) || '可执行');
  } else if (kernelProbe.spawnError) {
    push('内核', 'fail', `二进制无法执行（${kernelProbe.spawnError.message}）`, '重新下载: mihomo-cli kernel');
  } else {
    push('内核', 'fail', `二进制无法执行（退出码 ${kernelProbe.status}）`, '重新下载: mihomo-cli kernel');
  }

  // === 内核面板自升级目录 ===
  // 两个目录性质不同，不能合并成一条「残留」告警（上游 update_core.go 已核对）：
  // - meta-update 是下载暂存，updater defer 清理——存在即升级被异常中断，真残留，warn
  // - meta-backup 是旧内核副本，成功路径**从不清理**（有意保留供回滚，每次升级覆盖写），
  //   面板升级成功一次它就常在——按残留 warn 等于永久误报，会训练用户无视 doctor 告警；
  //   归为信息项，删除口径写进 detail（ok 项不渲染 fix/notes），且绝不与暂存共用一条 rm -rf
  if (fs.existsSync(KERNEL_SELF_UPDATE_DIR)) {
    push('内核自升级残留', 'warn', `中断的下载暂存: ${KERNEL_SELF_UPDATE_DIR}`, `rm -rf ${KERNEL_SELF_UPDATE_DIR}`);
  }
  if (fs.existsSync(KERNEL_SELF_BACKUP_DIR)) {
    push('内核自升级备份', 'ok', `旧内核副本（面板升级自动保留，供回滚；确认新版稳定后可删: rm -rf ${KERNEL_SELF_BACKUP_DIR}）`);
  }

  // === 数据目录 ===
  try {
    fs.accessSync(USER_DATA_DIR, fs.constants.W_OK);
    push('数据目录', 'ok', USER_DATA_DIR);
  } catch {
    push('数据目录', 'fail', `不可写: ${USER_DATA_DIR}`, '检查目录权限');
  }

  // === settings.json ===
  if (fs.existsSync(PATHS.settingsFile)) {
    if (isValidSettingsContent(fs.readFileSync(PATHS.settingsFile, 'utf8'))) {
      push('设置文件', 'ok', '格式有效');
    } else {
      push('设置文件', 'warn', '格式损坏或非对象，读取时会回退默认并备份为 .bak', '删除或修复 settings.json');
    }
  } else {
    push('设置文件', 'ok', '未创建（使用默认设置）');
  }

  // === 订阅 ===
  const subs = getSubscriptionsWithCache();
  const active = getActiveSubscription();
  if (subs.length === 0) {
    push('订阅', 'warn', '未配置', 'mihomo-cli sub add <url>');
  } else {
    push('订阅', 'ok', `${subs.length} 个${active ? `，当前: ${active.name}` : ''}`);
    if (active) {
      // 名称非法（手改 settings.json 写入路径形态等）或条目在而本地文件没了，
      // 都由 requireSubscriptionRawConfig 抛 CliError——体检是诊断面，不能被坏状态
      // 击穿（同列表面板的姿态），包成 fail 检查项继续；fix 直接取错误自带的指引
      try {
        requireSubscriptionRawConfig(active.name);
        push('订阅配置', 'ok', `"${active.name}" 配置文件存在`);
      } catch (e) {
        const err = e as CliError;
        push('订阅配置', 'fail', err.message, err.hint[0] ?? '手工修正 settings.json 中的订阅名后重试');
      }
      // 缓存新鲜度：超过更新间隔未更新 → 提醒（不判失败，start 会自动更新）
      const cached = subs.find(s => s.name === active.name);
      if (cached?.updated_at) {
        const rel = formatRelativeTime(cached.updated_at);
        if (isSubscriptionStale(cached)) {
          // stale 判据要求 updated_at 不晚于当前时间，此时 rel 必非 null（?? 仅为类型兜底）
          push('订阅新鲜度', 'warn', `${rel ?? '未知'}更新，已超过 ${resolveUpdateInterval(cached.update_interval)} 小时间隔`, 'mihomo-cli sub update');
        } else {
          // rel 为 null 只可能是未来/非法时间戳（时钟偏移或缓存被手改），如实标注
          push('订阅新鲜度', 'ok', rel ? `${rel}更新` : `更新时间记录异常（${formatDate(cached.updated_at)}）`);
        }
      }
    }
  }

  // === 服务 ===
  const service = earlyService;
  const legacy = detectLegacySystemInstall();
  if (legacy) {
    push('服务', 'fail', '检测到旧版本的系统级服务（root LaunchDaemon），会抢占端口', 'mihomo-cli uninstall（需一次管理员密码）');
  } else if (!service.installed && !service.loaded) {
    push('服务', 'warn', '未安装（Mixed 模式需要）', 'mihomo-cli install');
  } else if (!service.installed) {
    push('服务', 'fail', 'plist 不存在但任务仍装载，KeepAlive 会持续拉起内核', 'mihomo-cli uninstall');
  } else if (service.running) {
    const abnormalExit = describeAbnormalExit(service);
    push('服务', 'ok', `运行中${service.disabled ? '（自启已关闭）' : ''}${abnormalExit ? `，上次异常退出（${abnormalExit}）` : ''}`);
    if (abnormalExit) {
      push('服务稳定性', 'warn', `内核上次异常退出（${abnormalExit}）`, 'mihomo-cli logs 0 查看原因');
    }
  } else {
    // installed && !running：装着、自启开着、却没在跑且上次异常退出 —— 内核在被
    // KeepAlive 反复拉起。与「用户主动 stop」（disabled）区分开，前者是崩溃循环，必须醒目告警。
    // 判据经 describeAbnormalExit 收口，信号死亡（不写 last exit code）同样能检出
    const abnormalExit = describeAbnormalExit(service);
    if (!service.disabled && abnormalExit) {
      push('服务', 'fail', `内核上次异常退出（${abnormalExit}），launchd 正在反复拉起`, 'mihomo-cli logs 0 查看原因，mihomo-cli stop 停止重试');
    } else {
      push('服务', 'ok', `已安装，未运行${service.disabled ? '（自启已关闭）' : ''}`);
    }
  }

  // === 端口 ===
  // getPorts 对非法 ports 抛错：转成检查项（fail），不能让整个体检崩在半路。
  // 兜底用默认端口继续查——配置非法已单独报出，端口检查项用默认值不产生误导
  const state = earlyState;
  const info = getConfigInfo();
  // 连通性探测（经代理 curl gstatic，不通时固定等满 2s）与下方配置原生校验（mihomo -t，
  // 可达数百 ms、超时 30s）互不依赖，需要的 state/info 此刻已齐——先发起、到连通性段
  // 再 await，让两段网络/子进程等待重叠，代理不通时少等约 2s。push 顺序不变，展示顺序不变。
  // probeProxyConnectivity 全 try/catch 永不 reject（与上方 npm promise 的防御同构），
  // 提前发起无 unhandled rejection 风险；其内部还有 3s 结果缓存，不会重复发请求
  const connectivityPromise = state.running && info?.mixedPort ? probeProxyConnectivity(info.mixedPort) : null;
  let mixedPortDefault = DEFAULT_MIXED_PORT;
  try {
    const ports = getPorts();
    mixedPortDefault = ports.mixed;
  } catch (e) {
    push('端口配置', 'fail', (e as Error).message, '修正 settings.json 的 ports（1-65535 整数，mixed 与 controller 不能相同）');
  }
  const mixedPort = info?.mixedPort ?? mixedPortDefault;
  if (state.running) {
    if (isPortListening(mixedPort)) {
      push('端口', 'ok', `${mixedPort} 正在监听`);
    } else {
      push('端口', 'fail', `内核在跑但 ${mixedPort} 未监听`, 'mihomo-cli logs 0 查看原因');
    }
  } else if (isPortListening(mixedPort)) {
    push('端口', 'warn', `${mixedPort} 被其他进程占用，start 会失败`, `lsof -nP -iTCP:${mixedPort} 查看占用者`);
  } else {
    push('端口', 'ok', `${mixedPort} 空闲`);
  }

  // === 配置原生校验 ===
  if (active && hasKernel()) {
    try {
      const mode = deriveRuntimeMode(info);
      const prepared = await prepareConfigForStart(mode, active.name);
      const warnings = prepared.buildResult.warnings;
      if (warnings.length > 0) {
        // 内核校验是通过的，不升为 fail；但 warnings 是「配置没按用户预期生效」的信号
        // （~? 补丁未命中被跳过、TUN 强制开 DNS），丢掉的话体检反而成了盲区。逐条挂
        // notes，缩进沿用 hint 的样式；措辞强调校验已过，提示不等于失败
        push(
          '配置构建',
          'warn',
          `当前订阅通过内核校验（${mode}），另有 ${warnings.length} 条配置提示`,
          undefined,
          warnings.map(w => `  ${w}`),
        );
      } else {
        push('配置构建', 'ok', `当前订阅通过内核校验（${mode}）`);
      }
    } catch (e) {
      // hint 带着内核原文与本次生效的覆写清单；只取 message 首行会把唯一有用的线索丢掉
      // （体检是紧凑列表，滤掉纯排版空行）
      const notes = e instanceof CliError ? e.hint.filter(l => l.trim().length > 0) : undefined;
      push('配置构建', 'fail', (e as Error).message.split('\n')[0], '修正订阅或覆写后 mihomo-cli start', notes);
    }
  } else {
    push('配置构建', 'skip', active ? '未安装内核，跳过校验' : '无订阅，跳过');
  }

  // === 连通性 ===
  // 探测在端口段之前已发起（见 connectivityPromise），此处收口
  if (connectivityPromise) {
    const probe = await connectivityPromise;
    if (probe.ok) {
      push('代理连通', 'ok', `HTTP ${probe.statusCode}（${probe.durationMs}ms）`);
    } else {
      push('代理连通', 'warn', `不通: ${probe.error}`, '节点可能失效，mihomo-cli ui 切换节点');
    }
  } else {
    push('代理连通', 'skip', '未运行');
  }

  // === 内核版本 ===
  // 与 CLI 版本同结构：查询在函数开头发起、此处收口。未装内核时「内核」项已 fail，
  // 不再重复列版本；GitHub 不可达/超时 skip（内核更新不是本机体检能解决的问题）
  const kernelInfo = await kernelVersionPromise;
  if (hasKernel() && kernelInfo === null) {
    push('内核版本', 'skip', 'GitHub 不可达，跳过检查');
  } else if (kernelInfo?.needsUpdate) {
    push('内核版本', 'warn', `当前 ${kernelInfo.current}，最新 ${kernelInfo.latest}`, 'mihomo-cli kernel');
  } else if (kernelInfo) {
    push('内核版本', 'ok', `${kernelInfo.current}（最新）`);
  }

  // === CLI 版本 ===
  // 查询在本函数开头就已发起（与本地检查重叠），这里只取结果。
  // 短超时 + 失败 skip：registry 不可达很常见（国内网络），体检不该因此多红一项；
  // 用 compareVersions 判方向，本地比 latest 新（dev 链接/beta）不告警
  const latest = await latestVersionPromise;
  if (latest === null) {
    push('CLI 版本', 'skip', 'npm registry 不可达，跳过检查');
  } else {
    // 非 semver 的 latest（私有 registry、异常 npm 输出）按 skip 渲染，不击穿体检——
    // update.ts 的 resolveUpdateAction 有同款 try/catch，两侧口径一致
    try {
      if (compareVersions(latest, VERSION) > 0) {
        push('CLI 版本', 'warn', `当前 ${VERSION}，最新 ${latest}`, 'mihomo-cli update');
      } else {
        push('CLI 版本', 'ok', `${VERSION}（最新）`);
      }
    } catch {
      push('CLI 版本', 'skip', `最新版本号无法比较（${latest}），跳过检查`);
    }
  }

  return checks;
}

export async function cmdDoctor(args: string[] = []): Promise<void> {
  assertKnownFlags(args.slice(1), [], 'doctor');
  // 不接受位置参数：校验先于探测/网络等慢速副作用
  assertPositionalCount(args, 0, 1, 'mihomo-cli doctor');
  const checks = await collectChecks();

  console.log('');
  for (const c of checks) {
    const mark = c.status === 'ok' ? colors.green('✓') : c.status === 'warn' ? colors.yellow('!') : c.status === 'fail' ? colors.red('✗') : colors.gray('·');
    console.log(`${mark} ${colors.bold(c.name)}: ${c.detail}`);
    if (c.status !== 'ok' && c.status !== 'skip') {
      for (const line of c.notes ?? []) console.log(colors.gray(line));
      if (c.fix) console.log(colors.gray(`  修复: ${c.fix}`));
    }
  }

  const ok = checks.filter(c => c.status === 'ok').length;
  const warn = checks.filter(c => c.status === 'warn').length;
  const fail = checks.filter(c => c.status === 'fail').length;
  const skip = checks.filter(c => c.status === 'skip').length;
  console.log('');
  console.log(`体检完成: ${ok} 项正常，${warn} 项警告，${fail} 项异常${skip > 0 ? `，${skip} 项跳过` : ''}`);
  console.log('');

  if (fail > 0) {
    throw new CliError(`发现 ${fail} 项异常`, {
      label: '体检未通过',
      hint: checks.filter(c => c.status === 'fail' && c.fix).map(c => `${c.name}: ${c.fix}`),
    });
  }
}
