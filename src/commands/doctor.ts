import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { compareVersions } from 'compare-versions';

import { colors } from '../colors.js';
import { getConfigInfo, getKernelVersion, hasKernel } from '../config.js';
import { DEFAULT_MIXED_PORT, VERSION } from '../constants.js';
import { CliError } from '../errors.js';
import { checkUpdate } from '../kernel.js';
import { PATHS, USER_DATA_DIR } from '../paths.js';
import { probeProxyConnectivity } from '../proxy-probe.js';
import { getRunningState } from '../runtime.js';
import { describeAbnormalExit, detectLegacySystemInstall, getServiceStatus } from '../service.js';
import { getPorts, getSubscriptionsWithCache, isValidSettingsContent, readSubscriptionRawConfig } from '../settings.js';
import { getActiveSubscription, isSubscriptionStale, prepareConfigForStart, resolveUpdateInterval } from '../subscription.js';
import type { KernelUpdateInfo } from '../types.js';
import { assertKnownFlags, assertPositionalCount, formatRelativeTime } from '../utils.js';
import { getLatestNpmVersion } from './update.js';

/** 限时等待：GitHub 查询在 doctor 里只给数秒，超时按「不可达」降级为 skip，不拖慢体检 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
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
  try {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5_000 });
    return r.status === 0 && (r.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
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
  // 末尾，中间任一 push 路径若抛错（如订阅名非法时 readSubscriptionRawConfig 抛 CliError），
  // 这个 promise 就没人 await 了——真 reject 的话会被 index.ts 的 unhandledRejection
  // 处理器捕获、以退出码 1 终止，体检在报出真正的问题之前先崩掉。实测目前不会发生：
  // getLatestNpmVersion 自身 try/catch 吞掉一切并返回 null，摘掉这个 catch 行为不变
  // （已反向验证）。留着是因为一旦它的契约改成抛错，缺这层就会退化成「doctor 偶发崩溃」，
  // 而那种失败只在「另有检查项先抛错」时出现，极难复现。
  const latestVersionPromise = getLatestNpmVersion(4_000).catch(() => null);

  // 内核版本同样在开头并行发起：运行中则经本机代理查 GitHub（与 mihomo kernel 同通道），
  // 4s 超时/失败一律降级 skip——体检不该被 registry 之外再多一个网络故障拖红。
  // 与 npm 项并列后，「CLI 与内核各有一条更新线、该更新哪个」不再需要用户自己记
  const earlyState = getRunningState();
  let kernelProxyPort: number | null = null;
  try {
    kernelProxyPort = earlyState.running ? getPorts().mixed : null;
  } catch {
    kernelProxyPort = null;
  }
  const kernelVersionPromise: Promise<KernelUpdateInfo | null> = hasKernel()
    ? withTimeout(checkUpdate(kernelProxyPort), 4_000).then(
        v => v,
        () => null,
      )
    : Promise.resolve(null);

  // === 内核 ===
  if (!hasKernel()) {
    push('内核', 'fail', '未安装', 'mihomo kernel');
  } else {
    const v = getKernelVersion();
    const r = spawnSync(PATHS.mihomoBinary, ['-v'], { encoding: 'utf8', timeout: 5_000 });
    if (r.status === 0 && /v?\d+\.\d+\.\d+/.test(`${r.stdout}${r.stderr}`)) {
      push('内核', 'ok', v || '可执行');
    } else if (r.error) {
      push('内核', 'fail', `二进制无法执行（${r.error.message}）`, '重新下载: mihomo kernel');
    } else {
      push('内核', 'fail', `二进制无法执行（退出码 ${r.status}）`, '重新下载: mihomo kernel');
    }
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
    push('订阅', 'warn', '未配置', 'mihomo sub add <url>');
  } else {
    push('订阅', 'ok', `${subs.length} 个${active ? `，当前: ${active.name}` : ''}`);
    if (active) {
      if (!readSubscriptionRawConfig(active.name)) {
        push('订阅配置', 'fail', `当前订阅 "${active.name}" 有条目但无配置文件`, `mihomo sub update ${active.name}`);
      } else {
        push('订阅配置', 'ok', `"${active.name}" 配置文件存在`);
      }
      // 缓存新鲜度：超过更新间隔未更新 → 提醒（不判失败，start 会自动更新）
      const cached = subs.find(s => s.name === active.name);
      if (cached?.updated_at) {
        const rel = formatRelativeTime(cached.updated_at);
        if (isSubscriptionStale(cached)) {
          push('订阅新鲜度', 'warn', `${rel ?? '未知'}前更新，已超过 ${resolveUpdateInterval(cached.update_interval)} 小时间隔`, 'mihomo sub update');
        } else {
          push('订阅新鲜度', 'ok', `${rel ?? '未知'}前更新`);
        }
      }
    }
  }

  // === 服务 ===
  const service = getServiceStatus();
  const legacy = detectLegacySystemInstall();
  if (legacy) {
    push('服务', 'fail', '检测到旧版本的系统级服务（root LaunchDaemon），会抢占端口', 'mihomo uninstall（需一次管理员密码）');
  } else if (!service.installed && !service.loaded) {
    push('服务', 'warn', '未安装（Mixed 模式需要）', 'mihomo install');
  } else if (!service.installed) {
    push('服务', 'fail', 'plist 不存在但任务仍装载，KeepAlive 会持续拉起内核', 'mihomo uninstall');
  } else if (service.running) {
    const abnormalExit = describeAbnormalExit(service);
    push('服务', 'ok', `运行中${service.disabled ? '（自启已关闭）' : ''}${abnormalExit ? `，上次异常退出（${abnormalExit}）` : ''}`);
    if (abnormalExit) {
      push('服务稳定性', 'warn', `内核上次异常退出（${abnormalExit}）`, 'mihomo logs 0 查看原因');
    }
  } else {
    // installed && !running：装着、自启开着、却没在跑且上次异常退出 —— 内核在被
    // KeepAlive 反复拉起。与「用户主动 stop」（disabled）区分开，前者是崩溃循环，必须醒目告警。
    // 判据经 describeAbnormalExit 收口，信号死亡（不写 last exit code）同样能检出
    const abnormalExit = describeAbnormalExit(service);
    if (!service.disabled && abnormalExit) {
      push('服务', 'fail', `内核上次异常退出（${abnormalExit}），launchd 正在反复拉起`, 'mihomo logs 0 查看原因，mihomo stop 停止重试');
    } else {
      push('服务', 'ok', `已安装，未运行${service.disabled ? '（自启已关闭）' : ''}`);
    }
  }

  // === 端口 ===
  // getPorts 对非法 ports 抛错：转成检查项（fail），不能让整个体检崩在半路。
  // 兜底用默认端口继续查——配置非法已单独报出，端口检查项用默认值不产生误导
  const state = getRunningState();
  const info = getConfigInfo();
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
      push('端口', 'fail', `内核在跑但 ${mixedPort} 未监听`, 'mihomo logs 0 查看原因');
    }
  } else if (isPortListening(mixedPort)) {
    push('端口', 'warn', `${mixedPort} 被其他进程占用，start 会失败`, `lsof -nP -iTCP:${mixedPort} 查看占用者`);
  } else {
    push('端口', 'ok', `${mixedPort} 空闲`);
  }

  // === 配置原生校验 ===
  if (active && hasKernel()) {
    try {
      const mode = info?.tun ? 'tun' : 'mixed';
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
      push('配置构建', 'fail', (e as Error).message.split('\n')[0], '修正订阅或覆写后 mihomo start', notes);
    }
  } else {
    push('配置构建', 'skip', active ? '未安装内核，跳过校验' : '无订阅，跳过');
  }

  // === 连通性 ===
  if (state.running && info?.mixedPort) {
    const probe = await probeProxyConnectivity(info.mixedPort);
    if (probe.ok) {
      push('代理连通', 'ok', `HTTP ${probe.statusCode}（${probe.durationMs}ms）`);
    } else {
      push('代理连通', 'warn', `不通: ${probe.error}`, '节点可能失效，mihomo ui 切换节点');
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
    push('内核版本', 'warn', `当前 ${kernelInfo.current}，最新 ${kernelInfo.latest}`, 'mihomo kernel');
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
  } else if (compareVersions(latest, VERSION) > 0) {
    push('CLI 版本', 'warn', `当前 ${VERSION}，最新 ${latest}`, 'mihomo update');
  } else {
    push('CLI 版本', 'ok', `${VERSION}（最新）`);
  }

  return checks;
}

export async function cmdDoctor(args: string[] = []): Promise<void> {
  assertKnownFlags(args.slice(1), [], 'doctor');
  // 不接受位置参数：校验先于探测/网络等慢速副作用
  assertPositionalCount(args, 0, 1, 'mihomo doctor');
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
