import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { getConfigInfo } from './config.js';
import { assertServiceLabelSafe, SERVICE_BINARY_NAME } from './constants.js';
import { CliError } from './errors.js';
import { concludeHotReload, logOversized, tryHotReload } from './hot-reload.js';
import {
  bootstrapDomain,
  buildPlist,
  getServiceStatus,
  isServiceDisabledInLaunchd,
  isServiceInstalled,
  LAUNCHCTL_NOT_LOADED,
  LAUNCHCTL_TIMEOUT_MS,
  runLaunchctl,
  runLaunchctlOrThrow,
  SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS,
  serviceTarget,
  waitUntilUnloaded,
} from './launchctl.js';
import { cleanupKernelsOrThrow } from './legacy-cleanup.js';
import { allocateArchivePath, cleanupOldLogs, rotateAndCleanupLogs } from './log-files.js';
import { atomicWriteFileSync, ensureDirs, PATHS, withFileLock } from './paths.js';
import { getMihomoPids } from './process-probe.js';
import { bumpStopEpoch, readStopEpoch, shouldAbortStartOnDisable, stopEpochBaseline } from './stop-epoch.js';
import type { ServiceStatus } from './types.js';
import { sleep } from './utils.js';

export { concludeHotReload, HOT_RELOAD_TIMEOUT_MS, tryHotReload } from './hot-reload.js';
// 拆分 re-export：launchctl 解析 / 停止计数 / 遗留清理 / 热重载四节移出本文件后，既有
// 消费方（commands、runtime、spec）仍统一从 './service.js' 取——导出清单是跨模块契约，
// 拆分不该迫使全仓改 import。新代码内部引用走各自模块。
export {
  bootstrapDomain,
  buildPlist,
  getServiceStatus,
  isServiceInstalled,
  LAUNCHCTL_TIMEOUT_MS,
  parseDisabledList,
  parseServicePrint,
  runLaunchctl,
  runLaunchctlOrThrow,
  SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS,
  serviceTarget,
  waitUntilUnloaded,
} from './launchctl.js';
export {
  buildLegacyCleanupScript,
  buildRootResidueCleanupError,
  classifyResidueCleanup,
  cleanupLegacyInstallOrThrow,
  detectLegacySystemInstall,
  type ResidueCleanupVerdict,
  type RootResidueCleanupContext,
} from './legacy-cleanup.js';
export { captureStopEpochBaseline, readStopEpoch, recordServiceStopped, shouldAbortStartOnDisable, stopEpochBaseline } from './stop-epoch.js';

/**
 * launchd 服务层：Mixed 模式的唯一运行方式。
 *
 * 装在用户域（`~/Library/LaunchAgents` + `gui/<uid>`），install/start/stop/uninstall 全程免 sudo。
 * 为什么不用 root LaunchDaemon、遗留系统级安装为何仍要识别与清理，见 docs/decisions.md D1。
 *
 * 结构（自本文件拆出的四节，re-export 保持导出清单不变）：
 * - launchctl.ts：print 输出解析、退出码语义、查询包装与服务状态读取
 * - stop-epoch.ts：停止计数与并发判定基线（D2/D4）
 * - legacy-cleanup.ts：遗留 root 安装清理与残留处置分档
 * - hot-reload.ts：热重载探测与结论；restartService 留在此处（消费 startService 的自举链）
 */

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
