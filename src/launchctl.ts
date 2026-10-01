import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { SERVICE_LABEL } from './constants.js';
import { CliError } from './errors.js';
import { DIRS, PATHS } from './paths.js';
import type { ServiceStatus } from './types.js';
import { sleep } from './utils.js';

/**
 * launchctl 解析与执行层：print / print-disabled 输出解析、退出码语义、查询包装与服务状态读取。
 * 自 service.ts 拆出（服务生命周期语义与 launchd 原语分层）；既有消费方经 service.ts 的
 * re-export 取这些导出，不受拆分影响。
 */

/** launchctl 查询超时：只读探测卡住时按「查不到」处理 */
export const LAUNCHCTL_TIMEOUT_MS = 5000;

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
export function serviceTarget(): string {
  return `${bootstrapDomain()}/${SERVICE_LABEL}`;
}

/** bootstrap/print-disabled 的域参数：`gui/<uid>` */
export function bootstrapDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** 服务是否已安装（plist 文件存在） */
export function isServiceInstalled(): boolean {
  return fs.existsSync(PATHS.userAgentPlist);
}

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
export const LAUNCHCTL_NOT_LOADED = 113;

export function runLaunchctl(args: string[], timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): { status: number | null; stdout: string; stderr: string } {
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
export function assertLaunchctlQueryOk(status: number | null, what: string): void {
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
export function isServiceDisabledInLaunchd(timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): boolean {
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
 * 执行一条 launchctl 写操作并要求成功（退出码 0）。用户域操作免密，直接 spawn；
 * 失败时把 stderr 收进 hint——launchctl 的报错文本（如 "Bootstrap failed: 5"）
 * 是排查的主要线索。需要 root 的路径才走 runSudoScript 的脚本形式。
 */
export function runLaunchctlOrThrow(args: string[], what: string, timeoutMs: number = LAUNCHCTL_TIMEOUT_MS): void {
  const result = runLaunchctl(args, timeoutMs);
  if (result.status === 0) return;
  const detail = result.stderr.trim();
  throw new CliError(`${what}失败（launchctl 退出码 ${result.status ?? '执行失败'}）`, {
    hint: [detail, `手动确认: launchctl ${args.join(' ')}`].filter(Boolean),
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
