import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigInfo } from './config.js';
import { CONTROLLER_BASE_URL, isValidServiceLabel, RAW_SERVICE_LABEL_INPUT, SERVICE_BINARY_NAME, SERVICE_LABEL } from './constants.js';
import { CliError } from './errors.js';
import { cleanupOldLogs, rotateAndCleanupLogs } from './log-files.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS } from './paths.js';
import { getMihomoPids, isProcessRoot, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import { readSettings } from './settings.js';
import { runSudoScript } from './sudo.js';
import type { ServiceStatus } from './types.js';
import { formatLocalTimestamp, shellQuote, sleep } from './utils.js';

/**
 * launchd 服务层：Mixed 模式的唯一运行方式。
 *
 * 装在用户域：`~/Library/LaunchAgents` + `gui/<uid>`，**全程免 sudo**——
 * install/start/stop/uninstall 一次密码都不用输。
 *
 * 为什么不用 root LaunchDaemon（v3.0–v4.0 的做法）：system 域的
 * bootstrap/bootout/enable/disable 一律需要 root，那样每次启停都要输密码。
 * 旧实现选 root 是为了绕开 macOS 本地网络隐私对局域网设备访问的限制，
 * 但 Apple DTS 明确「豁免条件是**以 root 运行**，不是身为 daemon」——
 * 用户域 agent 不豁免，可那只意味着走正常的弹框授权流程，并非被静默拦死。
 * 且 loopback（`127.0.0.1`，如自建 `ssh -D` 的 SOCKS 出口）根本不属于「本地网络」，
 * 完全不触发该机制。权衡后不再提供 root 安装。
 *
 * 仍会**识别**遗留的系统级安装（v4.0 及更早装的）：它带 KeepAlive 会持续拉起内核抢端口，
 * 不认它的话就是个用户无从卸载的幽灵。识别后引导 `uninstall` 清理，见 detectLegacySystemInstall。
 */

/** 校验 MIHOMO_CLI_DAEMON_LABEL：非法 label 经 path.join 折叠 `..` 后会让清理遗留系统级安装的
 * `sudo rm -f` 落到 /Library/LaunchDaemons 之外的任意路径
 * （`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`）——提权原语。
 * constants 已把非法值回退为默认标签，此处在真正执行写/删前拒绝并告知用户，
 * 避免「设了变量却静默作用到生产 plist」的隐蔽行为。 */
function assertServiceLabelSafe(): void {
  if (RAW_SERVICE_LABEL_INPUT !== undefined && !isValidServiceLabel(RAW_SERVICE_LABEL_INPUT)) {
    throw new CliError(`MIHOMO_CLI_DAEMON_LABEL 无效: "${RAW_SERVICE_LABEL_INPUT}"`, {
      label: '配置错误',
      hint: ['只允许字母、数字、点、下划线、短横线，且不能含 ".."。', '该值会成为 launchd plist 的文件名，并参与清理遗留安装时的 root 删除路径。'],
    });
  }
}

/** 热重载（PUT /configs）超时 */
const HOT_RELOAD_TIMEOUT_MS = 5000;
/**
 * 启动后健康确认的采样节奏。
 *
 * 必须观察满 SERVICE_OBSERVE_MS 才敢判「健康」，不能一看到 running 就返回：
 * 实测全新 bootstrap 后存在一段**假健康窗口**——state 是 running、pid 也给得出，
 * 而进程其实马上就要退出。该窗口的长度**不固定**（同一台机器上实测过 180ms 与 540ms
 * 两种，取决于内核进程从 spawn 到 exit 实际花了多久），故只能用一个足够宽的观察窗，
 * 不能按某次实测值卡边。
 *
 * 取 1.2s：覆盖 mihomo 的配置解析失败（在进程启动后极早发生）并留足余量。
 * 代价是健康路径上 `start` 多等约 0.7s（此前无条件 `sleep 500ms`）——用一次可感知的
 * 短暂等待换掉「报告已启动但其实没有代理」，这笔交换是划算的。
 * 崩溃一经检出立即返回，不必等满。
 *
 * 观察窗之后才崩溃的内核（如跑了几秒才 OOM）此处判不出来，由 `status` 的
 * 「上次异常退出」提示兜底——那不是本函数的职责边界内能解决的。
 */
const SERVICE_HEALTH_INTERVAL_MS = 100;
const SERVICE_OBSERVE_MS = 1200;
/** 观察窗结束后仍处于 spawn 中间态时的额外宽限（慢机器上内核起得慢） */
const SERVICE_HEALTH_GRACE_MS = 1800;
/** 日志超过该大小时，restartService 借 kickstart 顺便 copy-truncate（startService 走 rotateAndCleanupLogs 无条件轮转） */
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
/** launchctl 查询超时：只读探测卡住时按「查不到」处理 */
const LAUNCHCTL_TIMEOUT_MS = 5000;

// === 服务目标 ===

/** launchctl 服务目标：`gui/<uid>/<label>` */
function serviceTarget(): string {
  return `${bootstrapDomain()}/${SERVICE_LABEL}`;
}

/** bootstrap/print-disabled 的域参数：`gui/<uid>` */
function bootstrapDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** 服务是否已安装（plist 文件存在） */
export function isServiceInstalled(): boolean {
  return fs.existsSync(PATHS.userAgentPlist);
}

/**
 * 是否存在遗留的**系统级**安装（v3.0–v4.0 的 `daemon on` 装的 root LaunchDaemon）。
 *
 * 必须识别：它带 KeepAlive，会持续把内核拉起并抢占端口，而用户态的 launchctl
 * 根本动不了它。不认的话对用户就是个「代理停不掉、CLI 说没装」的幽灵。
 * 只识别不自动清理——删 root 文件要提权，交由 uninstall 在用户明确要求时做。
 */
export function detectLegacySystemInstall(): boolean {
  return fs.existsSync(PATHS.systemDaemonPlist);
}

// === 状态解析（纯函数，单测锁定） ===

/**
 * 解析 `launchctl print <target>` 的输出。
 *
 * **必须锚定单个前导 tab**：顶层字段是 `\tstate = running` / `\tpid = 5474`，
 * 而输出里还有嵌套 endpoint 的 `\t\tstate = active`（实测同一份输出里出现两次）。
 * 不锚定的话嵌套行会把 state 误解析成 "active"，任何时候都判成「未运行」。
 *
 * `lastExitCode` 是判定「起来了又立刻挂掉」的唯一可靠信号，见 waitServiceHealthy。
 * 健康服务该字段是**字符串** `(never exited)` 而非数字（实测），故非数字一律归 null。
 */
export function parseServicePrint(output: string): { state: string | null; pid: number | null; lastExitCode: number | null } {
  const stateMatch = output.match(/^\tstate = (.+)$/m);
  const pidMatch = output.match(/^\tpid = (\d+)$/m);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
  // 只匹配纯数字：`(never exited)` 不是失败信号，必须与「退出码 0」区分开
  const exitMatch = output.match(/^\tlast exit code = (\d+)$/m);
  const lastExitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;
  return {
    state: stateMatch ? stateMatch[1].trim() : null,
    pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
    lastExitCode: lastExitCode !== null && Number.isInteger(lastExitCode) ? lastExitCode : null,
  };
}

/**
 * 解析 `launchctl print-disabled <domain>` 的输出，判断指定 label 是否被禁用。
 *
 * 输出形如 `\t\t"com.example.foo" => disabled`（旧版为 `=> true/false`，两种都认）。
 * **不在列表里 = 从未 enable/disable 过 = 默认启用**，故返回 false。
 */
export function parseDisabledList(output: string, label: string): boolean {
  // label 可能含正则元字符（`.` 是合法 label 字符且极常见），必须转义
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp(`^\\s*"${escaped}" => (\\S+)$`, 'm'));
  if (!match) return false;
  const value = match[1].toLowerCase();
  return value === 'true' || value === 'disabled';
}

// === 状态查询（全程免 sudo） ===

/**
 * launchctl 的退出码（本机实测，macOS 26.6）：
 *   0   成功
 *   112 域不存在（如 `gui/99999`）
 *   113 目标未找到 —— 服务未装载，**正常状态**，不是错误
 *   125 请求非法（如 `gui/0`，root 下拼出的域）
 *
 * 只有 113 是「查到了，答案是没有」；112/125 是「这次查询根本没成立」，
 * 把它们当成「未装载」会让 status 谎报、stop 静默跳过（v4.2.2 修，详见 index.ts 的 root 守卫）。
 */
const LAUNCHCTL_NOT_LOADED = 113;

function runLaunchctl(args: string[]): { status: number | null; stdout: string } {
  try {
    const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: LAUNCHCTL_TIMEOUT_MS });
    return { status: result.status, stdout: result.stdout || '' };
  } catch {
    return { status: null, stdout: '' };
  }
}

/**
 * 查询失败（而非「未装载」）时抛错，不让它伪装成「服务不存在」。
 *
 * root 守卫已挡掉 `gui/0` 这个主要来源，但域参数并非只有一条来路（`MIHOMO_CLI_DAEMON_LABEL`
 * 异常、launchctl 缺失、超时都会走到这里），故保留这道独立检查——
 * 与 `getMihomoPids` 对 pgrep 退出码的处理同一原则：**探测失败 ≠ 目标不存在**。
 */
function assertLaunchctlQueryOk(status: number | null, what: string): void {
  if (status === 0 || status === LAUNCHCTL_NOT_LOADED) return;

  throw new CliError(`无法查询服务状态（launchctl ${what} 退出码 ${status ?? '执行失败'}）`, {
    hint: [status === null ? 'launchctl 未能执行（缺失或超时）。' : '这不代表服务未安装，只表示查不到。', '', `手动确认: launchctl print ${serviceTarget()}`],
  });
}

/**
 * 查询服务状态。全程免 sudo：`launchctl print` 与 `print-disabled` 均可读（实测 3ms），
 * 故高频只读命令绝不弹密码。未装载时 `launchctl print` 退出码为 113。
 *
 * **plist 不存在时也必须查 launchctl**，不能直接返回「未安装」就完事：用户手动
 * `rm` 掉 plist 后任务仍处 bootstrapped 状态，KeepAlive 会继续把内核拉起。
 * 只看文件的话 status 谎报「未安装」、uninstall 直接返回不执行 bootout，
 * 用户陷入「代理停不掉且 CLI 说没装」的死胡同（实测可复现，CODE_REVIEW #6 同款）。
 */
export function getServiceStatus(): ServiceStatus {
  const installed = isServiceInstalled();
  const print = runLaunchctl(['print', serviceTarget()]);
  assertLaunchctlQueryOk(print.status, 'print');
  const loaded = print.status === 0;

  if (!installed && !loaded) {
    return { installed: false, loaded: false, running: false, pid: null, disabled: false, lastExitCode: null };
  }

  const { state, pid, lastExitCode } = loaded ? parseServicePrint(print.stdout) : { state: null, pid: null, lastExitCode: null };
  const disabledOut = runLaunchctl(['print-disabled', bootstrapDomain()]);
  assertLaunchctlQueryOk(disabledOut.status, 'print-disabled');
  const disabled = disabledOut.status === 0 ? parseDisabledList(disabledOut.stdout, SERVICE_LABEL) : false;

  return { installed, loaded, running: state === 'running', pid, disabled, lastExitCode };
}

/** 服务启动后的健康判定结果。`crashed` 为真时内核已被 launchd 反复拉起，不是可用状态。 */
export interface ServiceHealth {
  healthy: boolean;
  crashed: boolean;
  pid: number | null;
  exitCode: number | null;
}

/**
 * 等待服务真正稳定运行，而非「bootstrap 没报错」。
 *
 * 为什么必须有：`launchctl bootstrap` 成功只意味着任务被装载，**不代表进程活着**。
 * 内核因配置错误（端口占用、非法字段）立即退出时，KeepAlive 会每隔约 10s 重新拉起，
 * 而 CLI 此前固定 `sleep 500ms` 后取 pid 即报「已启动 (PID xxx)」——用户以为代理开着，
 * 实际完全没有代理，且日志被崩溃信息反复刷。实测该误报可 100% 复现。
 *
 * 判据是 `last exit code`（非 0 = 起来过又挂了），不用 `runs`：KeepAlive 有约 10s
 * 的重启节流，崩溃后 2s 内 `runs` 仍是 1，用它判断会漏掉全部快速失败。
 * 该字段在重新 bootstrap 后重置（实测不跨 bootout 残留），故只反映本次启动。
 *
 * **不能一看到 running 就返回**：实测全新 bootstrap 后存在假健康窗口
 * （state=running 且有 pid，但进程马上就要退出），且其长度不固定。
 * 故先观察满 SERVICE_OBSERVE_MS 再下结论；崩溃一经检出则立即收口。
 *
 * 「当前在跑」优先于「历史退出码」：`last exit code` 是历史值，崩溃一次后又正常起来的
 * 服务该字段仍非 0，故只在观察窗内始终未能进入 running 时才判定崩溃。
 */
export async function waitServiceHealthy(): Promise<ServiceHealth> {
  const deadline = Date.now() + SERVICE_OBSERVE_MS;
  const graceDeadline = deadline + SERVICE_HEALTH_GRACE_MS;
  let last = getServiceStatus();

  // 第一阶段：观察满窗口。期间检出崩溃立即返回，否则以窗口结束时的状态为准
  while (Date.now() < deadline) {
    await sleep(SERVICE_HEALTH_INTERVAL_MS);
    last = getServiceStatus();

    if (isCrashed(last)) {
      return { healthy: false, crashed: true, pid: null, exitCode: last.lastExitCode };
    }
    if (!last.loaded) {
      // 已卸载（被外部 bootout，或 plist 装不进来），继续等无意义
      return { healthy: false, crashed: false, pid: null, exitCode: last.lastExitCode };
    }
  }

  if (last.running) return { healthy: true, crashed: false, pid: last.pid, exitCode: null };

  // 第二阶段：窗口结束仍未 running（慢机器上内核起得慢，或正在 spawn 重试），再宽限一会儿
  while (Date.now() < graceDeadline) {
    await sleep(SERVICE_HEALTH_INTERVAL_MS);
    last = getServiceStatus();

    if (isCrashed(last)) {
      return { healthy: false, crashed: true, pid: null, exitCode: last.lastExitCode };
    }
    if (!last.loaded) break;
    if (last.running) return { healthy: true, crashed: false, pid: last.pid, exitCode: null };
  }

  return { healthy: false, crashed: false, pid: last.pid, exitCode: last.lastExitCode };
}

/** 「起来过又挂了」：当前不在跑，且本次启动记录了非 0 退出码。 */
function isCrashed(status: ServiceStatus): boolean {
  return !status.running && status.lastExitCode !== null && status.lastExitCode !== 0;
}

// === plist ===

/** XML 文本节点转义，防御主目录/数据目录路径中出现 & < > 等字符。 */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 生成 plist。
 *
 * ProgramArguments[0] 指向**符号链** serviceBinary 而非真实内核二进制：
 * 「系统设置 → 通用 → 登录项与扩展」按它的 basename 显示，直接写内核路径的话用户
 * 只看到一个没有上下文的 "mihomo"。其余参数与 startTun 的命令行保持同构，
 * 两者都被 MAIN_INSTANCE_PATTERN 覆盖。
 *
 * KeepAlive: 崩溃/被杀后由 launchd 拉起；RunAtLoad: 登录后自启。
 * **不设 UserName**：gui 域下默认就是当前用户，写了只会引入用户名依赖。
 * 日志复用 mihomo.log，与 logs 命令无缝衔接。
 */
export function buildPlist(): string {
  const programArguments = [PATHS.serviceBinary, '-d', DIRS.data, '-f', PATHS.configFile];
  const argsXml = programArguments.map(a => `    <string>${escapeXml(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
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

/**
 * 确保符号链 kernel/mihomo-cli-service → mihomo 存在且指向正确。
 * 用**相对**目标（同目录内），使整个数据目录被移动/改名后仍然有效。
 * `ln -sfn` 语义：已存在则原子替换，故可反复调用。内核更新（mh kernel 覆盖 mihomo）
 * 不影响符号链，但 `reset kernel` 会连同删除，因此 install 与 start 都要调一次。
 */
export function ensureServiceSymlink(): void {
  if (!fs.existsSync(PATHS.mihomoBinary)) {
    throw new CliError('未找到 mihomo 内核，请先下载内核', { hint: '下载内核: mihomo kernel' });
  }
  try {
    const current = fs.readlinkSync(PATHS.serviceBinary);
    if (current === 'mihomo') return;
    fs.unlinkSync(PATHS.serviceBinary);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EINVAL = 存在但不是符号链（可能是早期版本留下的真实文件），删掉重建
    if (code === 'EINVAL') {
      try {
        fs.unlinkSync(PATHS.serviceBinary);
      } catch {
        /* ignore：下面 symlinkSync 会抛出可读错误 */
      }
    } else if (code !== 'ENOENT') {
      throw e;
    }
  }
  fs.symlinkSync('mihomo', PATHS.serviceBinary);
}

// === 操作 ===

/**
 * 执行一组 launchctl 步骤。user 域直接跑（免密）；system 域拼成单个 sudo 脚本
 * （一次密码完成全部 root 步骤，与 TUN 启动共用 runSudoScript 范式）。
 *
 * `steps` 里的每项是完整的 shell 命令行，调用方负责 shellQuote。
 * 拼成一个脚本经 /bin/bash -c 跑（而非逐条 spawn），以保留 `|| true`、while 循环等语义。
 * **全程无 sudo**——用户域的 launchctl 操作不需要 root。
 */
function runLaunchctlSteps(steps: string[], opts: { action: string; codeMessages?: Record<number, string> }): void {
  const script = ['#!/bin/bash', ...steps, 'exit 0', ''].join('\n');

  const result = spawnSync('/bin/bash', ['-c', script], { stdio: 'inherit', timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const custom = result.status !== null ? opts.codeMessages?.[result.status] : undefined;
    throw new CliError(custom || `${opts.action}失败（退出码 ${result.status ?? '信号中断'}）`);
  }
}

/**
 * 以 root 清理残留内核与 root 属主的 pid 文件。
 * **只在确实存在 root 残留时调用**——正常的用户级路径不应因此弹密码。
 * root 残留的唯一来源是 `tun`（sudo 起的内核）与系统级服务。
 */
function cleanupRootResidue(): void {
  const rootPids = getMihomoPids().filter(isProcessRoot);
  const pidFileIsRoot =
    fs.existsSync(PATHS.pidFile) &&
    (() => {
      try {
        return fs.statSync(PATHS.pidFile).uid === 0;
      } catch {
        return false;
      }
    })();
  if (rootPids.length === 0 && !pidFileIsRoot) return;

  const script = [
    '#!/bin/bash',
    `pkill -9 -f ${shellQuote(MAIN_INSTANCE_PATTERN)} 2>/dev/null || true`,
    `rm -f ${shellQuote(PATHS.pidFile)}`,
    'exit 0',
    '',
  ].join('\n');
  runSudoScript(script, { action: '清理残留进程', file: 'cleanup-residue.sh' });
}

/** 终止残留内核。用户态进程直接 kill；有 root 残留才提一次权。 */
function killResidualKernels(): void {
  const pids = getMihomoPids();
  if (pids.length === 0) return;

  const rootPids = pids.filter(isProcessRoot);
  for (const pid of pids) {
    if (rootPids.includes(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore：可能已自行退出 */
    }
  }
  if (rootPids.length > 0) cleanupRootResidue();
}

/**
 * 等待 bootout 真正完成的脚本片段（最多 5s）。
 *
 * `launchctl bootout` 返回不代表任务已卸载——内核可能还持着监听端口。紧接着的
 * bootstrap 若撞上「尚未卸载完成」会报 error 5，与 disabled 的报错完全同形，极难排查。
 *
 * 注：本机实测 16 次连续 `bootout → bootstrap`（含持监听端口的进程）**未能复现**该竞态，
 * 故这是预防性防御而非已复现问题的修复。成本是不发生时零开销（首轮 print 即退出），
 * 留着比赌它不发生划算。
 */
function waitUnloadedSteps(): string[] {
  const target = shellQuote(serviceTarget());
  return ['n=0', 'while [ $n -lt 25 ]; do', `  launchctl print ${target} >/dev/null 2>&1 || break`, '  sleep 0.2', '  n=$((n+1))', 'done'];
}

/**
 * 安装/重装服务。
 *
 * 幂等：可反复执行。`wasRunning` 为真时装完恢复运行（避免「代理开着时更新后重装静默关掉代理」），
 * 首装则显式 `disable`——install 只负责装，启动是 `start` 的事。
 *
 * 前置只要求内核存在（plist 指向它）；**不要求 config.yaml**，因为装完不启动。
 */
export function installService(wasRunning: boolean): void {
  assertServiceLabelSafe();
  ensureDirs();
  ensureServiceSymlink();

  const stagePath = path.join(DIRS.runtime, 'service.plist.stage');
  atomicWriteFileSync(stagePath, buildPlist(), { mode: 0o600 });

  const target = shellQuote(serviceTarget());
  const dest = shellQuote(PATHS.userAgentPlist);
  const stage = shellQuote(stagePath);
  const destDir = shellQuote(path.dirname(PATHS.userAgentPlist));

  // plutil -lint 先行：坏 plist 绝不进系统目录（bootstrap 失败后还得手工清理）。
  //
  // 重装分支必须 enable 在 bootstrap 之前，且顺序不可换：**bootstrap 一个 disabled 的
  // label 不是「加载后不启动」，而是硬失败 `Bootstrap failed: 5: Input/output error`**
  // （本机实测）。而 `stop` 恒置 disable 位，所以「stop 之后重装」是必经路径，
  // 少了 enable 这里就 100% 失败。
  //
  // bootstrap 失败**不删 plist**：失败后落到「已安装未装载」这个干净可恢复的状态，
  // 用户 `mh start` 即可重试。删掉的话，「重装」会被静默升级成「卸载」——
  // 用户以为装着，实际什么都没有。
  const steps = [
    `plutil -lint ${stage} >/dev/null || exit 2`,
    `launchctl bootout ${target} 2>/dev/null || true`,
    ...waitUnloadedSteps(),
    // ~/Library/LaunchAgents 在全新系统上可能不存在；只在缺失时创建，避免改动已有目录权限
    `[ -d ${destDir} ] || mkdir -p ${destDir}`,
    `install -m 644 ${stage} ${dest} || exit 3`,
    ...(wasRunning
      ? [`launchctl enable ${target} || exit 5`, `launchctl bootstrap ${bootstrapDomain()} ${dest} || exit 4`]
      : [`launchctl disable ${target} 2>/dev/null || true`]),
  ];

  try {
    runLaunchctlSteps(steps, {
      action: '安装服务',
      codeMessages: {
        2: 'plist 语法校验失败（plutil -lint）',
        3: `安装 plist 到 ${path.dirname(PATHS.userAgentPlist)} 失败`,
        4: '装载服务失败（launchctl bootstrap）',
        5: '启用服务失败（launchctl enable）',
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
 * 启动服务并开启自启。
 *
 * 顺序关键：`enable` 必须在 `bootstrap` **之前**——本机实测，bootstrap 一个 disabled 的
 * label 直接硬失败 `Bootstrap failed: 5: Input/output error`（不是「加载了但不启动」）。
 * 而 `stop` 恒置 disable 位，所以「stop 之后再 start」是最常走的路径，
 * 少了这一步 start 会 100% 失败。
 *
 * 先 `bootout` 清旧使重复调用幂等（改过 plist 后 start 一下即按新配置重载，无需 kickstart）。
 *
 * 拆成两次 launchctl 调用（bootout / bootstrap），中间插入日志轮转：轮转的 rename
 * 只在「旧进程已退出、新进程未起」这个窗口里有效，见下方注释。两次调用都在用户域，
 * 全程免密，拆开不额外弹密码。
 */
export function startService(): void {
  assertServiceLabelSafe();
  ensureServiceSymlink();

  if (!isServiceInstalled()) {
    throw new CliError('服务未安装', { hint: '安装服务: mihomo install' });
  }
  if (!fs.existsSync(PATHS.configFile)) {
    throw new CliError('未找到运行时配置', { hint: '请先添加订阅: mihomo sub add <url>' });
  }

  // 拒绝用 TUN 配置启动服务。服务是用户级 LaunchAgent（非 root），而创建 utun 设备需要 root——
  // 真启起来就是崩溃后被 KeepAlive 每约 10 秒拉起一次，日志刷爆而代理不通。
  //
  // 正常路径下 cmdStart 会先按 mixed 重建配置，走不到这里；这是防御另外两条来路：
  // 用户手工改了 config.yaml，或从旧版本升上来时数据目录里恰好躺着一份 TUN 配置。
  // 与 cmdStart 里「起 TUN 前先关服务自启」是同一问题的两层——那层堵源头，这层兜底。
  if (getConfigInfo()?.tun) {
    throw new CliError('运行时配置为 TUN 模式，服务无法使用', {
      hint: [
        '服务以普通用户身份运行（用户级 LaunchAgent），无权创建 TUN 设备，',
        '强行启动只会让内核反复崩溃重启。',
        '',
        '按 Mixed 重建配置并启动:  mihomo start mixed',
        '确实要用 TUN:            mihomo tun',
      ],
    });
  }

  // tun 残留是 root 属主，会与服务抢端口；有才清（这是唯一可能弹密码的地方），无则免密
  cleanupRootResidue();

  const target = shellQuote(serviceTarget());
  const dest = shellQuote(PATHS.userAgentPlist);

  runLaunchctlSteps([`launchctl bootout ${target} 2>/dev/null || true`, ...waitUnloadedSteps()], { action: '卸载旧服务实例' });

  // 轮转日志。**必须卡在这个窗口**：旧进程已退出、新进程尚未 bootstrap，此时无人持有
  // 日志 fd，rename 才真正生效。运行中做 rename 是无效的——launchd 的 StandardOutPath
  // fd 指向旧 inode，改名后内核会继续往归档文件里写（restartService 因此只能 copy-truncate）。
  //
  // 此前整个服务路径都不轮转（rotateAndCleanupLogs 只在 startTun 里调），于是默认的
  // Mixed 模式下 mihomo.log 无限增长、`logs` 的归档列表恒为空，与 README 承诺的
  // 「自动轮转，保留 7 天」不符。
  rotateAndCleanupLogs();

  runLaunchctlSteps([`launchctl enable ${target} || exit 2`, `launchctl bootstrap ${bootstrapDomain()} ${dest} || exit 3`], {
    action: '启动服务',
    codeMessages: { 2: '启用服务失败（launchctl enable）', 3: '装载服务失败（launchctl bootstrap）' },
  });
}

/**
 * 只关自启，不动运行中的实例（`disable` 决定「退出/登录后是否再拉起」，不终止当前进程）。
 *
 * 为 TUN 而设：plist 指向的 `config.yaml` 与 TUN 写的是**同一个文件**，TUN 跑起来后
 * 那份配置就是 `tun.enable = true`。此时若服务的自启位还开着，用户不 stop 直接关机，
 * 下次开机 launchd 会拿这份 TUN 配置、以**普通用户身份**（LaunchAgent 非 root）启动内核——
 * 而创建 utun 设备需要 root，内核必然失败退出，再被 `KeepAlive` 每约 10 秒拉起一次。
 * 用户开机看到的是「代理不通、日志被刷爆」，且与自己上次用 TUN 毫无表面关联。
 *
 * 幂等：已 disable 时再调一次无副作用（launchctl 照常写一条同值记录）。
 */
export function disableServiceAutoStart(): void {
  assertServiceLabelSafe();

  const target = shellQuote(serviceTarget());
  runLaunchctlSteps([`launchctl disable ${target} 2>/dev/null || true`], { action: '关闭服务自启' });
}

/**
 * 停止服务并禁止自启。
 *
 * `disable` 不能省：只 bootout 的话 enable 位还在，下次登录 launchd 扫到 plist 又会拉起，
 * 等于没关干净——而 CLI 已经打印了「已停止」。
 *
 * 即便 plist 不存在也照常执行：用户手动删掉 plist 后任务仍处 bootstrapped 状态，
 * KeepAlive 会继续拉起内核，此时只有 bootout 能救。
 */
export function stopService(): void {
  assertServiceLabelSafe();

  const target = shellQuote(serviceTarget());
  runLaunchctlSteps([`launchctl bootout ${target} 2>/dev/null || true`, `launchctl disable ${target} 2>/dev/null || true`, ...waitUnloadedSteps()], {
    action: '停止服务',
  });

  // bootout 通常已终止托管内核；tun 起的 root 内核与手动残留在此收口
  killResidualKernels();
}

/**
 * 卸载服务：停止 + 删除 plist。
 *
 * **不清 disable 位**：launchctl 没有「清除记录」的动词——`enable` 同样会往
 * /var/db/com.apple.xpc.launchd/ 写一条 `=> enabled`（实测可见），并不比 `disable` 干净。
 * 既然两者都留痕，就选语义更安全的那个：plist 若被别的途径放回也不会自动启动。
 * 而 startService 恒无条件 `enable`，残留位不影响任何正常路径。
 */
export function uninstallService(): void {
  assertServiceLabelSafe();

  const target = shellQuote(serviceTarget());
  runLaunchctlSteps(
    [`launchctl bootout ${target} 2>/dev/null || true`, `launchctl disable ${target} 2>/dev/null || true`, `rm -f ${shellQuote(PATHS.userAgentPlist)}`],
    { action: '卸载服务' },
  );

  killResidualKernels();

  // 符号链是本工具装的，卸载时一并清掉（内核本体保留，那是 kernel 命令的资产）
  try {
    fs.unlinkSync(PATHS.serviceBinary);
  } catch {
    /* ignore：不存在或已被 reset kernel 带走 */
  }
}

/**
 * 清理遗留的系统级安装（v3.0–v4.0 的 `daemon on` 装的 root LaunchDaemon）。
 *
 * 需要一次密码：plist 是 root:wheel 拥有的，且 `launchctl bootout system/...` 需 root。
 * 顺带把 root 属主的日志/数据归还当前用户——不归还的话，之后的用户级服务会因
 * EACCES 写不了日志而起不来。
 */
export function cleanupLegacySystemInstall(): void {
  assertServiceLabelSafe();

  const script = [
    '#!/bin/bash',
    `launchctl bootout ${shellQuote(`system/${SERVICE_LABEL}`)} 2>/dev/null || true`,
    `rm -f ${shellQuote(PATHS.systemDaemonPlist)}`,
    `chown "$SUDO_UID:$SUDO_GID" ${shellQuote(PATHS.logFile)} 2>/dev/null || true`,
    `chown -R "$SUDO_UID:$SUDO_GID" ${shellQuote(DIRS.data)} 2>/dev/null || true`,
    `rm -f ${shellQuote(PATHS.pidFile)}`,
    'exit 0',
    '',
  ].join('\n');

  runSudoScript(script, { action: '清理遗留的系统级服务', file: 'legacy-cleanup.sh' });
}

// === 热重载与重启 ===

function logOversized(): boolean {
  try {
    return fs.statSync(PATHS.logFile).size > LOG_ROTATE_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * 经 external-controller 热重载配置（走 localhost、免 sudo）。成功返回 true。
 * 用空 body：内核重新加载它启动时 `-f` 指定的配置文件（正是我们写入的 configFile）。
 * 不传 {path}——mihomo 的 SAFE_PATHS 限制只允许 workdir/home 下的路径，
 * 而 configFile 在 runtime/ 下会被拒成 400；空 body 重载 `-f` 文件天然规避该限制。
 *
 * 返回 false 即回退 kickstart（重启内核），因此**「重载被内核拒绝」是安全的**：
 * 配置解析失败时 mihomo 返回 4xx，这里判 false，坏配置不会被当成生效。
 * 但也正因回退路径会真的重启内核，调用方必须对回退结果做健康检查——
 * 见 restartService 的返回值与 launchOrRestart。
 */
async function tryHotReload(): Promise<boolean> {
  // 先确认 9090 上确实是我们托管的服务内核，再把配置变更托付给它。
  // 只看「服务已装」+ PUT 返回 2xx 是不够的：9090 被其他服务占用（另一个 Clash、
  // 开发服务器）且对该 PUT 返回 2xx 时，CLI 会打印「已启动」而服务内核仍跑旧配置——
  // 配置变更静默未生效，是最难排查的一类失败。
  const status = getServiceStatus();
  if (!status.running || status.pid === null) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOT_RELOAD_TIMEOUT_MS);
  // 配置了 controller_secret 时必须带 Bearer，否则内核返回 401 → 热重载恒失败回退重启
  const secret = readSettings().controller_secret;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  try {
    // /version 是 mihomo 特有端点，返回体带 version 字段；用它确认应答方是 mihomo
    // 而非碰巧监听同端口的其他程序（后者极可能对未知路径的 PUT 也返回 2xx）
    const probe = await fetch(`${CONTROLLER_BASE_URL}/version`, { headers, signal: controller.signal });
    if (!probe.ok) return false;
    const info = (await probe.json()) as { version?: unknown };
    if (typeof info?.version !== 'string') return false;

    const res = await fetch(`${CONTROLLER_BASE_URL}/configs?force=true`, {
      method: 'PUT',
      headers,
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
 * 重启托管内核使配置变更生效。优先热重载（PUT /configs，免 sudo、免 launchctl）；
 * 失败才回退 kickstart。kickstart -k 是命令式重启，不与 KeepAlive 冲突；
 * 若任务未装载（plist 在但被手动 bootout）则 bootstrap 自愈。
 *
 * 返回 `hotReloaded` 供调用方决定是否做启动健康检查：热重载没有重启进程
 * （配置被内核接受才返回 204，被拒是 400 → 回退 kickstart），无需再验；
 * 走了 kickstart 就等于重启了内核，必须验，否则坏配置会静默进入 KeepAlive 崩溃循环。
 *
 * 日志超阈值时跳过热重载、强制 kickstart 顺便轮转：运行中不能 rename 轮转——
 * launchd 的 StandardOutPath fd 指向旧 inode，rename 后日志会继续写进归档文件。
 * 只能 copy-truncate（fd 为 O_APPEND，truncate 后从 0 续写不丢句柄）。
 */
export async function restartService(): Promise<{ hotReloaded: boolean }> {
  if (!isServiceInstalled()) {
    throw new CliError('服务未安装，无法重启', { hint: '安装服务: mihomo install' });
  }

  if (!logOversized() && (await tryHotReload())) return { hotReloaded: true };

  const target = shellQuote(serviceTarget());
  const dest = shellQuote(PATHS.userAgentPlist);
  const logFile = shellQuote(PATHS.logFile);
  const archiveFile = shellQuote(path.join(DIRS.logs, `mihomo.${formatLocalTimestamp()}.log`));

  runLaunchctlSteps(
    [
      `if [ -f ${logFile} ] && [ "$(stat -f%z ${logFile} 2>/dev/null || echo 0)" -gt ${LOG_ROTATE_MAX_BYTES} ]; then`,
      `  cp ${logFile} ${archiveFile} 2>/dev/null && : > ${logFile}`,
      'fi',
      `if launchctl kickstart -k ${target} 2>/dev/null; then exit 0; fi`,
      `launchctl enable ${target} 2>/dev/null || true`,
      `launchctl bootstrap ${bootstrapDomain()} ${dest} || exit 3`,
    ],
    { action: '重启服务', codeMessages: { 3: '重启服务失败（launchctl bootstrap）' } },
  );

  // 顺手清理过期归档：归档可能为 root 属主，但 logs/ 目录归用户所有，unlink 只看目录权限
  cleanupOldLogs();

  return { hotReloaded: false };
}

/** 符号链名，供命令层展示「登录项与扩展」里会看到的名字 */
export { SERVICE_BINARY_NAME };
