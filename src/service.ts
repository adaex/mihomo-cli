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
import { runSudoScript, SudoAuthError } from './sudo.js';
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
/**
 * stop/uninstall **锁内** launchctl 调用的单次超时。
 *
 * 为什么比默认 5s 短：stop 侧锁体含**三次** launchctl（bootout、disable、print-disabled
 * 复核），按默认超时最坏持锁 15s，超出 `LOCK_STALE_MS`（10s，paths.ts）——并发 start
 * 等锁超过 10s 会按「持锁者已死」强夺进入，两进程同处临界区，停止计数判据被整体
 * 绕过（判据的全部意义就是防这个交错）。3s × 3 = 9s，收回阈值内；start 侧锁内
 * 两次调用（enable + bootstrap）维持默认 5s、合计恰等于阈值，是既有基线，不动。
 *
 * 为什么不能用「缩到两次调用」修——三个环节谁也挪不出锁：
 * - 复核必须在递增**之前**：位没真生效就不该记「停止过」，否则一次失败的 disable
 *   会让并发 start 白白中止（下方 disableServiceAutoStart「放在确认之后」防的事）
 * - 递增必须在锁内、紧随 disable：挪到锁外的话，并发 start 会在「disable 完成」与
 *   「递增落地」之间拿到锁，读不到计数变化，enable + bootstrap 照常覆盖这次停止
 * - bootout 必须与 disable 同锁：bootout 挪到锁前，并发 start 的 bootstrap 能滑进
 *   两者之间，stop 收尾时服务仍是 loaded + KeepAlive，杀掉的内核约 10s 后被拉回
 * 故只能压单次超时。
 *
 * 3s 的余量论证：锁内三次都是本机 XPC 往返——print/print-disabled 实测 3ms（见
 * getServiceStatus），disable 是同类的本地写；仓库里唯一实测会阻塞数秒的 launchctl
 * 是 kickstart -k（阻塞等进程死亡，故单独 60s 且刻意留在锁外），bootout 发出卸载
 * 请求即返回、不等进程死透（waitUntilUnloaded 的轮询正为此存在）。launchctl 慢到
 * 3s 不够说明系统已病态，此时快速失败（bootout/disable 抛 CliError）比持锁超时更
 * 安全：后者会静默拆掉整条并发防线。
 */
// 导出供 service-concurrency.spec 的常量关系断言（调用次数 × 单次预算 < 强夺阈值）消费
export const SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS = 3_000;

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
 *
 * @param timeoutMs stop/uninstall 在 serviceLock 内调用时传 SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS
 *   （持锁预算见该常量注释）；锁外调用保持默认 5s
 */
function isServiceDisabledInLaunchd(timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): boolean {
  const out = runLaunchctl(['print-disabled', bootstrapDomain()], timeoutMs);
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
function runLaunchctlOrThrow(args: string[], what: string, timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): void {
  const result = runLaunchctl(args, timeoutMs);
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
function bootoutService(timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): void {
  const result = runLaunchctl(['bootout', serviceTarget()], timeoutMs);
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

/** root 残留清理失败包装的上下文：主体动作进行到哪一步、重试入口，三个调用点各不相同 */
export interface RootResidueCleanupContext {
  /** 主体动作的结果描述，如「服务已停止，登录自启已关闭」；start 路径是「服务尚未启动」 */
  mainOutcome: string;
  /** 重新尝试清理的命令，如 'mihomo stop' */
  retryCommand: string;
}

/**
 * 把 root 残留清理（经 runSudoScript）抛出的普通 Error 包成 CliError——纯函数，供测试。
 *
 * 此前这类 Error 从停止类命令裸露：stop / uninstall / reset 的消费点都没有 try/catch，
 * 带完整堆栈按「未预期错误」（main().catch 兜底）渲染，而 start 的兜底又包成「启动失败」
 * ——同一错误在不同命令下渲染完全不同。统一在这里说清三件关键事实：
 * 主体动作已完成到哪一步、root 残留还在（带 PID）、重试入口。
 *
 * sudo 取消（SudoAuthError）是用户主动行为，label 用「已取消」而非「错误」；
 * 其余失败（脚本退出码 ≥2 / 被信号终止 / 非 TTY）保留 runSudoScript 的原始消息。
 *
 * 仅 pid 文件、无 root 进程的失败只可能来自 start 路径（killResidualKernels 仅在
 * 有 root 进程时才调用清理），pid 文件残留也由 start 的同一入口重试，故重试提示对
 * 两种形态都成立；stop 对「无进程 + 仅 pid 文件」会走「不在运行」提前返回，清不到它。
 */
export function buildRootResidueCleanupError(e: Error, ctx: RootResidueCleanupContext, rootPids: number[]): CliError {
  const cancelled = e instanceof SudoAuthError;
  const hasKernelResidue = rootPids.length > 0;
  const hint = [
    ctx.mainOutcome,
    hasKernelResidue ? `root 残留内核仍在运行（PID ${rootPids.join(', ')}），可能继续占用代理端口` : `root 属主的 pid 文件未被清理: ${PATHS.pidFile}`,
    `重新运行可再次尝试清理: ${ctx.retryCommand}`,
  ];
  hint.push(hasKernelResidue ? '手动清理: sudo pkill -9 mihomo' : `手动清理: sudo rm -f ${PATHS.pidFile}`);
  if (cancelled) {
    return new CliError('管理员密码未输入或有误，root 残留未被清理', { label: '已取消', hint });
  }
  return new CliError(e.message, { label: '清理残留进程失败', hint });
}

/** 错误处理路径上的残留探测：探测再失败也不能让它替换掉正要渲染的清理失败本身 */
function currentRootResiduePids(): number[] {
  try {
    return getMihomoPids().filter(isProcessRoot);
  } catch {
    return [];
  }
}

/**
 * cleanupRootResidue 的「失败即 CliError」版本：runSudoScript 的普通 Error 统一经
 * buildRootResidueCleanupError 包装（同族范式见 cleanupLegacyInstallOrThrow——那里同样
 * 是为了不让 sudo 取消/非 TTY 带着堆栈按「未预期错误」渲染）。探测已抛 CliError 时透传。
 */
function cleanupRootResidueOrThrow(ctx: RootResidueCleanupContext): void {
  try {
    cleanupRootResidue();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw buildRootResidueCleanupError(e as Error, ctx, currentRootResiduePids());
  }
}

/**
 * 终止残留内核。用户态进程直接 kill；有 root 残留才提一次权。
 * 失败经 ctx 包装成 CliError：说清主体动作已完成、残留还在、如何重试。
 */
function killResidualKernels(ctx: RootResidueCleanupContext): void {
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
  if (rootPids.length > 0) cleanupRootResidueOrThrow(ctx);
}

/**
 * 安装/重装服务。
 *
 * 幂等：可反复执行。`wasRunning` 为真时装完恢复运行（避免「代理开着时更新后重装静默关掉代理」），
 * 首装则显式 `disable`——install 只负责装，启动是 `start` 的事。
 *
 * 前置只要求内核存在（plist 指向它）；**不要求 config.yaml**，因为装完不启动。
 *
 * 返回 `restoreSkipped=true` 表示 `wasRunning` 的恢复运行被**并发的 stop** 取消
 * （安装本身已成功）。调用方必须据此跳过健康确认——否则会对着一个本就不该启动的服务
 * 报「恢复运行失败」，把用户的 stop 说成故障。
 *
 * @param stopEpochBefore 命令开始时的停止计数快照，取自 `cmdInstall` 的第一步。
 *   与 `startService` 同一约定：**不能在本函数内部现取**。真正的危害窗口是
 *   「产生 `wasRunning=true` 的那次 `getServiceStatus()`」到下方锁之间——中间有
 *   `plutil -lint`、`bootoutService()` 与 `waitUntilUnloaded()`（最多 5s）。
 *   更关键的是 `stopService` **在自己的锁内先 bump、之后才 waitUntilUnloaded**，
 *   所以存在「B 已 bump 而 launchctl print 仍报 running」的区间：此时 cmdInstall 会
 *   合理地读到 `wasRunning=true`，而在 bootout 之后现取的快照必然已经 ≥ B 的值，
 *   并发就此隐形。快照取在命令最开头是免费的，也省掉「哪个窗口才有害」的推理。
 *
 *   注意 `handleLegacyInstall` 的 sudo 等待**不是**危害窗口：`wasRunning` 在它之后才读，
 *   期间跑完的 stop 会让 `wasRunning=false`，恢复分支根本不执行，终态仍是停止。
 *
 *   **自我中止的雷**：本快照只被 `wasRunning` 恢复分支消费，而首装的
 *   `disableServiceAutoStart()` 在互斥的另一条分支上，故 install 观察不到自己的 bump。
 *   若将来在恢复分支之前新增任何递增，install 就会检出自己的 bump 并取消自己的恢复。
 */
export async function installService(wasRunning: boolean, stopEpochBefore: number): Promise<{ restoreSkipped: boolean }> {
  assertServiceLabelSafe();
  ensureDirs();
  ensureServiceSymlink();

  let restoreSkipped = false;
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
      // 与 startService 同族：并发的 stop 若在重装期间跑完（重装含 bootout + 等待，
      // 有真实窗口），这里的 enable+bootstrap 会把它的成果覆盖掉，终态与用户最后一条
      // 命令相反。判据共用 shouldAbortStartOnDisable——**别在这里散写别的判据**。
      // 基线是命令层传入的快照，不在此处现取（见函数头 @param 说明）
      withFileLock(PATHS.serviceLock, () => {
        if (shouldAbortStartOnDisable(stopEpochBefore, readStopEpoch())) {
          restoreSkipped = true;
          return;
        }
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

  return { restoreSkipped };
}

/**
 * 「服务被要求停止」的单调计数。
 *
 * 存在的理由见 `PATHS.serviceStopEpoch` 的注释：launchd 的 disable 位是持久状态、
 * 没有写入时间，「上次 stop 留下的」与「刚刚并发置的」完全同形，光比对位的前后快照
 * 在「上次也 stop 过」时区分不出来。计数只增不减，值变了就一定有人 stop 过。
 *
 * **递增（读-改-写）与启动侧锁内的比对都在 `serviceLock` 内进行**，这是判据可靠的
 * 前提（写与 check-then-act 必须和对方的临界区互斥）。另有两处**事后复核的只读**
 * 刻意在锁外：launchOrRestart 健康确认失败后（v4.8.0）、restartService 热重载成功后
 * （concludeHotReload）——它们只消费结论、不与递增竞争写，atomicWrite 的 rename
 * 也保证读到的不会是半截值。
 *
 * 读失败一律返回 0（文件不存在是首次运行的正常形态；内容损坏时宁可退回
 * 「按无并发处理」也不能让 start 抛错——start 是用户显式意图，不该被一个辅助计数挡住）。
 *
 * 导出仅供测试：并发用例要验的是**这一份**实现在跨进程下的行为，
 * 测试里另抄一份等于在验副本，两边一漂移就测了个假的。
 */
export function readStopEpoch(): number {
  try {
    const n = Number.parseInt(fs.readFileSync(PATHS.serviceStopEpoch, 'utf8').trim(), 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * 递增停止计数。写失败**静默忽略**：它只用于并发判定，写不进去最坏是退回 v4.7.6 的行为
 * （并发 stop 可能被 start 覆盖），而让 `stop` 因为一个辅助文件写不了就整体失败，
 * 是拿主功能给辅助机制陪葬——stop 的真正职责（bootout + disable）已经完成了。
 *
 * **不自己取锁**，故在 `stopService`/`uninstallService` 的 `serviceLock` 临界区内调用是
 * 安全的（`withFileLock` 不可重入，自己取锁会死等到强夺）。另两个调用点（install 首装、
 * `cmdStart` 的 TUN 分支）在锁外，那里的读-改-写确实可能与他人交错而丢掉一次递增——
 * 但判据只问「值变没变」，不问增量准不准，丢一次递增不影响正确性。
 */
function bumpStopEpoch(): void {
  try {
    ensureDirs();
    atomicWriteFileSync(PATHS.serviceStopEpoch, String(readStopEpoch() + 1));
  } catch {
    /* ignore：见函数头注释 */
  }
}

/**
 * 记录一次「已确认停止」。
 *
 * 为什么 `disableServiceAutoStart` 的收口不够：那五个调用点覆盖的是**有 disable 动作**
 * 的路径，而另有几条路径同样得出「现在不会自启、也没有内核在跑」这个结论，却无 disable
 * 可执行——`cmdStop` 的两条提前返回（未装载且「未安装或已 disabled」，`stop()` 只杀进程
 * 不碰 disable 位），以及 `reset` 在服务未装时的游离内核清理。
 *
 * 不递增的后果：这些路径对并发的 `start` **完全隐形**。A 在 start 的慢速阶段（订阅更新
 * 约 10s）时服务已装、未装载、disable 位为真（上次 stop/tun 留下的，是最常见的前置），
 * B 此时跑 `stop` 正好走「不在运行」那条——不递增，A 随后照常 enable + bootstrap，
 * 终态与用户最后一条命令相反，而两个终端都拿到了成功回执。
 *
 * **不变式不是放宽，是承认第二种同等强度的证据。** 递增只发生在「已确认不会自启、
 * 且当下没有内核在跑」之后，证据有两种形态、强度相同：
 *
 * 1. 刚执行并**事后复核**过的 disable（`disableServiceAutoStart` 用 print-disabled 复核）
 * 2. 刚**读到**的状态本身——`launchctl print` 判未装载、plist 缺失或 print-disabled 判
 *    不会自启、`pgrep` 判无内核。这些读取失败时都抛错而非降级
 *    （`assertLaunchctlQueryOk`、`getMihomoPids` 只接受退出码 0/1），故「走到了这条路径」
 *    本身就是独立依据
 *
 * 两者都是**已成立的事实**，不是「打算做的事」。因此调用点必须放在该路径
 * **最后一道失败检查之后**——放在开头（或 `handleStopResult` 之前）会让一次失败的停止
 * 把并发的 `start` 白白中止，那正是 `disableServiceAutoStart` 里「放在确认之后」防的事。
 *
 * **不自己取锁**（与 `bumpStopEpoch` 同因：`withFileLock` 不可重入）。多写者交错时
 * 极端情况下可能用较小值覆盖较大值，从而让某条后续命令的基线比对偶发为「变了」而中止——
 * 判据是 `!==` 而非 `>`，本就偏保守，窗口只有两次系统调用，接受之，不为此加锁。
 */
export function recordServiceStopped(): void {
  bumpStopEpoch();
}

/**
 * 锁内是否应放弃启动。判据只有一份，`startService` 与回归测试共用——
 * **别在别处散写 `isServiceDisabledInLaunchd()` 就 return**，那正是 v4.7.5 的缺陷形态。
 *
 * 判据是**停止计数是否变化**，不是 disable 位的值。位有两种来源、语义相反，而位本身
 * 区分不出来（都是 `true`）：
 *
 * - **上次 `stop`/`tun` 留下的持久位**：该位存在 plist 之外、launchctl 无清除动词，
 *   会一直躺着直到被 `enable`。用户现在显式敲了 `start`，意图就是启动——照常 enable + bootstrap
 * - **本次执行期间另一终端跑了 `stop`**：用户最后一条命令是 stop，启动会让终态与之相反——跳过
 *
 * 两版的教训各记一次，别再退回任何一边：
 *
 * - **v4.7.5**：判据是「当前是否 disabled」。把第一种误判成第二种，于是 `stop`/`tun` 之后的
 *   **每一次** `start` 都静默不 enable、不 bootstrap，内核永不被拉起，报错却是「内核未能进入
 *   运行状态」+ 一个从未被创建的日志路径。用户只能手动 `launchctl enable` 才能恢复
 * - **v4.7.6**：判据是「disable 位的前后快照比对」。修好了上面那条，但**「上次也 stop 过」时
 *   两边快照都是 true**，并发 stop 就此隐形——恰恰是防线本来要防的场景，在最常见的前置状态下失效
 *
 * 现在用计数：它由 CLI 自己在每次 disable 时递增，与位的当前值完全解耦。
 */
export function shouldAbortStartOnDisable(stopEpochBefore: number, stopEpochNow: number): boolean {
  return stopEpochNow !== stopEpochBefore;
}

/**
 * 启动服务并开启自启。返回 `started=false` 表示被**并发的 stop** 取消（见
 * `shouldAbortStartOnDisable`）——调用方必须把它当失败处理，不能继续报「已启动」。
 *
 * @param stopEpochBefore 命令开始时（订阅更新等慢速阶段**之前**）的停止计数快照，
 *   取自 `cmdStart` 开头的 `readStopEpochForStart()`。**不能在本函数内部现取**——
 *   那时慢速阶段已经过去，期间发生的 stop 就被算进「基线」了。
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
 *
 * **bootout 刻意留在锁外**：`withFileLock` 要求 `fn` 同步（持锁期间 await 会把锁按住
 * 整个异步等待，慢速下让另一进程等到强夺陈旧锁，等于没锁），而 bootout 后必须
 * `waitUntilUnloaded`（最多 5s）。放在锁外是安全的——并发 stop 若发生在此处，
 * A 的 bootout 只是幂等空操作，而**计数变化会在锁内被检出并中止启动**。
 * 这正是判据从「disable 位快照」换成计数的价值：不必靠扩大临界区来防这个窗口。
 */
export async function startService(stopEpochBefore: number): Promise<{ started: boolean }> {
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

  // tun 残留是 root 属主，会与服务抢端口；有才清（这是唯一可能弹密码的地方），无则免密。
  // 失败即 CliError：sudo 取消是用户主动行为，不该带堆栈按「未预期错误」渲染，
  // 也要说清此时服务尚未启动（清理是启动的前置步骤）
  cleanupRootResidueOrThrow({ mainOutcome: '服务尚未启动', retryCommand: 'mihomo start' });

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
  // 跨进程锁：慢速 start（订阅自动更新 ~10s）期间另一终端 stop 会 bootout+disable+bump，
  // start 随后的 enable+bootstrap 会把自启位又打开，终态与用户最后一条命令相反。
  // 锁串行化 enable/bootstrap 与 stop 的 bootout/disable/bump；锁内读一次停止计数，
  // **与命令开始前的快照比对**——变了就是期间有人 stop 过，放弃启动
  //
  // 判据是计数而非 disable 位，见 shouldAbortStartOnDisable：位是持久的，
  // 「上次 stop 留下的」与「刚刚并发置的」完全同形，比对位的快照在「上次也 stop 过」
  // 这个最常见的前置状态下会让并发 stop 完全隐形（v4.7.6 的残留缺口）
  let started = true;
  withFileLock(PATHS.serviceLock, () => {
    if (shouldAbortStartOnDisable(stopEpochBefore, readStopEpoch())) {
      started = false;
      return;
    }
    runLaunchctlOrThrow(['enable', serviceTarget()], '启用服务');
    runLaunchctlOrThrow(['bootstrap', bootstrapDomain(), PATHS.userAgentPlist], '启动服务');
  });

  return { started };
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
 *
 * **停止计数有两个递增入口，这是其中之一**：本函数伴随一次真实 disable（靠下方
 * print-disabled 事后复核），另一个是 `recordServiceStopped`（没有 disable 可做、
 * 但状态读取已经证明「不会自启且无内核在跑」的路径，如 `cmdStop` 的提前返回、
 * `reset` 在服务未装时的清理）。两者前提相同，见 `recordServiceStopped` 的不变式说明。
 *
 * 本函数五处调用（install 首装、stop、uninstall×2、cmdStart 的 TUN 分支）语义都是
 * 「让服务别自启」，任何一处漏 bump 都会让并发判据在那条路径上失效——而「防线只铺一条
 * 路径」正是本仓反复栽的坑，也正是 `recordServiceStopped` 那几条路径此前的处境。
 * 走这个出口的新增调用点自动获得正确行为。
 *
 * @param timeoutMs stop/uninstall 在 serviceLock 内调用时必须传
 *   SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS：本函数含 disable + print-disabled 复核两次
 *   launchctl，加上锁体里的 bootout 共三次，是持锁预算的大头（见该常量注释）。
 *   锁外调用（install 首装、cmdStart 的 TUN 分支、uninstall 的锁外复核）不持锁，
 *   保持默认 5s
 */
export function disableServiceAutoStart(timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): void {
  assertServiceLabelSafe();

  runLaunchctlOrThrow(['disable', serviceTarget()], '关闭服务自启', timeoutMs);

  // 事后确认：命令成功 ≠ 位生效。这是 TUN 防线的第一层，而开机自启路径不经过 CLI
  // （登录时 launchd 直接扫 plist），第二层「startService 拒绝 TUN 配置」在那条路径上
  // 不生效——失败必须让用户看见，否则重启后就是「代理不通、日志刷爆」且无任何线索
  if (!isServiceDisabledInLaunchd(timeoutMs)) {
    throw new CliError('关闭服务自启失败：disable 位未生效', {
      hint: [`手动确认: launchctl print-disabled ${bootstrapDomain()}`, '', '不关闭自启的话，重启后服务会拿 TUN 配置反复拉起必然失败的内核。'],
    });
  }

  // 放在确认之后：位没真生效就不该记「停止过」，否则一次失败的 disable 会让
  // 并发的 start 白白中止（用户拿到「启动已取消」，而实际上没有任何一方成功停止）
  bumpStopEpoch();
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
  //
  // 锁内三次 launchctl 全部走 SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS（bootout + disable +
  // print-disabled 复核，最坏 9s < LOCK_STALE_MS）：按默认 5s 最坏持锁 15s，会被并发
  // start 判锁陈旧强夺，两进程同处临界区、epoch 判据被整体绕过。预算论证见该常量注释
  withFileLock(PATHS.serviceLock, () => {
    bootoutService(SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
    disableServiceAutoStart(SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
  });

  await waitUntilUnloaded();

  // bootout 通常已终止托管内核；tun 起的 root 内核与手动残留在此收口。
  // 重跑 stop 即可重试清理：此时服务已停，cmdStop 走「游离内核」路径再次提权
  killResidualKernels({ mainOutcome: '服务已停止，登录自启已关闭', retryCommand: 'mihomo stop' });
}

/**
 * 卸载服务：停止 + 删除 plist。
 *
 * **不清 disable 位**：launchctl 没有「清除记录」的动词——`enable` 同样会往
 * /var/db/com.apple.xpc.launchd/ 写一条 `=> enabled`（实测可见），并不比 `disable` 干净。
 * 既然两者都留痕，就选语义更安全的那个：plist 若被别的途径放回也不会自动启动。
 * 而 `startService` 只在「本次执行期间新出现」的 disable 位上才放弃启动
 * （见 `shouldAbortStartOnDisable`），残留位属「命令开始前就存在」，照常被 enable 覆盖，
 * 不影响任何正常路径。
 */
export async function uninstallService(): Promise<void> {
  assertServiceLabelSafe();

  // 跨进程锁：与 startService 的 enable/bootstrap 串行化（withFileLock 同步，见 stopService）。
  // 锁内三次 launchctl 同样走 SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS，预算论证见该常量注释
  withFileLock(PATHS.serviceLock, () => {
    bootoutService(SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
    disableServiceAutoStart(SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
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

  // 重试入口是 stop 而非 uninstall：卸载完成后重跑 uninstall 会因「未安装且未装载」
  // 幂等返回，不会重试残留清理；stop 的游离内核路径（cleanupAll）才会再次提权
  killResidualKernels({ mainOutcome: '服务已卸载', retryCommand: 'mihomo stop' });

  // 符号链是本工具装的，卸载时一并清掉（内核本体保留，那是 kernel 命令的资产）
  try {
    fs.rmSync(PATHS.serviceBinary, { force: true });
  } catch {
    /* ignore：不存在或已被 reset kernel 带走 */
  }
}

/**
 * 生成遗留安装清理脚本的 body（不写盘：写盘 + chmod + sudo + 退出码映射由 runSudoScript 统一完成）。
 * 导出仅为测试退出码协议：脚本内部失败用 ≥2 的退出码（bootout 真实失败为 3），
 * 1 留给 sudo 鉴权取消/密码错误——此前用 `exit 1` 报真实失败，被 runSudoScript
 * 映射成「已取消或密码错误」，用户密码明明输对了。
 */
export function buildLegacyCleanupScript(): string {
  return [
    '#!/bin/bash',
    // bootout 退出码分级：113=未装载（daemon 已不在，正常），其余是真实失败。
    // 此前 || true 吞掉所有错误，daemon 仍在跑却继续 rm plist 并报「已清理」
    `bootout_code=0`,
    `launchctl bootout ${shellQuote(`system/${SERVICE_LABEL}`)} 2>/dev/null || bootout_code=$?`,
    `if [ $bootout_code -ne 0 ] && [ $bootout_code -ne 113 ]; then`,
    `  echo "launchctl bootout 失败（退出码 $bootout_code）" >&2`,
    `  exit 3`,
    `fi`,
    `rm -f ${shellQuote(PATHS.systemDaemonPlist)}`,
    `chown "$SUDO_UID:$SUDO_GID" ${shellQuote(PATHS.logFile)} 2>/dev/null || true`,
    `chown -R "$SUDO_UID:$SUDO_GID" ${shellQuote(DIRS.data)} 2>/dev/null || true`,
    `rm -f ${shellQuote(PATHS.pidFile)}`,
    'exit 0',
    '',
  ].join('\n');
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

  runSudoScript(buildLegacyCleanupScript(), {
    action: '清理遗留的系统级服务',
    file: 'legacy-cleanup.sh',
    // 3 = 脚本内 bootout 真实失败（见 buildLegacyCleanupScript 的分级）；
    // 具体退出码已由脚本 echo 到终端，故只指向「上方输出」
    codeMessages: { 3: 'launchctl bootout 未能卸载旧 daemon（详见上方输出）' },
  });
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
 * 热重载成功后给 restartService 的返回值下结论：先复读停止计数，变了就按并发停止处理。
 *
 * 热重载是唯一没有健康确认的「生效」路径（内核没重启，PUT 204 即接受），v4.8.0 给
 * kickstart 路径补「健康确认失败后复读计数」防线时，这条成功路径没有等价收口：
 * tryHotReload 从状态探测到 PUT 返回最坏二十多秒（前置两次 launchctl 查询、/version
 * 探测、lsof、PUT 各带 5s 超时），期间并发的 stop 已完成 bootout + disable + 递增——
 * 内核确实吃进了新配置，但随即被停掉。不查就照常返回 started=true 的话，调用方报
 * 「已启动」，终态与用户最后一条命令相反，与 v4.7.5→4.7.7 连修六条的缺口同族同形。
 *
 * `hotReloaded` 恒为 true（配置确实被内核接受，如实反映）；要不要报成功由 `started`
 * 说了算——它与 kickstart 回退分支的 `started` 同名同义，started=false 经
 * launchOrRestart 既有的「启动已取消」出口报错，文案不另起一份。
 *
 * 判据复用唯一那份 `shouldAbortStartOnDisable`，这里只是消费点，不写第二套比较；
 * 复读用 `readStopEpoch` 原样调（读失败返回 0 是它既有的 fail-open 契约，不在此再包
 * 一层降级或吞错）。抽成纯函数是为了可测：热重载路径依赖真实 launchd 状态与
 * external-controller，自动化测试起不了真服务（真实 launchctl 写操作不进测试），
 * 决策逻辑单独锁定；消费点另有端到端用例（fake launchctl + 桩 controller）。
 */
export function concludeHotReload(stopEpochBefore: number, stopEpochNow: number): { hotReloaded: boolean; started: boolean } {
  return { hotReloaded: true, started: !shouldAbortStartOnDisable(stopEpochBefore, stopEpochNow) };
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
 * 轮转发生在下方判据之前，故被取消的重启可能已经轮转过一次日志：copy 在 truncate 之前，
 * 数据不丢，**刻意不为此再加一个判据消费点**——一个函数一个消费点比这点整洁更值。
 *
 * 返回 `started=false` 表示启动性动作被**并发的 stop** 取消——kickstart 失败后的
 * enable+bootstrap 回退（锁内判据），或热重载成功后的复读（concludeHotReload）——
 * 与 `startService` 的 `started` 同名同义。此时 `hotReloaded` 无意义，
 * 调用方必须先判 `started`，不能继续报「已启动」。
 *
 * @param stopEpochBefore 命令开始时的停止计数快照。两条出口都消费它：热重载成功后经
 *   concludeHotReload 复读（热重载探测最坏二十多秒），kickstart 失败的 enable+bootstrap
 *   回退在锁内复读（热重载探测加 kickstart 最长可达 60s）——期间的并发 stop 会被
 *   这两条出口覆盖掉
 */
export async function restartService(stopEpochBefore: number): Promise<{ hotReloaded: boolean; started: boolean }> {
  if (!isServiceInstalled()) {
    throw new CliError('服务未安装，无法重启', { hint: '安装服务: mihomo install' });
  }

  // 热重载成功也要复读停止计数再下结论：防线此前只铺在 kickstart 的失败分支，
  // 这条成功路径同样有并发窗口（决策与理由见 concludeHotReload 的注释）
  if (!logOversized() && (await tryHotReload())) {
    return concludeHotReload(stopEpochBefore, readStopEpoch());
  }

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
  // 不能用 runLaunchctl 的查询超时（5s）——旧脚本整体超时是 60s，这里单独放宽。
  //
  // **kickstart 刻意留在锁外**：它的超时是 60s，而 LOCK_STALE_MS 只有 10s，放进锁里必然
  // 被别的进程强夺，等于没锁（与 startService 把 bootout 留在锁外同因）。代价是
  // 「kickstart 成功 + 随后并发 stop」这一交错仍在锁外——那一支由 launchOrRestart 在
  // 健康确认失败后复读计数兜住，不在这里重复设防。
  const kick = runLaunchctl(['kickstart', '-k', serviceTarget()], 60_000);
  let started = true;
  if (kick.status !== 0) {
    // 回退路径与 startService 同族：enable + bootstrap 会把并发 stop 的成果覆盖掉，
    // 终态与用户最后一条命令相反。判据共用 shouldAbortStartOnDisable——
    // **别在这里散写别的判据**
    withFileLock(PATHS.serviceLock, () => {
      if (shouldAbortStartOnDisable(stopEpochBefore, readStopEpoch())) {
        started = false;
        return;
      }
      runLaunchctl(['enable', serviceTarget()]); // 容忍失败：bootstrap 会再判一次
      runLaunchctlOrThrow(['bootstrap', bootstrapDomain(), PATHS.userAgentPlist], '重启服务');
    });
    // 被取消：直接返回，不清理归档也不做别的收尾
    if (!started) return { hotReloaded: false, started: false };
  }

  // 顺手清理过期归档：归档可能为 root 属主，但 logs/ 目录归用户所有，unlink 只看目录权限
  cleanupOldLogs();

  return { hotReloaded: false, started: true };
}

/** 符号链名，供命令层展示「登录项与扩展」里会看到的名字 */
export { SERVICE_BINARY_NAME };
