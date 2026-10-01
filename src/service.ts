import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { colors } from './colors.js';
import { getConfigInfo } from './config.js';
import { isValidServiceLabel, RAW_SERVICE_LABEL_INPUT, SERVICE_BINARY_NAME, SERVICE_LABEL } from './constants.js';
import { CliError } from './errors.js';
import { allocateArchivePath, cleanupOldLogs, rotateAndCleanupLogs } from './log-files.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS, withFileLock } from './paths.js';
import { getMihomoPids } from './process-probe.js';
import { cleanupAll, describePidCleanupFailure, reapPidWhenQuiet } from './process-stop.js';
import { getPorts, readSettings } from './settings.js';
import { runSudoScript, SudoAuthError } from './sudo.js';
import { shellQuote } from './text.js';
import type { CleanupResult, ServiceStatus } from './types.js';
import { sleep } from './utils.js';

/**
 * launchd 服务层：Mixed 模式的唯一运行方式。
 *
 * 装在用户域（`~/Library/LaunchAgents` + `gui/<uid>`），install/start/stop/uninstall 全程免 sudo。
 * 为什么不用 root LaunchDaemon、遗留系统级安装为何仍要识别与清理，见 docs/decisions.md D1。
 */

/** 校验 MIHOMO_CLI_DAEMON_LABEL：该值经 path.join 折叠 `..` 后会成为 root 清理路径
 * （`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`），不校验即提权原语。
 * constants 已把非法值回退为默认标签，此处在执行写/删前拒绝并告知用户。 */
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
 * 健康确认的采样节奏。必须观察满 SERVICE_OBSERVE_MS 才判「健康」：bootstrap 后存在一段
 * 不固定的假健康窗口（state=running、pid 给得出，进程随即退出），只能用足够宽的窗口覆盖，
 * 不能按某次实测值卡边。崩溃一经检出立即返回；观察窗之后才崩（如几秒后 OOM）由
 * status 的「上次异常退出」提示兜底。
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
 * 锁内 launchctl 调用的单次超时（start/install/restart/stop/uninstall 全部锁内调用统一）。
 *
 * 锁内调用次数 × 单次超时的最坏持锁时长必须低于锁强夺阈值（10s）：stop 侧三次
 * （bootout、disable、print-disabled 复核）= 9s；start 侧失败分支三次
 * （enable、bootstrap、exit 5 时的复读 print，见 bootstrapServiceIdempotentOrThrow）= 9s。
 * 锁内各环节为什么挪不出锁、3s 的余量论证，见 docs/decisions.md D3；
 * 预算关系由 service-concurrency.spec 的常量断言锁死。
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
 * 是否存在遗留的**系统级**安装（v3.0–v4.0 的 root LaunchDaemon，背景见 D1）。
 * 它带 KeepAlive 会持续拉起内核抢占端口，用户态 launchctl 动不了它——不认的话对用户就是
 * 「代理停不掉、CLI 说没装」的幽灵。只识别不自动清理：删 root 文件要提权，
 * 交由 uninstall 在用户明确要求时做。
 */
export function detectLegacySystemInstall(): boolean {
  return fs.existsSync(PATHS.systemDaemonPlist);
}

// === 状态解析（纯函数，单测锁定） ===

/**
 * 解析 `launchctl print <target>` 的输出。
 *
 * **必须锚定单个前导 tab**：顶层字段是 `\tstate = running`，而嵌套 endpoint 还有
 * `\t\tstate = active`（同一份输出里两次出现），不锚定会把 state 误解析成 "active"。
 *
 * 健康服务的 last exit code 是字符串 `(never exited)` 而非数字，故非数字一律归 null。
 * 信号死亡走另一个字段：被 `kill -9` 时 launchd 只写 `last terminating signal`，
 * `last exit code` 整行消失——两字段互斥、不跨 bootstrap 残留（均实测）。
 * 缺任何一个，OOM / 手工 kill 掉的内核对崩溃判据都不可见。
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
 * 把它们当成「未装载」会让 status 谎报、stop 静默跳过。
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
 * 查询服务状态。全程免 sudo（print 与 print-disabled 均可读，实测 3ms）。
 * 未装载时 `launchctl print` 退出码为 113。
 *
 * **plist 不存在时也必须查 launchctl**，不能直接返回「未安装」就完事：用户手动
 * `rm` 掉 plist 后任务仍处 bootstrapped 状态，KeepAlive 会继续把内核拉起。
 * 只看文件的话 status 谎报「未安装」、uninstall 直接返回不执行 bootout，
 * 用户陷入「代理停不掉且 CLI 说没装」的死胡同（实测可复现）。
 *
 * @param options.withDisabled 是否查 print-disabled。健康轮询（waitServiceHealthy）
 *   每 100ms 调一次、只消费 state/pid/死因，从不读 disabled，关掉它每轮少一个
 *   spawnSync（最坏 31 轮 = 31 次白跑的整张 disabled 表 dump，且 spawnSync 阻塞
 *   事件循环，launchctl 卡顿时轮询期间 Ctrl-C 无响应）。默认 true：状态快照的
 *   其余消费点（status/doctor/命令分支）都要 disabled 字段
 */
export function getServiceStatus(options: { withDisabled?: boolean } = {}): ServiceStatus {
  const withDisabled = options.withDisabled !== false;
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
  // withDisabled=false 时给 false 占位：该快照只供给不读 disabled 的健康轮询，
  // 绝不能流进 status/命令分支（那些调用点都走默认 withDisabled=true）
  const disabled = withDisabled ? isServiceDisabledInLaunchd() : false;

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
 * 等待服务真正稳定运行，而非「bootstrap 没报错」：bootstrap 成功只意味着任务被装载，
 * 内核因配置错误立即退出时 KeepAlive 会每约 10s 重新拉起，只取一次 pid 会误报「已启动」。
 *
 * 判据是 `last exit code`（非 0 = 起来过又挂了），不用 `runs`：KeepAlive 节流期间
 * runs 不增，用它判断会漏掉全部快速失败。`last exit code` 是历史值，崩溃一次后又正常
 * 起来的服务该字段仍非 0，故「当前在跑」优先于历史退出码——只在观察窗内始终未能
 * 进入 running 时才判定崩溃。
 */
export async function waitServiceHealthy(): Promise<ServiceHealth> {
  const deadline = Date.now() + SERVICE_OBSERVE_MS;
  const graceDeadline = deadline + SERVICE_HEALTH_GRACE_MS;
  // 健康判定只消费 state/pid/死因，不读 disabled——轮询里关掉 print-disabled，
  // 每轮少一个阻塞事件循环的 spawnSync（见 getServiceStatus 的 withDisabled）。
  // do/while 先 sleep 再查：循环外不取首次快照——它在第一轮 sleep 后必被覆盖，
  // 查了也没人读
  // 第一阶段：观察满窗口。期间检出崩溃立即返回，否则以窗口结束时的状态为准。
  // 查询失败 ≠ 未运行：enable/bootstrap 数秒前刚走同一 launchctl 成功，轮询里的
  // 瞬时失败（超时/112/125）按「本轮未知」跳过，不升级为「启动失败」的假结论。
  // last 可空：整个观察窗查询全部失败时为 null，由 healthViaProcessProbe 兜底
  let last: ServiceStatus | null = null;
  do {
    await sleep(SERVICE_HEALTH_INTERVAL_MS);
    try {
      last = getServiceStatus({ withDisabled: false });
    } catch {
      continue;
    }

    if (isCrashed(last)) {
      return { healthy: false, crashed: true, pid: null, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
    }
    if (!last.loaded) {
      // 已卸载（被外部 bootout，或 plist 装不进来），继续等无意义
      return { healthy: false, crashed: false, pid: null, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
    }
  } while (Date.now() < deadline);

  // 观察窗内查询无一成功：用进程探测兜底，避免「内核实际已运行却被报成启动失败」
  // 的假阴性；连进程也探测不到才落回诚实的「未能确认」结论
  if (last === null) return healthViaProcessProbe();

  if (last.running) return { healthy: true, crashed: false, pid: last.pid, exitCode: null, terminatingSignal: null };

  // 第二阶段：窗口结束仍未 running（慢机器上内核起得慢，或正在 spawn 重试），再宽限一会儿
  let graceQueried = false;
  while (Date.now() < graceDeadline) {
    await sleep(SERVICE_HEALTH_INTERVAL_MS);
    try {
      last = getServiceStatus({ withDisabled: false });
    } catch {
      continue;
    }
    graceQueried = true;

    if (isCrashed(last)) {
      return { healthy: false, crashed: true, pid: null, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
    }
    if (!last.loaded) break;
    if (last.running) return { healthy: true, crashed: false, pid: last.pid, exitCode: null, terminatingSignal: null };
  }

  // 宽限期查询也无一成功：last 是第一阶段末尾的陈旧快照（not running），此刻服务
  // 可能已 running 而观察不到——与第一阶段全失败同族，同一兜底判据
  if (!graceQueried) return healthViaProcessProbe();

  return { healthy: false, crashed: false, pid: last.pid, exitCode: last.lastExitCode, terminatingSignal: last.lastTerminatingSignal };
}

/**
 * 观察窗内 launchctl 查询全部失败时的兜底判据：进程在 = 内核活着（命令行匹配
 * MAIN_INSTANCE_PATTERN 即强证据），返回健康并以进程 pid 为结果依据；pgrep 自身失败
 * 不致命——与「无进程」一样落回 healthy:false（assertServiceHealthy 报「未能进入运行
 * 状态」，日志尾部仍是有效线索）。已知边界：观察窗（≤3s、锁外）内并发启动的 TUN 进程
 * 同样命中模式，极端交错下可能假阳性——终态（有内核在跑、mixed 未确认）无害，不为
 * 消掉它引入 pgrep 之上的第二重判定。
 */
function healthViaProcessProbe(): ServiceHealth {
  try {
    const pids = getMihomoPids();
    if (pids.length > 0) return { healthy: true, crashed: false, pid: pids[0], exitCode: null, terminatingSignal: null };
  } catch {
    /* pgrep 探测失败：无独立依据，落回未能确认的诚实结论 */
  }
  return { healthy: false, crashed: false, pid: null, exitCode: null, terminatingSignal: null };
}

/**
 * 死因的人类可读描述，正常退出（或没有记录）时返回 null。
 *
 * **异常退出判据的唯一一份**：launchd 对信号死亡只写 terminating signal、exit code
 * 整行消失（见 parseServicePrint），两个字段缺一不可。
 * 判据必须收口在这里，别在调用点散写 `lastExitCode !== 0`——isCrashed 判有无、
 * describeAbnormalExit 供 status/doctor、assertServiceHealthy 供 start/install，
 * 三个消费者共用这一份，补条件只需改这里。
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
    throw new CliError('未找到 mihomo 内核，请先下载内核', { hint: '下载内核: mihomo-cli kernel' });
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
  try {
    fs.symlinkSync('mihomo', PATHS.serviceBinary);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // 并发 start/start：两个进程同时过了上面的 readlink（ENOENT）再各自建链，后建者
    // 撞 EEXIST——链目标恒定（同目录相对链 'mihomo'），属正常竞争不是故障。
    // 复核已存在的链指向同一目标后容忍；不一致（异常残留）不吞，重抛原错
    let existing: string;
    try {
      existing = fs.readlinkSync(PATHS.serviceBinary);
    } catch {
      throw e;
    }
    if (existing !== 'mihomo') throw e;
  }
}

// === 操作 ===

/**
 * 执行一条 launchctl 写操作并要求成功（退出码 0）。用户域操作免密，直接 spawn；
 * 失败时把 stderr 收进 hint——launchctl 的报错文本（如 "Bootstrap failed: 5"）
 * 是排查的主要线索。需要 root 的路径才走 runSudoScript 的脚本形式。
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
 * 锁内 bootstrap，吸收「并发同向启动」的撞车（startService / installService 恢复分支 /
 * restartService kickstart 回退三处共用，别处不得散写 bootstrap）。
 *
 * 后到者的 bootstrap 撞上先到者刚完成的任务时 launchctl 报 exit 5，与「bootstrap disabled
 * 标签」的 exit 5 完全同形，必须复读 print 区分：
 * - print 0（已装载）= 并发者已完成装载：按幂等成功继续，后续健康确认照常
 *   （epoch 防线不受影响——并发 stop 早在锁内 shouldAbortStartOnDisable 被拦）
 * - print 113（未装载）= 真失败（disabled 残留 / I/O error），维持报错
 * 其他退出码原样抛，不吸收。
 *
 * 持锁预算：本函数最坏两次调用 + 调用方的 enable 共三次，全部走
 * SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS（见该常量的预算注释）。
 */
function bootstrapServiceIdempotentOrThrow(what: string): void {
  const result = runLaunchctl(['bootstrap', bootstrapDomain(), PATHS.userAgentPlist], SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
  if (result.status === 0) return;
  if (result.status === 5 && runLaunchctl(['print', serviceTarget()], SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS).status === 0) return;
  const detail = result.stderr.trim();
  throw new CliError(`${what}失败（launchctl 退出码 ${result.status ?? '执行失败'}）`, {
    hint: [detail, `手动确认: launchctl print ${serviceTarget()}`].filter(Boolean),
  });
}

/**
 * bootout 旧实例。容忍「未装载」（实测该情形退出码为 3，文档化的 113 同样收下）；
 * 112/125 等域错误直接抛，不伪装成「无事发生」。
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
 * `launchctl bootout` 返回不代表任务已卸载——内核可能还持着监听端口，紧接着的
 * bootstrap 会撞上「尚未卸载完成」报 error 5，与 disabled 的报错同形，极难排查。
 *
 * 判定语义：
 *   - print 113（未装载）= 已卸载，通过
 *   - 112/125 等 = 查询失败，抛错——不能当「已卸载」（查询失败 ≠ 目标不存在）
 *   - 轮询用尽仍装载 = bootout 未生效，抛错——带着「任务仍装载」往下走，
 *     正是「报停止成功而 KeepAlive 约 10s 后拉回内核」的静默失效
 *
 * async + sleep：轮询必须让出事件循环，否则 stop 卡住期间 Ctrl+C 无响应。
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

/** root 残留清理失败包装的上下文：主体动作进行到哪一步、重试入口，三个调用点各不相同 */
export interface RootResidueCleanupContext {
  /** 主体动作的结果描述，如「服务已停止，登录自启已关闭」；start 路径是「服务尚未启动」 */
  mainOutcome: string;
  /** 重新尝试清理的命令，如 'mihomo-cli stop' */
  retryCommand: string;
}

/**
 * 把 cleanupAll 的 root 清理结果包成 CliError——纯函数，供测试。
 * 统一说清三件关键事实：主体动作已完成到哪一步、root 残留还在（带 PID）、重试入口。
 * sudo 取消（scriptError 是 SudoAuthError；pidError 免提权、不可能是它）label 用
 * 「已取消」；其余失败保留原始消息（scriptError 优先——它先于 pid 收口发生）。
 * remaining 的归因按 scriptError 分：非空 = root 脚本没走通，残留按 root 论；
 * 空 = 没进过 root 分支，残留是用户态没能终止的，不许说成 root 属主。
 * remaining 为空时 **scriptError 优先于 pidError**：仅 pidError = pid 文件残留；
 * scriptError（无论是否并存 pidError）= 进程在死亡等待内自行退光、清理没走完，
 * 主归因随脚本、pid 文件错误只作附带——「可能仍有进程」比「文件残留」更需用户行动，
 * 被 pidError 盖成 rm 引导会漏掉潜在的存活内核
 */
export function buildRootResidueCleanupError(result: Pick<CleanupResult, 'remaining' | 'scriptError' | 'pidError'>, ctx: RootResidueCleanupContext): CliError {
  const { scriptError, pidError } = result;
  const cancelled = scriptError instanceof SudoAuthError;
  const hasKernelResidue = result.remaining.length > 0;
  const pidList = `PID ${result.remaining.join(', ')}`;
  const residueHint = hasKernelResidue
    ? scriptError
      ? `root 残留内核仍在运行（${pidList}），可能继续占用代理端口`
      : `残留内核仍在运行（${pidList}）——用户态未能终止，与提权无关`
    : scriptError
      ? `root 残留清理未完成，进程目前已不在（死亡等待内自行退出，非 sudo 清理）${pidError ? `；${describePidCleanupFailure(pidError)}` : ''}`
      : pidError
        ? `${describePidCleanupFailure(pidError)}: ${PATHS.pidFile}`
        : 'root 残留未清理干净';
  const hint = [ctx.mainOutcome, residueHint, `重新运行可再次尝试清理: ${ctx.retryCommand}`];
  // 有 kernel 残留、或脚本没走完（可能仍有进程）→ pkill 幂等兜底；仅 pid 文件残留才引导 rm
  hint.push(hasKernelResidue || scriptError ? '手动清理: sudo pkill -9 mihomo' : `手动清理: sudo rm -f ${PATHS.pidFile}`);
  if (cancelled) {
    return new CliError('管理员密码未输入或有误，root 残留未被清理', { label: '已取消', hint });
  }
  return new CliError(scriptError?.message ?? pidError?.message ?? 'root 残留未清理干净', { label: '清理残留进程失败', hint });
}

/**
 * 残留清理结果的三档处置（纯判据，供测试——真实 root/非 TTY 场景无法黑盒构造）：
 * - 'throw'：root 清理没走通且进程仍在（remaining + scriptError），主体动作结果要说清
 * - 'warn'：无残留进程但有收尾错误（pid 文件没删掉，或进程自行退光而清理没走完），
 *   无害不拦命令
 * - 'ok'：无问题；用户态残留（remaining 非空、无 scriptError）也归这档——交各命令
 *   外层既有的复核（cmdStop 抛、cmdUninstall 提示、start 健康确认）。pidError 是
 *   免提权 unlink 的小错，不参与 throw 分档：remaining 非空时它跟着外层的残留
 *   处置走，不单独拦命令
 */
export type ResidueCleanupVerdict = 'ok' | 'warn' | 'throw';
export function classifyResidueCleanup(result: Pick<CleanupResult, 'remaining' | 'scriptError' | 'pidError'>): ResidueCleanupVerdict {
  // 有进程活着：root 清理没走通（scriptError）才拦命令；用户态残留无论是否
  // 带着pidError 小错都交外层复核。进程清零：收尾错误只警告
  if (result.remaining.length > 0) return result.scriptError !== null ? 'throw' : 'ok';
  return result.scriptError !== null || result.pidError !== null ? 'warn' : 'ok';
}

/**
 * 服务路径的残留内核收口。唯一实现是 process-stop 的 cleanupAll
 * （用户态逐 pid 复核 / root 一次 sudo 脚本 + 死亡等待），抛错/警告判据见
 * classifyResidueCleanup。pid 文件免提权清理、失败只警告，非 TTY 的
 * `mihomo-cli stop` 不会被一个无害残留挡成 exit 1
 */
async function cleanupKernelsOrThrow(ctx: RootResidueCleanupContext): Promise<void> {
  const result = await cleanupAll();
  const verdict = classifyResidueCleanup(result);
  if (verdict === 'ok') return;
  const err = buildRootResidueCleanupError(result, ctx);
  if (verdict === 'throw') throw err;
  console.warn(colors.yellow(`警告: ${err.message}`));
  for (const line of err.hint) console.warn(colors.gray(line));
}

/**
 * 安装/重装服务。
 *
 * 幂等：可反复执行。`wasRunning` 为真时装完恢复运行（避免「代理开着时更新后重装静默关代理」），
 * 首装则显式 `disable`——install 只负责装，启动是 `start` 的事。
 * 前置只要求内核存在（plist 指向它）；**不要求 config.yaml**，因为装完不启动。
 *
 * 返回 `restoreSkipped=true` 表示 `wasRunning` 的恢复运行被**并发的 stop** 取消
 * （安装本身已成功）。调用方必须据此跳过健康确认——否则会对着一个本就不该启动的服务
 * 报「恢复运行失败」，把用户的 stop 说成故障。
 *
 * @param wasRunning 重装前是否在运行。恢复分支的并发判据读进程基线
 *   （captureStopEpochBaseline，main() 在命令入口捕获）——不在此现取：
 *   stop 在自己的锁内先递增、之后才 waitUntilUnloaded，现取的基线必然已含对方的递增。
 *   **自我中止的雷**：本基线只被 `wasRunning` 恢复分支消费，而首装的
 *   `disableServiceAutoStart()` 在互斥的另一条分支上；若将来在恢复分支之前新增任何
 *   递增，install 就会检出自己的 bump 并取消自己的恢复。
 */
export async function installService(wasRunning: boolean): Promise<{ restoreSkipped: boolean }> {
  assertServiceLabelSafe();
  ensureDirs();
  ensureServiceSymlink();

  let restoreSkipped = false;
  // 暂存路径见 PATHS.servicePlistStage 的注释：不放 runtime/（并发 stop/reset 删目录的窗口）
  const stagePath = PATHS.servicePlistStage;
  atomicWriteFileSync(stagePath, buildPlist(), { mode: 0o600 });

  try {
    // plutil -lint 先行：坏 plist 绝不进系统目录（bootstrap 失败后还得手工清理）
    const lint = spawnSync('plutil', ['-lint', stagePath], { encoding: 'utf8', timeout: 10_000 });
    if (lint.status !== 0) {
      throw new CliError('plist 语法校验失败（plutil -lint）', {
        hint: [(lint.stderr || lint.stdout || '').trim()].filter(Boolean),
      });
    }

    // 顺序不可换：**bootstrap 一个 disabled 的 label 不是「加载后不启动」，而是硬失败
    // `Bootstrap failed: 5: Input/output error`**（实测）。而 `stop` 恒置 disable 位，
    // 「stop 之后重装」是必经路径，少了 enable 这里就 100% 失败。
    bootoutService();
    await waitUntilUnloaded();

    // ~/Library/LaunchAgents 在全新系统上可能不存在；recursive 对已存在目录是 no-op，不改权限
    fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
    // 原子落位（同目录 tmp + rename）：copyFileSync 直写被 kill/掉电打断会留半截
    // plist，launchd 解析失败不加载，用户只见「install 像没生效」；stage 只留作 lint 载体。
    // tmp 名以 .tmp 结尾，launchd 不会把崩溃残留当 plist 扫
    atomicWriteFileSync(PATHS.userAgentPlist, fs.readFileSync(stagePath, 'utf8'), { mode: 0o644 });

    if (wasRunning) {
      // 并发的 stop 若在重装期间跑完（重装含 bootout + 等待，有真实窗口），这里的
      // enable+bootstrap 会把它的成果覆盖掉。判据共用 shouldAbortStartOnDisable——
      // **别在这里散写别的判据**；基线是命令入口捕获的进程基线，不在此处现取
      withFileLock(PATHS.serviceLock, () => {
        if (shouldAbortStartOnDisable(stopEpochBaseline(), readStopEpoch())) {
          restoreSkipped = true;
          return;
        }
        runLaunchctlOrThrow(['enable', serviceTarget()], '启用服务', SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
        bootstrapServiceIdempotentOrThrow('装载服务');
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
    // 首装关自启走 disableServiceAutoStart 自带事后确认，失败可见——首装若关自启失败，
    // 用户不该拿到一个 RunAtLoad 会在下次登录自启的「已安装」
    disableServiceAutoStart();
  }

  return { restoreSkipped };
}

/**
 * 「服务被要求停止」的单调计数（背景与两版判据的失效形态见 docs/decisions.md D2）。
 *
 * 读失败一律返回 0：文件不存在是首次运行的正常形态；内容损坏时宁可退回「按无并发处理」
 * 也不能让 start 抛错——start 是用户显式意图，不该被一个辅助计数挡住。
 * 导出仅供测试：并发用例要验的就是**这一份**实现在跨进程下的行为，
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
 * 本进程的并发判定基线。CLI 是单命令进程：main() 在命令入口 capture 一次，
 * 此后本进程所有消费点（锁内判定、热重载后复读、健康确认后复读）读同一份——
 * 停止计数的「命令开始时」基线是进程级事实，不需要跨层参数透传（docs/decisions.md D4）。
 * 未捕获时（测试直接调 service 函数、不经 main）stopEpochBaseline 退化为当前值，
 * 即不判并发——调用方要判并发须先 capture。
 */
let stopEpochBaselineCaptured: number | null = null;

/** 捕获当前停止计数为本进程的并发判定基线（命令入口调一次）。返回捕获值。 */
export function captureStopEpochBaseline(): number {
  stopEpochBaselineCaptured = readStopEpoch();
  return stopEpochBaselineCaptured;
}

/** 并发判定基线：命令入口捕获的值；未捕获时退化为当前值（不判并发）。 */
export function stopEpochBaseline(): number {
  return stopEpochBaselineCaptured ?? readStopEpoch();
}

/**
 * 递增停止计数。写失败**静默忽略**：它只用于并发判定，写不进去最坏退回无防线，
 * 不能让 `stop` 因辅助文件写不了就整体失败——stop 的真正职责（bootout + disable）
 * 已经完成了。
 *
 * **不自己取锁**（withFileLock 不可重入），在 stopService/uninstallService 的
 * serviceLock 临界区内调用是安全的；锁外调用点（install 首装、cmdStart 的 TUN 分支）
 * 的读-改-写可能与他人交错而丢一次递增——判据只问「值变没变」，不问增量准不准。
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
 * 记录一次「已确认停止」：没有 disable 可执行、但状态读取已证明「不会自启且无内核在跑」
 * 的路径（cmdStop 的提前返回、reset 在服务未装时的游离内核清理）。disableServiceAutoStart
 * 覆盖的是有 disable 动作的路径——两个递增入口的前提相同，见 docs/decisions.md D2。
 *
 * 不变式：调用点必须在该路径**最后一道失败检查之后**。走到这条路径本身就是独立依据
 * （相关读取失败都抛错而非降级：assertLaunchctlQueryOk、getMihomoPids 只收退出码 0/1）；
 * 放早了会让一次失败的停止把并发的 start 白白中止。
 * 不自己取锁（同 bumpStopEpoch）；多写者交错偶发用较小值覆盖较大值，判据是 `!==`
 * 而非 `>` 本就偏保守，接受之，不为此加锁。
 */
export function recordServiceStopped(): void {
  bumpStopEpoch();
}

/**
 * 锁内是否应放弃启动。判据只有一份，`startService` 与回归测试共用——
 * **别在别处散写 `isServiceDisabledInLaunchd()` 就 return**。
 *
 * 判据是**停止计数是否变化**，不是 disable 位的值：位是持久的，「上次 stop 留下的」与
 * 「本次并发置的」完全同形，而两者的语义相反——上次留下的位不拦 start（用户显式敲了
 * start，意图就是启动，照常 enable + bootstrap）；本次执行期间变化的计数才拦。
 * 两版判据各自的失效形态见 docs/decisions.md D2，别再退回任何一边。
 */
export function shouldAbortStartOnDisable(stopEpochBefore: number, stopEpochNow: number): boolean {
  return stopEpochNow !== stopEpochBefore;
}

/**
 * 启动服务并开启自启。返回 `started=false` 表示被**并发的 stop** 取消（见
 * `shouldAbortStartOnDisable`）——调用方必须把它当失败处理，不能继续报「已启动」。
 * 并发基线是命令入口捕获的进程基线（stopEpochBaseline，main() 调
 * captureStopEpochBaseline）——不能在此现取：那时订阅更新等慢速阶段已经过去，
 * 期间发生的 stop 就被算进「基线」了。
 *
 * 顺序关键：`enable` 必须在 `bootstrap` **之前**——bootstrap 一个 disabled 的
 * label 是硬失败 `Bootstrap failed: 5`（实测，不是「加载了但不启动」）。而 `stop` 恒置
 * disable 位，「stop 之后再 start」是最常走的路径，少了 enable 这里就 100% 失败。
 * 先 `bootout` 清旧使重复调用幂等（改过 plist 后 start 一下即按新配置重载，无需 kickstart）。
 *
 * **bootout 刻意留在锁外**：withFileLock 要求 fn 同步，而 bootout 后必须异步轮询
 * waitUntilUnloaded（最多 5s）。放锁外是安全的——并发 stop 若发生在此处，A 的 bootout
 * 只是幂等空操作，计数变化会在锁内被检出并中止启动（这正是用计数而非 disable 位快照
 * 的价值：不必靠扩大临界区来防这个窗口）。
 */
export async function startService(): Promise<{ started: boolean }> {
  assertServiceLabelSafe();
  ensureServiceSymlink();

  if (!isServiceInstalled()) {
    throw new CliError('服务未安装', { hint: '安装服务: mihomo-cli install' });
  }
  if (!fs.existsSync(PATHS.configFile)) {
    throw new CliError('未找到运行时配置', { hint: '请先添加订阅: mihomo-cli sub add <url>' });
  }

  // 拒绝用 TUN 配置启动服务：服务以普通用户运行（用户级 LaunchAgent），无权创建 utun
  // 设备，真启起来就是崩溃后被 KeepAlive 每约 10s 拉起一次，日志刷爆而代理不通。
  // 正常路径下 cmdStart 会先按 mixed 重建配置，走不到这里；这是防御用户手工改 config.yaml，
  // 或旧版本数据目录里恰好躺着一份 TUN 配置。与 cmdStart「起 TUN 前先关服务自启」
  // 是同一问题的两层——那层堵源头，这层兜底。
  if (getConfigInfo()?.tun) {
    throw new CliError('运行时配置为 TUN 模式，服务无法使用', {
      hint: [
        '服务以普通用户身份运行（用户级 LaunchAgent），无权创建 TUN 设备，',
        '强行启动只会让内核反复崩溃重启。',
        '',
        '按 Mixed 重建配置并启动:  mihomo-cli start mixed',
        '确实要用 TUN:            mihomo-cli tun',
      ],
    });
  }

  // tun 残留是 root 属主，会与服务抢端口；有才清（这是唯一可能弹密码的地方），无则免密
  await cleanupKernelsOrThrow({ mainOutcome: '服务尚未启动', retryCommand: 'mihomo-cli start' });

  bootoutService();
  await waitUntilUnloaded();

  // 轮转日志。**必须卡在「旧进程已退出、新进程未 bootstrap」的窗口**：此时无人持有日志
  // fd，rename 才生效。运行中 rename 无效——launchd 的 StandardOutPath fd 指向旧 inode，
  // 改名后内核会继续往归档文件里写（restartService 因此只能 copy-truncate）。
  rotateAndCleanupLogs();

  // 跨进程锁：串行化 enable/bootstrap 与 stop 的 bootout/disable/递增。锁内读停止计数，
  // 与命令入口的基线比对——变了就是期间有人 stop 过，放弃启动
  let started = true;
  withFileLock(PATHS.serviceLock, () => {
    if (shouldAbortStartOnDisable(stopEpochBaseline(), readStopEpoch())) {
      started = false;
      return;
    }
    runLaunchctlOrThrow(['enable', serviceTarget()], '启用服务', SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
    bootstrapServiceIdempotentOrThrow('启动服务');
  });

  return { started };
}

/**
 * 只关自启，不动运行中的实例（`disable` 决定「退出/登录后是否再拉起」，不终止当前进程）。
 * 为什么 TUN 用过后必须关服务自启（开机自启路径不经过 CLI），见 docs/decisions.md D1
 * 与本文件头。
 *
 * 幂等：已 disable 时再调一次无副作用。**停止计数有两个递增入口，这是其中之一**
 * （真实 disable + print-disabled 事后复核），另一个是 `recordServiceStopped`；
 * 走这个出口的新增调用点自动获得正确行为，别绕过它直接 `launchctl disable`。
 *
 * @param timeoutMs stop/uninstall 在 serviceLock 内调用时必须传
 *   SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS：本函数含 disable + print-disabled 复核两次
 *   launchctl，加上锁体里的 bootout 共三次，是持锁预算的大头（见该常量注释）。
 *   锁外调用（install 首装、cmdStart 的 TUN 分支、uninstall 的锁外复核）保持默认 5s
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
 * 即便 plist 不存在也照常执行：用户手动删掉 plist 后任务仍可能处 bootstrapped 状态，
 * KeepAlive 会继续拉起内核，此时只有 bootout 能救。
 */
export async function stopService(): Promise<void> {
  assertServiceLabelSafe();

  // 跨进程锁：与 startService 的 enable/bootstrap 串行化。锁内三次 launchctl
  // （bootout + disable + print-disabled 复核）全部走 SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS，
  // 最坏 9s < 锁强夺阈值 10s（预算论证见该常量注释）
  // 不加 await：withFileLock 是同步的，且要求 fn 同步（持锁期间让出事件循环等于没锁）
  withFileLock(PATHS.serviceLock, () => {
    bootoutService(SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
    disableServiceAutoStart(SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS);
  });

  await waitUntilUnloaded();

  // bootout 通常已终止托管内核；tun 起的 root 内核与手动残留在此收口。
  // 重跑 stop 即可重试清理：此时服务已停，cmdStop 走「游离内核」路径再次提权
  await cleanupKernelsOrThrow({ mainOutcome: '服务已停止，登录自启已关闭', retryCommand: 'mihomo-cli stop' });
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
  try {
    fs.rmSync(PATHS.userAgentPlist, { force: true });
  } catch (e) {
    throw new CliError(`删除 plist 失败（${PATHS.userAgentPlist}）: ${(e as Error).message}`);
  }

  // disable 位已在上面的锁内由 disableServiceAutoStart 写入并经 print-disabled 复核
  // （同 stopService），中间只隔 rm plist——不触碰 disabled 表，第二次调用必然成功，
  // 是纯冗余，还让一次 uninstall 双递增 epoch。位刻意不清（launchctl 无清除动词，
  // 见函数头注释）；plist 被别的途径放回时，残留的 disabled 位正是想要的语义

  // 重试入口是 stop 而非 uninstall：卸载完成后重跑 uninstall 会因「未安装且未装载」
  // 幂等返回，不会重试残留清理；stop 的游离内核路径（cleanupAll）才会再次提权
  await cleanupKernelsOrThrow({ mainOutcome: '服务已卸载', retryCommand: 'mihomo-cli stop' });

  // 符号链是本工具装的，卸载时一并清掉（内核本体保留，那是 kernel 命令的资产）
  try {
    fs.rmSync(PATHS.serviceBinary, { force: true });
  } catch {
    /* ignore：不存在或已被 reset kernel 带走 */
  }
}

/**
 * 生成遗留安装清理脚本的 body（写盘 + chmod + sudo + 退出码映射由 runSudoScript 统一完成）。
 * 导出仅为测试退出码协议：脚本内部失败用 ≥2 的退出码（bootout 真实失败为 3，
 * plist rm 后复核仍存在为 4），1 留给 sudo 鉴权取消/密码错误。
 *
 * 脚本**不删 pid 文件**：bootout 返回 113（daemon 未装载）时，pid 可能属于一个无关的
 * 活 TUN，脚本内无条件 rm 会删掉活进程的 isRunning 真相源。pid 由
 * cleanupLegacyInstallOrThrow 在拆除成功、复核零进程后免提权收口（reapPidWhenQuiet）
 */
export function buildLegacyCleanupScript(): string {
  return [
    '#!/bin/bash',
    // bootout 退出码分级：113=未装载（daemon 已不在，正常），其余是真实失败，
    // 不能 || true 吞掉后照样 rm plist 报「已清理」
    `bootout_code=0`,
    `launchctl bootout ${shellQuote(`system/${SERVICE_LABEL}`)} 2>/dev/null || bootout_code=$?`,
    `if [ $bootout_code -ne 0 ] && [ $bootout_code -ne 113 ]; then`,
    `  echo "launchctl bootout 失败（退出码 $bootout_code）" >&2`,
    `  exit 3`,
    `fi`,
    `rm -f ${shellQuote(PATHS.systemDaemonPlist)}`,
    // rm -f 静默吞错：删失败（文件系统只读等极端态）不声不响，而残留 plist 会在
    // 下次开机被 launchd 重新加载（KeepAlive 幽灵复活）——删除结果必须复核可见
    `if [ -e ${shellQuote(PATHS.systemDaemonPlist)} ]; then`,
    `  echo "遗留服务 plist 删除失败（rm 后仍存在）" >&2`,
    `  exit 4`,
    `fi`,
    `chown "$SUDO_UID:$SUDO_GID" ${shellQuote(PATHS.logFile)} 2>/dev/null || true`,
    `chown -R "$SUDO_UID:$SUDO_GID" ${shellQuote(DIRS.data)} 2>/dev/null || true`,
    'exit 0',
    '',
  ].join('\n');
}

/**
 * 清理遗留的系统级安装（v3.0–v4.0 的 root LaunchDaemon，背景见 D1）。
 *
 * 需要一次密码：plist 是 root:wheel 拥有的，且 `launchctl bootout system/...` 需 root。
 * 顺带把 root 属主的日志/数据归还当前用户——不归还的话，之后的用户级服务会因
 * EACCES 写不了日志而起不来。
 */
function cleanupLegacySystemInstall(): void {
  assertServiceLabelSafe();

  runSudoScript(buildLegacyCleanupScript(), {
    action: '清理遗留的系统级服务',
    file: 'legacy-cleanup.sh',
    // 3 = 脚本内 bootout 真实失败（见 buildLegacyCleanupScript 的分级）；
    // 4 = plist rm 后复核仍存在（rm -f 静默失败的可见化）；
    // 具体退出码已由脚本 echo 到终端，故只指向「上方输出」
    codeMessages: { 3: 'launchctl bootout 未能卸载旧 daemon（详见上方输出）', 4: '未能删除遗留服务的 plist（详见上方输出）' },
  });
}

/**
 * 清理遗留 root LaunchDaemon 并把 runSudoScript 的普通 Error 包成 CliError——
 * 否则 sudo 取消密码 / 非 TTY 这类常规操作会带完整堆栈按「未预期错误」渲染。
 * install / uninstall / stop / start(tun) / reset 共用。
 *
 * 放 service.ts 而非 commands/shared.ts：shared.ts 被 start.ts 导入（restartToApply），
 * 若 start.ts 再反向导入 shared.ts 就成环。放这里依赖方向单向（commands → service）。
 */
export async function cleanupLegacyInstallOrThrow(): Promise<void> {
  try {
    cleanupLegacySystemInstall();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, {
      label: '清理遗留服务失败',
      hint: ['也可手动清理:', `  sudo launchctl bootout system/$(basename ${PATHS.systemDaemonPlist} .plist)`, `  sudo rm -f ${PATHS.systemDaemonPlist}`],
    });
  }

  // 脚本不碰 pid：root 拆除成功后等进程收割，零进程才免提权删；并存的活 TUN 保留
  // 其 pid（status 真相）。删除失败只警告——迁移主体已完成，孤儿 pid 下次 stop 再清
  const pidError = await reapPidWhenQuiet();
  if (pidError) {
    console.warn(colors.yellow(`警告: ${describePidCleanupFailure(pidError)}，下次 stop 会再次尝试`));
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
  const controller = new AbortController();
  try {
    // 状态查询同样可能抛错（launchctl 超时/112/125、settings 端口非法）：探测类失败
    // 必须按「热重载不可用」处理并回退 kickstart，不能让一次读状态失败直接废掉整个
    // restartService——launchd 病态时恰恰最需要 kickstart 自愈。契约见函数头注释。
    // withDisabled:false——热重载只消费 running/pid，print-disabled 是白多一次的阻塞
    // 查询；abort 预算也不该被它分食（见下方 timer 起表位置的注释）
    const status = getServiceStatus({ withDisabled: false });
    if (!status.running || status.pid === null) return false;

    // 端口经 settings.ports 解析（默认 9090），与 buildConfig 写进配置的值同源
    const baseUrl = `http://127.0.0.1:${getPorts().controller}`;
    // 配置了 controller_secret 时必须带 Bearer，否则内核返回 401 → 热重载恒失败回退重启。
    // 只接受字符串：非字符串在 buildConfig 已 fail-closed（start 链路先构建配置），
    // 这里是纵深防御，别把数字/对象拼进 Authorization
    const secret = readSettings().controller_secret;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (typeof secret === 'string' && secret) headers.Authorization = `Bearer ${secret}`;
    // timer 起表在状态查询之后、第一个 fetch 之前：abort 预算只覆盖网络探测与 PUT，
    // 不被前置的 launchctl 查询分食——launchctl 病态慢（print 各 2-3s）时 timer 在
    // fetch 前已到点会令热重载恒不可用，每次 restart 都退化为完整重启（代理瞬断）
    const timer = setTimeout(() => controller.abort(), HOT_RELOAD_TIMEOUT_MS);
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
      // 文档化成功码是 204（属 2xx，res.ok 天然涵盖）；非 2xx 一律回退 kickstart
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * 热重载成功后给 restartService 的返回值下结论：复读停止计数，变了就按并发停止处理。
 *
 * 热重载是唯一没有健康确认的「生效」路径（内核没重启，PUT 204 即接受），而 tryHotReload
 * 从状态探测到 PUT 返回有真实耗时窗口，期间的并发 stop 已完成 bootout + disable + 递增——
 * 不查就报「已启动」，终态与用户最后一条命令相反。
 *
 * `hotReloaded` 恒为 true（配置确实被内核接受，如实反映）；要不要报成功由 `started`
 * 说了算——它与 kickstart 回退分支的 `started` 同名同义，started=false 经
 * launchOrRestart 既有的「启动已取消」出口报错，文案不另起一份。
 * 判据复用 shouldAbortStartOnDisable，这里只是消费点，不写第二套比较。
 *
 * 抽成纯函数是为了可测：热重载路径依赖真实 launchd 状态与 external-controller，
 * 自动化测试起不了真服务（真实 launchctl 写操作不进测试），决策逻辑单独锁定；
 * 消费点另有端到端用例（fake launchctl + 桩 controller）。
 */
export function concludeHotReload(stopEpochBefore: number, stopEpochNow: number): { hotReloaded: boolean; started: boolean } {
  return { hotReloaded: true, started: !shouldAbortStartOnDisable(stopEpochBefore, stopEpochNow) };
}

/**
 * 重启托管内核使配置变更生效。优先热重载（PUT /configs，免 sudo、免 launchctl）；
 * 失败才回退 kickstart。kickstart -k 是命令式重启，不与 KeepAlive 冲突；
 * 若任务未装载（plist 在但被手动 bootout）则 bootstrap 自愈。
 *
 * 返回 `hotReloaded` 决定调用方是否要做启动健康检查：热重载没有重启进程
 * （配置被内核接受才返回 204，被拒是 400 → 回退 kickstart），无需再验；
 * 走了 kickstart 就等于重启了内核，必须验，否则坏配置会静默进入 KeepAlive 崩溃循环。
 *
 * 日志超阈值时跳过热重载、强制 kickstart 顺便 copy-truncate（运行中不能 rename 轮转——
 * launchd 的 StandardOutPath fd 指向旧 inode，rename 后日志会继续写进归档文件；
 * 只能 copy-truncate，fd 为 O_APPEND，truncate 后从 0 续写不丢句柄）。
 * 轮转发生在判据之前，故被取消的重启可能已经轮转过一次日志：copy 在 truncate 之前，
 * 数据不丢，**刻意不为此再加一个判据消费点**——一个函数一个消费点比这点整洁更值。
 *
 * 返回 `started=false` 表示启动性动作被**并发的 stop** 取消——kickstart 失败后的
 * enable+bootstrap 回退（锁内判据），或热重载成功后的复读（concludeHotReload）——
 * 与 `startService` 的 `started` 同名同义。此时 `hotReloaded` 无意义，
 * 调用方必须先判 `started`，不能继续报「已启动」。
 * 基线是命令入口捕获的进程基线（stopEpochBaseline），两条出口都消费它：热重载成功后的
 * 复读（热重载探测有真实耗时窗口），kickstart 失败的 enable+bootstrap 回退在锁内复读
 * （热重载探测加 kickstart 最长可达 60s）——期间的并发 stop 只有它们兜得住。
 */
export async function restartService(): Promise<{ hotReloaded: boolean; started: boolean }> {
  if (!isServiceInstalled()) {
    throw new CliError('服务未安装，无法重启', { hint: '安装服务: mihomo-cli install' });
  }

  if (!logOversized() && (await tryHotReload())) {
    return concludeHotReload(stopEpochBaseline(), readStopEpoch());
  }

  if (logOversized()) {
    // 归档路径经 allocateArchivePath（log-files.ts 的单一命名规则）：同一秒内两次轮转
    // 会互相覆盖归档（copyFileSync 静默覆盖），它负责追加序号后缀
    const archiveFile = allocateArchivePath();
    try {
      fs.copyFileSync(PATHS.logFile, archiveFile);
      fs.writeFileSync(PATHS.logFile, '');
    } catch {
      /* 轮转失败不阻塞重启（best-effort） */
    }
  }

  // kickstart -k 会**阻塞等进程死亡**（实测对不立即响应 SIGTERM 的进程可超过 5s），
  // 单独放宽到 60s。
  //
  // **kickstart 刻意留在锁外**：60s 远超锁强夺阈值 10s，放进锁里必然被别的进程强夺，
  // 等于没锁（与 startService 把 bootout 留在锁外同因）。代价是「kickstart 成功 +
  // 随后并发 stop」这一交错仍在锁外——那一支由 launchOrRestart 在健康确认失败后
  // 复读计数兜住，不在这里重复设防。
  const kick = runLaunchctl(['kickstart', '-k', serviceTarget()], 60_000);
  let started = true;
  if (kick.status !== 0) {
    // 回退路径与 startService 同族：enable + bootstrap 会把并发 stop 的成果覆盖掉，
    // 终态与用户最后一条命令相反。判据共用 shouldAbortStartOnDisable——
    // **别在这里散写别的判据**
    withFileLock(PATHS.serviceLock, () => {
      if (shouldAbortStartOnDisable(stopEpochBaseline(), readStopEpoch())) {
        started = false;
        return;
      }
      runLaunchctl(['enable', serviceTarget()], SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS); // 容忍失败：bootstrap 会再判一次
      bootstrapServiceIdempotentOrThrow('重启服务');
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
