import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { colors } from '../colors.js';
import { getConfigInfo, getKernelVersion, hasKernel } from '../config.js';
import { CliError } from '../errors.js';
import { PATHS, USER_DATA_DIR } from '../paths.js';
import { getRunningState } from '../runtime.js';
import { detectLegacySystemInstall, getServiceStatus } from '../service.js';
import { getSubscriptionsWithCache, readSubscriptionRawConfig } from '../settings.js';
import { getActiveSubscription, prepareConfigForStart, resolveUpdateInterval } from '../subscription.js';
import { formatRelativeTime } from '../utils.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

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

function collectChecks(): Check[] {
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
    try {
      const parsed = JSON.parse(fs.readFileSync(PATHS.settingsFile, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        push('设置文件', 'ok', '格式有效');
      } else {
        push('设置文件', 'warn', '非对象，读取时会回退默认并备份为 .bak', '删除或修复 settings.json');
      }
    } catch {
      push('设置文件', 'warn', 'JSON 损坏，读取时会回退默认并备份为 .bak', '删除或修复 settings.json');
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
        const intervalH = resolveUpdateInterval(cached.url, cached.update_interval);
        const ageH = (Date.now() - new Date(cached.updated_at).getTime()) / 3_600_000;
        if (ageH > intervalH) {
          push('订阅新鲜度', 'warn', `${rel ?? '未知'}前更新，已超过 ${intervalH} 小时间隔`, 'mihomo sub update');
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
    const exitNote = service.lastExitCode !== null && service.lastExitCode !== 0 ? `，上次异常退出（${service.lastExitCode}）` : '';
    push('服务', 'ok', `运行中${service.disabled ? '（自启已关闭）' : ''}${exitNote}`);
    if (service.lastExitCode !== null && service.lastExitCode !== 0) {
      push('服务稳定性', 'warn', `内核上次异常退出（退出码 ${service.lastExitCode}）`, 'mihomo logs 0 查看原因');
    }
  } else {
    push('服务', 'ok', `已安装，未运行${service.disabled ? '（自启已关闭）' : ''}`);
  }

  // === 端口 ===
  const state = getRunningState();
  const info = getConfigInfo();
  const mixedPort = info?.mixedPort ?? 7890;
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
    const probe = probeProxyConnectivitySyncShim(info.mixedPort);
    if (probe.ok) {
      push('代理连通', 'ok', `HTTP ${probe.statusCode}（${probe.durationMs}ms）`);
    } else {
      push('代理连通', 'warn', `不通: ${probe.error}`, '节点可能失效，mihomo ui 切换节点');
    }
  } else {
    push('代理连通', 'ok', '未运行，跳过');
  }

  return checks;
}

/**
 * doctor 的连通性探测。collectChecks 是同步收集（lsof/ps 等全是 spawnSync），
 * 为保持单趟收集的简单性，这里同步调 curl——doctor 本就是一次性诊断命令，
 * 阻塞几秒可接受（与 status 的异步探测不同，status 是高频命令）。
 */
function probeProxyConnectivitySyncShim(port: number): { ok: boolean; statusCode: number | null; error: string | null; durationMs: number } {
  const start = Date.now();
  try {
    const r = spawnSync(
      'curl',
      [
        '-x',
        `http://127.0.0.1:${port}`,
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--connect-timeout',
        '3',
        '--max-time',
        '5',
        'https://www.gstatic.com/generate_204',
      ],
      { encoding: 'utf8', timeout: 8_000 },
    );
    const code = Number.parseInt((r.stdout || '').trim(), 10);
    const statusCode = Number.isFinite(code) ? code : null;
    const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
    return { ok, statusCode, error: ok ? null : `HTTP ${statusCode ?? '无响应'}`, durationMs: Date.now() - start };
  } catch (e) {
    return { ok: false, statusCode: null, error: (e as Error).message, durationMs: Date.now() - start };
  }
}

export async function cmdDoctor(): Promise<void> {
  const checks = collectChecks();

  console.log('');
  for (const c of checks) {
    const mark = c.status === 'ok' ? colors.green('✓') : c.status === 'warn' ? colors.yellow('!') : colors.red('✗');
    console.log(`${mark} ${colors.bold(c.name)}: ${c.detail}`);
    if (c.status !== 'ok' && c.fix) {
      console.log(colors.gray(`  修复: ${c.fix}`));
    }
  }

  const ok = checks.filter(c => c.status === 'ok').length;
  const warn = checks.filter(c => c.status === 'warn').length;
  const fail = checks.filter(c => c.status === 'fail').length;
  console.log('');
  console.log(`体检完成: ${ok} 项正常，${warn} 项警告，${fail} 项异常`);
  console.log('');

  if (fail > 0) {
    throw new CliError(`发现 ${fail} 项异常`, {
      label: '体检未通过',
      hint: checks.filter(c => c.status === 'fail' && c.fix).map(c => `${c.name}: ${c.fix}`),
    });
  }
}
