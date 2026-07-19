import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as yaml from 'js-yaml';

import { BASE_CONFIG, LAUNCH_DAEMON_LABEL } from './constants.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS } from './paths.js';
import { escapeForPgrep, getAllMihomoPids, SUDO_TIMEOUT_MS } from './process.js';
import type { DaemonStatus } from './types.js';
import { isProcessRoot } from './utils.js';

/** launchd 服务目标：root 级 LaunchDaemon 用系统域 system/<label>（无需 uid） */
const SERVICE_TARGET = `system/${LAUNCH_DAEMON_LABEL}`;
/** 热重载（PUT /configs）超时 */
const HOT_RELOAD_TIMEOUT_MS = 5000;

/** 单引号包裹并转义嵌入的单引号，安全地把任意字符串作为 bash 字面量。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** XML 文本节点转义，防御主目录/数据目录路径中出现 & < > 等字符。 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 生成 LaunchDaemon plist（root 运行）。
 * ProgramArguments 与 startMixedMode 的 spawn 参数保持一致（process.ts）。
 * KeepAlive: 崩溃/被杀后由 launchd 拉起；RunAtLoad: 开机自启。
 * 关键：**不设 UserName** —— 守护进程须以 root 运行，这正是解除 macOS 本地网络隐私（TCC）
 * 限制、使经局域网跳板的代理可达的原因（用户级 LaunchAgent 会被静默拦成 no route to host）。
 * 日志复用 mihomo.log，与 log/logs 命令无缝衔接。
 */
function buildPlist(): string {
  const programArguments = [PATHS.mihomoBinary, '-d', DIRS.data, '-f', PATHS.configFile];
  const argsXml = programArguments.map(a => `    <string>${escapeXml(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LAUNCH_DAEMON_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(PATHS.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(PATHS.logFile)}</string>
  <key>WorkingDirectory</key>
  <string>/tmp</string>
</dict>
</plist>
`;
}

interface SudoScriptOptions {
  /** 动作名，用于错误消息，如 "启用保活" */
  action: string;
  /** 临时脚本文件名（写在 DIRS.runtime 下，用后即删） */
  file: string;
  /** 脚本自定义退出码 → 错误消息（≥2，避开 sudo 的 1=取消/密码错误） */
  codeMessages?: Record<number, string>;
}

/**
 * 写临时 bash 脚本并用单次交互式 sudo 执行（复用 process.ts 的 TUN sudo 范式）。
 * stdio:'inherit' 让 sudo 直接在 TTY 读密码；一个脚本内完成多步 root 操作，只弹一次密码。
 * 退出码 1 保留给 sudo 鉴权取消/密码错误；脚本内部失败用 ≥2 区分。
 */
function runSudoScript(scriptBody: string, opts: SudoScriptOptions): void {
  if (!process.stdin.isTTY) {
    throw new Error('当前环境无法输入管理员密码（需要在交互式终端运行 sudo）');
  }

  ensureDirs();
  const scriptPath = path.join(DIRS.runtime, opts.file);
  fs.writeFileSync(scriptPath, scriptBody, { mode: 0o700 });

  try {
    const result = spawnSync('sudo', [scriptPath], { stdio: 'inherit', timeout: SUDO_TIMEOUT_MS });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      if (result.status === 1) {
        throw new Error('已取消或密码错误');
      }
      if (result.status == null) {
        throw new Error(`${opts.action}被中断（sudo 进程被信号终止）`);
      }
      const custom = opts.codeMessages?.[result.status];
      throw new Error(custom || `${opts.action}失败（退出码 ${result.status}）`);
    }
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }
}

/** 保活是否已启用（以系统 plist 是否存在为准，免 sudo：/Library/LaunchDaemons 用户可读）。 */
export function isDaemonEnabled(): boolean {
  return fs.existsSync(PATHS.launchDaemonPlist);
}

/**
 * 查询保活状态（免 sudo，高频只读命令绝不弹密码）。
 * 不用 `launchctl print system/<label>`（需 sudo）；改用 pgrep + root 属主过滤：
 * daemon 内核跑在 root（无 UserName），用户 `start` 是用户属主（排除），TUN 与 daemon 互斥，
 * 故 enabled 为真时 root 属主的 mihomo 进程即 daemon 内核。isProcessRoot 用 ps（对 root pid 有效）。
 */
export function getDaemonStatus(): DaemonStatus {
  if (!isDaemonEnabled()) {
    return { enabled: false, loaded: false, pid: null };
  }
  const rootPids = getAllMihomoPids().filter(isProcessRoot);
  return { enabled: true, loaded: rootPids.length > 0, pid: rootPids[0] ?? null };
}

/** 保活托管的内核是否真在运行：已装载且有活动 PID。统一"运行中"的判定口径。 */
export function isDaemonRunning(status: DaemonStatus): boolean {
  return status.loaded && status.pid !== null;
}

/**
 * 启用保活：暂存 plist（用户身份）→ 单次 sudo 脚本完成全部 root 步骤。
 * 前置：内核与运行时配置须已就绪（由调用方负责生成 config.yaml）。
 */
export function enableDaemon(): void {
  if (!fs.existsSync(PATHS.mihomoBinary)) {
    throw new Error('未找到 mihomo 内核，请先下载内核');
  }
  if (!fs.existsSync(PATHS.configFile)) {
    throw new Error('未找到运行时配置，请先添加订阅');
  }

  ensureDirs();
  const stagePath = path.join(DIRS.runtime, 'daemon.plist.stage');
  atomicWriteFileSync(stagePath, buildPlist(), { mode: 0o600 });

  const target = shellQuote(SERVICE_TARGET);
  const plistDest = shellQuote(PATHS.launchDaemonPlist);
  const stage = shellQuote(stagePath);
  const pattern = shellQuote(escapeForPgrep(PATHS.mihomoBinary));

  // 顺序关键：先 bootout 卸载旧任务（使 KeepAlive 失效）→ root 身份 pkill 清残留
  // （替代 JS cleanupAll，普通用户杀不掉 root 进程）→ install 到系统目录 → bootstrap。
  const script = [
    '#!/bin/bash',
    `launchctl bootout ${target} 2>/dev/null || true`,
    `pkill -9 -f ${pattern} 2>/dev/null || true`,
    'sleep 0.2',
    `install -m 644 -o root -g wheel ${stage} ${plistDest} || exit 2`,
    `launchctl bootstrap system ${plistDest} || { launchctl bootout ${target} 2>/dev/null; rm -f ${plistDest}; exit 3; }`,
    'exit 0',
    '',
  ].join('\n');

  try {
    runSudoScript(script, {
      action: '启用保活',
      file: 'daemon-enable.sh',
      codeMessages: {
        2: '安装 plist 到 /Library/LaunchDaemons 失败',
        3: '装载保活服务失败（launchctl bootstrap）',
      },
    });
  } finally {
    try {
      fs.unlinkSync(stagePath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 停用保活：单次 sudo 脚本卸载任务、删 plist、并把 root 属主的日志/数据归还当前用户
 * （修复"启用→关闭→用户态 start 对 root 属主 logFile 追加 EACCES"的权限冲突）。
 * 幂等：plist 不存在直接返回，不弹 sudo。不自动 pkill（避免误杀手动实例），仅残留时提示。
 */
export function disableDaemon(): void {
  if (!isDaemonEnabled()) return;

  const target = shellQuote(SERVICE_TARGET);
  const plistDest = shellQuote(PATHS.launchDaemonPlist);
  const logFile = shellQuote(PATHS.logFile);
  const dataDir = shellQuote(DIRS.data);

  const script = [
    '#!/bin/bash',
    `launchctl bootout ${target} 2>/dev/null || true`,
    `rm -f ${plistDest}`,
    `chown "$SUDO_UID:$SUDO_GID" ${logFile} 2>/dev/null || true`,
    `chown -R "$SUDO_UID:$SUDO_GID" ${dataDir} 2>/dev/null || true`,
    'exit 0',
    '',
  ].join('\n');

  runSudoScript(script, { action: '关闭保活', file: 'daemon-disable.sh' });

  // bootout 通常已终止托管内核；仅在极少数残留时提示手动清理，不自动裸杀。
  const rootPids = getAllMihomoPids().filter(isProcessRoot);
  if (rootPids.length > 0) {
    console.log('');
    console.log(`仍有 root 内核进程残留 (PID ${rootPids.join(', ')})`);
    console.log('手动清理: sudo pkill -9 mihomo');
  }
}

/**
 * 热重载 API 基址：从运行时配置的 external-controller 只取**端口**，host 固定 127.0.0.1。
 * 用户为从其他设备访问控制面板常把 external-controller 设为 ':9090' 或 '0.0.0.0:9090'，
 * 直接用其 host 会得到非法/不可靠地址（'http://:9090' 抛 ERR_INVALID_URL、'0.0.0.0' 连接不稳）；
 * 而 bind-all 监听器经 loopback 必可达，故统一走 127.0.0.1:<port>。读不到端口回退默认。
 */
function getControllerBase(): string {
  const fallbackPort = String(BASE_CONFIG['external-controller']).split(':').pop() || '9090';
  let port = fallbackPort;
  try {
    const content = fs.readFileSync(PATHS.configFile, 'utf8');
    const cfg = yaml.load(content) as Record<string, unknown> | null;
    const ec = cfg?.['external-controller'];
    if (typeof ec === 'string' && ec.trim()) {
      const parsed = ec
        .replace(/^https?:\/\//, '')
        .split(':')
        .pop();
      if (parsed && /^\d+$/.test(parsed)) port = parsed;
    }
  } catch {
    /* ignore */
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * 经 external-controller 热重载配置（走 localhost、免 sudo）。成功返回 true。
 * 用空 body：内核重新加载它启动时 `-f` 指定的配置文件（正是我们写入的 configFile）。
 * 不传 {path}——mihomo 的 SAFE_PATHS 限制只允许 workdir/home 下的路径，
 * 而 configFile 在 runtime/ 下会被拒成 400；空 body 重载 `-f` 文件天然规避该限制。
 */
async function tryHotReload(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOT_RELOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${getControllerBase()}/configs?force=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    return res.status === 204 || res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 重启托管内核使配置变更生效。优先热重载（PUT /configs，免 sudo）；
 * 失败才回退 sudo kickstart 脚本。kickstart -k 是命令式重启，不与 KeepAlive 冲突；
 * 若任务未装载（plist 在但被手动 bootout）则 bootstrap 自愈。
 */
export async function restartDaemon(): Promise<void> {
  if (!fs.existsSync(PATHS.launchDaemonPlist)) {
    throw new Error('保活未启用，无法重启');
  }

  if (await tryHotReload()) return;

  const target = shellQuote(SERVICE_TARGET);
  const plistDest = shellQuote(PATHS.launchDaemonPlist);
  const script = [
    '#!/bin/bash',
    `if launchctl kickstart -k ${target} 2>/dev/null; then exit 0; fi`,
    `launchctl bootstrap system ${plistDest} || exit 3`,
    'exit 0',
    '',
  ].join('\n');

  runSudoScript(script, {
    action: '重启保活',
    file: 'daemon-restart.sh',
    codeMessages: { 3: '重启保活失败（launchctl bootstrap）' },
  });
}
