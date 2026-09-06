import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigInfo } from './config.js';
import { isValidServiceLabel, RAW_SERVICE_LABEL_INPUT, SERVICE_BINARY_NAME, SERVICE_LABEL } from './constants.js';
import { CliError } from './errors.js';
import { allocateArchivePath, cleanupOldLogs, rotateAndCleanupLogs } from './log-files.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS, withFileLock } from './paths.js';
import { getMihomoPids, isPidFileOwnedByRoot, isProcessRoot, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import { getPorts, readSettings } from './settings.js';
import { runSudoScript } from './sudo.js';
import type { ServiceStatus } from './types.js';
import { shellQuote, sleep } from './utils.js';

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
 *
 * **信号死亡走另一个字段**（实测 macOS 26.6，v4.7.3 补）：被 `kill -9` 时 launchd
 * 写 `\tlast terminating signal = Killed: 9`，而 `last exit code` **整行消失**——
 * 只解析退出码的话 OOM killer / 手工 kill 掉的内核对 isCrashed 与 status 完全不可见，
 * 用户看到的是「不在运行」却无任何异常提示，排查方向被指反。
 * 两字段互斥且不跨 bootstrap 残留（实测：重新 bootstrap 后正常退出只剩 last exit code）。
 */
export function parseServicePrint(output: string): {
  state: string | null;
  pid: number | null;
  lastExitCode: number | null;
  lastTerminatingSignal: string | null;
} {
  const stateMatch = output.match(/^\tstate = (.+)$/m);
  const pidMatch = output.match(/^\tpid = (\d+)$/m);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
  // 只匹配纯数字：`(never exited)` 不是失败信号，必须与「退出码 0」区分开
  const exitMatch = output.match(/^\tlast exit code = (\d+)$/m);
  const lastExitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;
  // 形如 `Killed: 9` / `Terminated: 15`（两种实测）。原样保留给用户看，比裸数字可读
  const signalMatch = output.match(/^\tlast terminating signal = (.+)$/m);
  return {
    state: stateMatch ? stateMatch[1].trim() : null,
    pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
    lastExitCode: lastExitCode !== null && Number.isInteger(lastExitCode) ? lastExitCode : null,
    lastTerminatingSignal: signalMatch ? signalMatch[1].trim() : null,
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

function runLaunchctl(args: string[], timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): { status: number | null; stdout: string; stderr: string } {
  try {
    const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: timeoutMs });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch {
    return { status: null, stdout: '', stderr: '' };
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
 * 单独查询 disable 位。 getServiceStatus 走不通：它在「未安装且未装载」时提前返回，
 * 不查 disabled 表——而「服务从未装过、起 TUN 前关自启」恰恰是这个形态。
 */
function isServiceDisabledInLaunchd(): boolean {
  const out = runLaunchctl(['print-disabled', bootstrapDomain()]);
  assertLaunchctlQueryOk(out.status, 'print-disabled');
  return out.status === 0 ? parseDisabledList(out.stdout, SERVICE_LABEL) : false;
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
    return { installed: false, loaded: false, running: false, pid: null, disabled: false, lastExitCode: null, lastTerminatingSignal: null };
  }

  const { state, pid, lastExitCode, lastTerminatingSignal } = loaded
    ? parseServicePrint(print.stdout)
    : { state: null, pid: null, lastExitCode: null, lastTerminatingSignal: null };
  const disabled = isServiceDisabledInLaunchd();

  return { installed, loaded, running: state === 'running', pid, disabled, lastExitCode, lastTerminatingSignal };
}

/** 服务启动后的健康判定结果。`crashed` 为真时内核已被 launchd 反复拉起，不是可用状态。 */
export interface ServiceHealth {
  healthy: boolean;
  crashed: boolean;
  pid: number | null;
  exitCode: number | null;
  /** 信号死亡时的信号描述（如 `Killed: 9`）；退出码死亡为 null。与 exitCode 互斥 */
  terminatingSignal: string | null;
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
      return { healthy: false, crashed: true, pid: null, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
    }
    if (!last.loaded) {
      // 已卸载（被外部 bootout，或 plist 装不进来），继续等无意义
      return { healthy: false, crashed: false, pid: null, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
    }
  }

  if (last.running) return { healthy: true, crashed: false, pid: last.pid, exitCode: null, terminatingSignal: null };

  // 第二阶段：窗口结束仍未 running（慢机器上内核起得慢，或正在 spawn 重试），再宽限一会儿
  while (Date.now() < graceDeadline) {
    await sleep(SERVICE_HEALTH_INTERVAL_MS);
    last = getServiceStatus();

    if (isCrashed(last)) {
      return { healthy: false, crashed: true, pid: null, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
    }
    if (!last.loaded) break;
    if (last.running) return { healthy: true, crashed: false, pid: last.pid, exitCode: null, terminatingSignal: null };
  }

  return { healthy: false, crashed: false, pid: last.pid, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
}

/**
 * 死因的人类可读描述，正常退出（或没有记录）时返回 null。
 *
 * **异常退出判据的唯一一份**。两个字段缺一不可——launchd 对信号死亡只写
 * `last terminating signal`，`last exit code` 整行消失（实测，见 parseServicePrint）。
 * 只看退出码的话，被 OOM killer 或 `kill -9` 干掉的内核判不出崩溃。
 *
 * 判据必须收口在这里，别在调用点散写 `lastExitCode !== 0`：v4.7.3 补信号判据时
 * status/doctor 收口成了 describeAbnormalExit，却漏了 `runtime.assertServiceHealthy`
 * ——那里仍拼 `退出码 ${exitCode}`，信号死亡时 exitCode 为 null，用户在 start 期间
 * 被 OOM 杀掉的内核只看到「退出码 null」。三个消费者（isCrashed 判有无、
 * describeAbnormalExit 供 status/doctor、assertServiceHealthy 供 start/install）
 * 现在共用同一份判据，补条件只需改这里。
 */
export function describeExitCause(exitCode: number | null, terminatingSignal: string | null): string | null {
  if (terminatingSignal !== null) return `被信号终止（${terminatingSignal}）`;
  if (exitCode !== null && exitCode !== 0) return `退出码 ${exitCode}`;
  return null;
}

/** 「起来过又挂了」：当前不在跑，且本次启动记录了异常死因（非 0 退出码或致命信号）。 */
function isCrashed(status: ServiceStatus): boolean {
  if (status.running) return false;
  return describeExitCause(status.lastExitCode, status.lastTerminatingSignal) !== null;
}

/** 「上次异常退出」的人类可读描述，无异常时返回 null。供 status / doctor 共用。 */
export function describeAbnormalExit(status: ServiceStatus): string | null {
  return describeExitCause(status.lastExitCode, status.lastTerminatingSignal);
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
 * 执行一条 launchctl 写操作并要求成功（退出码 0）。
 *
 * 用户域操作全程免密，直接 spawn 即可——此前拼成 bash 脚本 + 自定义退出码协议
 * （2/3/4/5/6/7 + codeMessages 映射）的做法既不可单测，又多一层 shell 注入面；
 * 只有需要 root 的路径（cleanupRootResidue / cleanupLegacySystemInstall / TUN）
 * 才保留 runSudoScript 的脚本形式。
 *
 * launchctl 失败时把 stderr 收进 hint——它的报错文本（如 "Bootstrap failed: 5: I/O error"）
 * 是排查的主要线索；旧脚本经 stdio:'inherit' 直接漏给终端，错误消息里反而没有。
 */
function runLaunchctlOrThrow(args: string[], what: string): void {
  const result = runLaunchctl(args);
  if (result.status === 0) return;
  const detail = result.stderr.trim();
  throw new CliError(`${what}失败（launchctl 退出码 ${result.status ?? '执行失败'}）`, {
    hint: [detail, `手动确认: launchctl ${args.join(' ')}`].filter(Boolean),
  });
}

/**
 * bootout 旧实例。容忍「未装载」：实测该情形退出码为 **3**（"Boot-out failed: 3:
 * No such process"），文档化的 113（目标未找到）同样收下——旧脚本用 `|| true` 全吞、
 * 再靠 waitUntilUnloaded 判定。这里把「未装载」与「查询失败」分开：
 * 112/125 域错误等其他退出码直接抛，不伪装成「无事发生」。
 */
function bootoutService(): void {
  const result = runLaunchctl(['bootout', serviceTarget()]);
  if (result.status === 0 || result.status === 3 || result.status === LAUNCHCTL_NOT_LOADED) return;
  const detail = result.stderr.trim();
  throw new CliError(`卸载旧服务实例失败（launchctl bootout 退出码 ${result.status ?? '执行失败'}）`, {
    hint: [detail, `手动确认: launchctl print ${serviceTarget()}`].filter(Boolean),
  });
}

/** 轮询上限与节奏（与旧 bash 实现一致：最多 5s） */
const UNLOADED_POLL_ATTEMPTS = 25;
const UNLOADED_POLL_INTERVAL_MS = 200;

/**
 * 等待 bootout 真正完成并**判定结果**（轮询最多 5s）。
 *
 * `launchctl bootout` 返回不代表任务已卸载——内核可能还持着监听端口。紧接着的
 * bootstrap 若撞上「尚未卸载完成」会报 error 5，与 disabled 的报错完全同形，极难排查。
 *
 * 判定语义（旧实现只有等待、没有判定，轮询用尽后静默放行）：
 *   - print 退出码 113（未装载）= 已卸载，通过
 *   - 112/125 等 = **查询失败**，抛错——不能当「已卸载」，与 assertLaunchctlQueryOk
 *     「查询失败 ≠ 目标不存在」同一原则
 *   - 25 次轮询用尽仍装载 = bootout 未生效，抛错——带着「任务仍装载」往下走，
 *     正是「报停止成功而 KeepAlive 约 10s 后拉回内核」的静默失效
 *
 * async + sleep：轮询必须让出事件循环，否则 stop 卡住期间 Ctrl+C 无响应
 * （与 cleanupAll 同一原则；旧实现把轮询塞进 spawnSync 的 bash 脚本，同样阻塞事件循环）。
 *
 * 注：本机实测 16 次连续 `bootout → bootstrap`（含持监听端口的进程）**未能复现**该竞态，
 * 故这是预防性防御而非已复现问题的修复。成本是不发生时零开销（首轮 print 即退出），
 * 留着比赌它不发生划算。
 *
 * @param target 仅供测试注入（默认本服务目标）：传一个保证未装载的 label 即可只读验证
 */
export async function waitUntilUnloaded(target: string = serviceTarget()): Promise<void> {
  for (let i = 0; i < UNLOADED_POLL_ATTEMPTS; i++) {
    const result = runLaunchctl(['print', target]);
    if (result.status === LAUNCHCTL_NOT_LOADED) return;
    if (result.status !== 0) {
      throw new CliError(`无法确认服务已卸载（launchctl print 退出码 ${result.status ?? '执行失败'}）`, {
        hint: ['这不代表服务仍装载，只表示查询没成立。', `手动确认: launchctl print ${target}`],
      });
    }
    await sleep(UNLOADED_POLL_INTERVAL_MS);
  }
  throw new CliError('服务卸载超时，任务仍处于装载状态（bootout 未生效）', {
    hint: ['带着「任务仍装载」往下走，正是「报停止成功而 KeepAlive 约 10s 后拉回内核」的静默失效。', `手动确认: launchctl print ${target}`],
  });
}

/**
 * 以 root 清理残留内核与 root 属主的 pid 文件。
 * **只在确实存在 root 残留时调用**——正常的用户级路径不应因此弹密码。
 * root 残留的唯一来源是 `tun`（sudo 起的内核）与系统级服务。
 */
function cleanupRootResidue(): void {
  const rootPids = getMihomoPids().filter(isProcessRoot);
  if (rootPids.length === 0 && !isPidFileOwnedByRoot()) return;

  const script = [
    '#!/bin/bash',
    // pkill 退出码 2/3 是 pattern 编译失败等探测性错误，不能当「没有进程」吞掉
    // （与 killAllMihomo 只收 0/1 同一原则）
    `pkill -9 -f ${shellQuote(MAIN_INSTANCE_PATTERN)} 2>/dev/null`,
    'rc=$?',
    '[ $rc -le 1 ] || exit 2',
    `rm -f ${shellQuote(PATHS.pidFile)}`,
    'exit 0',
    '',
  ].join('\n');
  runSudoScript(script, { action: '清理残留进程', file: 'cleanup-residue.sh', codeMessages: { 2: '终止残留内核失败（pkill 退出码异常）' } });
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
 * 安装/重装服务。
 *
 * 幂等：可反复执行。`wasRunning` 为真时装完恢复运行（避免「代理开着时更新后重装静默关掉代理」），
 * 首装则显式 `disable`——install 只负责装，启动是 `start` 的事。
 *
 * 前置只要求内核存在（plist 指向它）；**不要求 config.yaml**，因为装完不启动。
 */
export async function installService(wasRunning: boolean): Promise<void> {
  assertServiceLabelSafe();
  ensureDirs();
  ensureServiceSymlink();

  const stagePath = path.join(DIRS.runtime, 'service.plist.stage');
  atomicWriteFileSync(stagePath, buildPlist(), { mode: 0o600 });

  try {
    // plutil -lint 先行：坏 plist 绝不进系统目录（bootstrap 失败后还得手工清理）
    const lint = spawnSync('plutil', ['-lint', stagePath], { encoding: 'utf8', timeout: 10_000 });
    if (lint.status !== 0) {
      throw new CliError('plist 语法校验失败（plutil -lint）', {
        hint: [(lint.stderr || lint.stdout || '').trim()].filter(Boolean),
      });
    }

    // 重装分支必须 enable 在 bootstrap 之前，且顺序不可换：**bootstrap 一个 disabled 的
    // label 不是「加载后不启动」，而是硬失败 `Bootstrap failed: 5: Input/output error`**
    // （本机实测）。而 `stop` 恒置 disable 位，所以「stop 之后重装」是必经路径，
    // 少了 enable 这里就 100% 失败。
    bootoutService();
    await waitUntilUnloaded();

    // ~/Library/LaunchAgents 在全新系统上可能不存在；recursive 对已存在目录是 no-op，不改权限
    fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
    fs.copyFileSync(stagePath, PATHS.userAgentPlist);
    fs.chmodSync(PATHS.userAgentPlist, 0o644);

    if (wasRunning) {
      withFileLock(PATHS.serviceLock, () => {
        runLaunchctlOrThrow(['enable', serviceTarget()], '启用服务');
        runLaunchctlOrThrow(['bootstrap', bootstrapDomain(), PATHS.userAgentPlist], '装载服务');
      });
    }

    // bootstrap 失败**不删 plist**：失败后落到「已安装未装载」这个干净可恢复的状态，
    // 用户 `mh start` 即可重试。删掉的话，「重装」会被静默升级成「卸载」——
    // 用户以为装着，实际什么都没有。
  } finally {
    try {
      fs.unlinkSync(stagePath);
    } catch {
      /* ignore */
    }
  }

  if (!wasRunning) {
    // 首装关自启放脚本外：disableServiceAutoStart 自带事后确认。此前在脚本里
    // `|| true` 地跑，失败时用户拿到「已安装」，而 RunAtLoad 会让它下次登录自启
    disableServiceAutoStart();
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
export async function startService(): Promise<void> {
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

  // 先 bootout 清旧使重复调用幂等（改过 plist 后 start 一下即按新配置重载，无需 kickstart）
  bootoutService();
  await waitUntilUnloaded();

  // 轮转日志。**必须卡在这个窗口**：旧进程已退出、新进程尚未 bootstrap，此时无人持有
  // 日志 fd，rename 才真正生效。运行中做 rename 是无效的——launchd 的 StandardOutPath
  // fd 指向旧 inode，改名后内核会继续往归档文件里写（restartService 因此只能 copy-truncate）。
  //
  // 此前整个服务路径都不轮转（rotateAndCleanupLogs 只在 startTun 里调），于是默认的
  // Mixed 模式下 mihomo.log 无限增长、`logs` 的归档列表恒为空，与 README 承诺的
  // 「自动轮转，保留 7 天」不符。
  rotateAndCleanupLogs();

  // enable 必须在 bootstrap 之前（见 installService 的注释）；stop 恒置 disable 位，
  // 「stop 之后再 start」是最常走的路径
  //
  // 跨进程锁：慢速 start（订阅自动更新 ~10s）期间另一终端 stop 会 bootout+disable，
  // start 随后的 enable+bootstrap 会把自启位又打开，终态与用户最后一条命令相反。
  // 锁串行化 enable/bootstrap 与 stop 的 bootout/disable；锁内再查一次 disabled，
  // 若 stop 在等待期间已跑完则跳过启动（用户最后一条命令是 stop）
  withFileLock(PATHS.serviceLock, () => {
    if (isServiceDisabledInLaunchd()) {
      // 服务在等待期间被 stop（或 TUN 启动前的 disableServiceAutoStart）停掉了，
      // 不重新拉起——用户最后一条命令是 stop
      return;
    }
    runLaunchctlOrThrow(['enable', serviceTarget()], '启用服务');
    runLaunchctlOrThrow(['bootstrap', bootstrapDomain(), PATHS.userAgentPlist], '启动服务');
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

  runLaunchctlOrThrow(['disable', serviceTarget()], '关闭服务自启');

  // 事后确认：命令成功 ≠ 位生效。这是 TUN 防线的第一层，而开机自启路径不经过 CLI
  // （登录时 launchd 直接扫 plist），第二层「startService 拒绝 TUN 配置」在那条路径上
  // 不生效——失败必须让用户看见，否则重启后就是「代理不通、日志刷爆」且无任何线索
  if (!isServiceDisabledInLaunchd()) {
    throw new CliError('关闭服务自启失败：disable 位未生效', {
      hint: [`手动确认: launchctl print-disabled ${bootstrapDomain()}`, '', '不关闭自启的话，重启后服务会拿 TUN 配置反复拉起必然失败的内核。'],
    });
  }
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
export async function stopService(): Promise<void> {
  assertServiceLabelSafe();

  // 跨进程锁：与 startService 的 enable/bootstrap 串行化，
  // 防止慢速 start（订阅更新 ~10s）期间 stop 的 bootout/disable 被 start 随后的 enable 覆盖
  // 不加 await：withFileLock 是同步的，且要求 fn 同步（持锁期间让出事件循环等于没锁）
  withFileLock(PATHS.serviceLock, () => {
    bootoutService();
    disableServiceAutoStart();
  });

  await waitUntilUnloaded();

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
export async function uninstallService(): Promise<void> {
  assertServiceLabelSafe();

  // 跨进程锁：与 startService 的 enable/bootstrap 串行化（withFileLock 同步，见 stopService）
  withFileLock(PATHS.serviceLock, () => {
    bootoutService();
    disableServiceAutoStart();
  });

  await waitUntilUnloaded();

  // rm 失败必须可见：plist 还在的话登录时又被扫到，「已卸载」就是谎报
  // （旧脚本 `rm -f ... || exit 3` 同一语义）
  try {
    fs.rmSync(PATHS.userAgentPlist, { force: true });
  } catch (e) {
    throw new CliError(`删除 plist 失败（${PATHS.userAgentPlist}）: ${(e as Error).message}`);
  }

  // disable 位残留表里是刻意的（见函数头注释），但必须确认它真的是 disabled——
  // enable 位还开着的话，plist 被别的途径放回（重装、备份恢复）即自启
  disableServiceAutoStart();

  killResidualKernels();

  // 符号链是本工具装的，卸载时一并清掉（内核本体保留，那是 kernel 命令的资产）
  try {
    fs.rmSync(PATHS.serviceBinary, { force: true });
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
    // bootout 退出码分级：113=未装载（daemon 已不在，正常），其余是真实失败。
    // 此前 || true 吞掉所有错误，daemon 仍在跑却继续 rm plist 并报「已清理」
    `bootout_code=0`,
    `launchctl bootout ${shellQuote(`system/${SERVICE_LABEL}`)} 2>/dev/null || bootout_code=$?`,
    `if [ $bootout_code -ne 0 ] && [ $bootout_code -ne 113 ]; then`,
    `  echo "launchctl bootout 失败（退出码 $bootout_code）" >&2`,
    `  exit 1`,
    `fi`,
    `rm -f ${shellQuote(PATHS.systemDaemonPlist)}`,
    `chown "$SUDO_UID:$SUDO_GID" ${shellQuote(PATHS.logFile)} 2>/dev/null || true`,
    `chown -R "$SUDO_UID:$SUDO_GID" ${shellQuote(DIRS.data)} 2>/dev/null || true`,
    `rm -f ${shellQuote(PATHS.pidFile)}`,
    'exit 0',
    '',
  ].join('\n');

  runSudoScript(script, { action: '清理遗留的系统级服务', file: 'legacy-cleanup.sh' });
}

/**
 * 清理遗留 root LaunchDaemon 并把 runSudoScript 的普通 Error 包成 CliError——
 * 否则 sudo 取消密码 / 非 TTY 这类常规操作会带完整堆栈按「未预期错误」渲染。
 * install / uninstall / stop / start(tun) / reset 共用。
 *
 * 放在 service.ts 而非 commands/shared.ts：shared.ts 被 start.ts 导入（restartToApply），
 * 若 start.ts 再反向导入 shared.ts 就成环。放这里依赖方向单向（commands → service）。
 */
export function cleanupLegacyInstallOrThrow(): void {
  try {
    cleanupLegacySystemInstall();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, {
      label: '清理遗留服务失败',
      hint: ['也可手动清理:', `  sudo launchctl bootout system/$(basename ${PATHS.systemDaemonPlist} .plist)`, `  sudo rm -f ${PATHS.systemDaemonPlist}`],
    });
  }
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
  // 先确认 controller 端口上确实是我们托管的服务内核，再把配置变更托付给它。
  // 只看「服务已装」+ PUT 返回 2xx 是不够的：该端口被其他服务占用（另一个 Clash、
  // 开发服务器）且对该 PUT 返回 2xx 时，CLI 会打印「已启动」而服务内核仍跑旧配置——
  // 配置变更静默未生效，是最难排查的一类失败。
  const status = getServiceStatus();
  if (!status.running || status.pid === null) return false;

  // 端口经 settings.ports 解析（默认 9090），与 buildConfig 写进配置的值同源
  const baseUrl = `http://127.0.0.1:${getPorts().controller}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOT_RELOAD_TIMEOUT_MS);
  // 配置了 controller_secret 时必须带 Bearer，否则内核返回 401 → 热重载恒失败回退重启
  const secret = readSettings().controller_secret;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  try {
    // /version 是 mihomo 特有端点，返回体带 version 字段；用它确认应答方是 mihomo
    // 而非碰巧监听同端口的其他程序（后者极可能对未知路径的 PUT 也返回 2xx）
    const probe = await fetch(`${baseUrl}/version`, { headers, signal: controller.signal });
    if (!probe.ok) return false;
    const info = (await probe.json()) as { version?: unknown };
    if (typeof info?.version !== 'string') return false;

    // /version 只确认「端口上是个 mihomo」，挡不住「另一个 mihomo」（手工起的实例、
    // 端口冲突）。用 lsof 取监听 pid 与服务 pid 比对，不一致则回退 kickstart
    const port = getPorts().controller;
    const lsofResult = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 });
    if (lsofResult.status !== 0) return false;
    const listenerPid = Number.parseInt(lsofResult.stdout.trim(), 10);
    if (!Number.isFinite(listenerPid) || listenerPid !== status.pid) return false;

    const res = await fetch(`${baseUrl}/configs?force=true`, {
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

  // 日志超阈值时跳过热重载、强制 kickstart 顺便轮转：运行中不能 rename 轮转——
  // launchd 的 StandardOutPath fd 指向旧 inode，rename 后日志会继续写进归档文件。
  // 只能 copy-truncate（fd 为 O_APPEND，truncate 后从 0 续写不丢句柄）。
  if (logOversized()) {
    // 归档路径经 allocateArchivePath（log-files.ts 的单一命名规则）：同一秒内两次轮转
    // 会互相覆盖归档（copyFileSync 静默覆盖），它负责追加序号后缀
    const archiveFile = allocateArchivePath();
    try {
      fs.copyFileSync(PATHS.logFile, archiveFile);
      fs.writeFileSync(PATHS.logFile, '');
    } catch {
      /* 轮转失败不阻塞重启（与旧脚本的 best-effort 语义一致） */
    }
  }

  // kickstart -k 是命令式重启，不与 KeepAlive 冲突；任务未装载（plist 在但被手动 bootout）
  // 则 enable + bootstrap 自愈（旧脚本：kickstart 失败 → enable || true → bootstrap || exit 3）。
  //
  // kickstart -k 会**阻塞等进程死亡**（实测对不立即响应 SIGTERM 的进程可超过 5s），
  // 不能用 runLaunchctl 的查询超时（5s）——旧脚本整体超时是 60s，这里单独放宽
  const kick = runLaunchctl(['kickstart', '-k', serviceTarget()], 60_000);
  if (kick.status !== 0) {
    runLaunchctl(['enable', serviceTarget()]); // 容忍失败：bootstrap 会再判一次
    runLaunchctlOrThrow(['bootstrap', bootstrapDomain(), PATHS.userAgentPlist], '重启服务');
  }

  // 顺手清理过期归档：归档可能为 root 属主，但 logs/ 目录归用户所有，unlink 只看目录权限
  cleanupOldLogs();

  return { hotReloaded: false };
}

/** 符号链名，供命令层展示「登录项与扩展」里会看到的名字 */
export { SERVICE_BINARY_NAME };
