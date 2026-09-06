import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { compareVersions } from 'compare-versions';

import { colors } from '../colors.js';
import { getConfigInfo, getKernelVersion, hasKernel } from '../config.js';
import { DEFAULT_MIXED_PORT, VERSION } from '../constants.js';
import { CliError } from '../errors.js';
import { PATHS, USER_DATA_DIR } from '../paths.js';
import { probeProxyConnectivity } from '../proxy-probe.js';
import { getRunningState } from '../runtime.js';
import { describeAbnormalExit, detectLegacySystemInstall, getServiceStatus } from '../service.js';
import { getPorts, getSubscriptionsWithCache, isValidSettingsContent, readSubscriptionRawConfig } from '../settings.js';
import { getActiveSubscription, isSubscriptionStale, prepareConfigForStart, resolveUpdateInterval } from '../subscription.js';
import { formatRelativeTime } from '../utils.js';
import { getLatestNpmVersion } from './update.js';

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
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
  const push = (name: string, status: CheckStatus, detail: string, fix?: string): void => {
    checks.push({ name, status, detail, fix });
  };

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

  // === 配置可构建 ===
  if (active) {
    try {
      const mode = info?.tun ? 'tun' : 'mixed';
      prepareConfigForStart(mode, active.name);
      push('配置构建', 'ok', `当前订阅可正常构建（${mode}）`);
    } catch (e) {
      push('配置构建', 'fail', (e as Error).message.split('\n')[0], '修正订阅或覆写后 mihomo start');
    }
  } else {
    push('配置构建', 'warn', '无订阅，跳过');
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

  // === CLI 版本 ===
  // 短超时 + 失败 skip：registry 不可达很常见（国内网络），体检不该因此多红一项；
  // 用 compareVersions 判方向，本地比 latest 新（dev 链接/beta）不告警
  const latest = await getLatestNpmVersion(4_000);
  if (latest === null) {
    push('CLI 版本', 'skip', 'npm registry 不可达，跳过检查');
  } else if (compareVersions(latest, VERSION) > 0) {
    push('CLI 版本', 'warn', `当前 ${VERSION}，最新 ${latest}`, 'mihomo update');
  } else {
    push('CLI 版本', 'ok', `${VERSION}（最新）`);
  }

  return checks;
}

export async function cmdDoctor(): Promise<void> {
  const checks = await collectChecks();

  console.log('');
  for (const c of checks) {
    const mark = c.status === 'ok' ? colors.green('✓') : c.status === 'warn' ? colors.yellow('!') : c.status === 'fail' ? colors.red('✗') : colors.gray('·');
    console.log(`${mark} ${colors.bold(c.name)}: ${c.detail}`);
    if (c.status !== 'ok' && c.status !== 'skip' && c.fix) {
      console.log(colors.gray(`  修复: ${c.fix}`));
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
