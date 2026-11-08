import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

import { assertKernelInstalled, assertRuntimeConfigPresent, getConfigInfo } from './config.js';
import { CliError } from './errors.js';
import { getServiceStatus, isServiceInstalled } from './launchctl.js';
import { readLogTail, rotateAndCleanupLogs } from './log-files.js';
import { DIRS, ensureDirs, PATHS } from './paths.js';
import { getMihomoPids, getPid, getStatus, isPidFileOwnedByRoot, isRunning, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import { MANUAL_PKILL_HINT, stop as stopProcesses } from './process-stop.js';
import { describeExitCause, restartService, startService, tunBlockedByConcurrentStart, waitServiceHealthy } from './service.js';
import { startAbortedByConcurrentStop } from './stop-epoch.js';
import { runSudoScript } from './sudo.js';
import { shellQuote } from './text.js';
import type { RuntimeMode, ServiceStatus } from './types.js';

/**
 * 运行时门面：收敛「launchd 服务(Mixed) vs 临时进程(TUN)」双轨的差异。
 *
 * 服务由 launchd 托管、不写 pidFile，状态查询走 launchctl；TUN 是 sudo 起的临时进程、
 * 写 pidFile，状态查询走 ps/pgrep。命令层若各自分支处理，极易重复与不一致。
 * 本模块把这几类差异各收敛为一个函数，命令层只调门面、不再关心底层是哪种运行时。
 *
 * TUN 的启动（临时 sudo 脚本，不走 launchd）也在本模块末尾：它只有 launchOrRestart 一个
 * 消费方。Mixed 模式**没有**用户态启动路径，由 launchd 服务托管（service.ts）。
 * 停止与清理在 process-stop.ts，探测在 process-probe.ts。
 *
 * 依赖方向：runtime → config/service/process（单向，三者均不反向依赖 runtime，无循环）。
 */

/**
 * 当前应使用的运行模式（未运行时的默认）。装了服务恒为 Mixed（服务只跑 Mixed）；
 * 否则沿用运行时配置的 tun 字段——避免订阅/覆写残留 tun 字段时被误判。
 *
 * 它**不反映实际在跑的东西**：`stop` 服务再 `start tun` 后，服务装着而 TUN 以 root
 * 在跑，本函数仍答 mixed。配置变更后的重启模式走 restartModeFor / restartModeOnChange。
 */
function getRuntimeMode(): RuntimeMode {
  if (isServiceInstalled()) return 'mixed';
  return getConfigInfo()?.tun ? 'tun' : 'mixed';
}

export interface RunningState {
  running: boolean;
  pid: number | null;
  /** 谁在跑：服务托管、TUN 临时进程，或都没有 */
  kind: 'service' | 'tun' | null;
  /**
   * TUN 进程的内存信息（复用 getStatus 内部已查的结果，免命令层再发一次 ps）；
   * 服务模式为 null——launchd 托管进程不查内存，且 status 本就不展示
   */
  memory: string | null;
}

/**
 * 统一的运行状态。服务已装载时以 launchctl 为准；否则看 TUN 的 pidFile 状态。
 *
 * 先服务后 TUN：两者互斥（start 会拦「服务在跑时起 TUN」），
 * 但服务残留未清时以服务为准更安全——它是会被 KeepAlive 拉起的那个。
 *
 * @param serviceStatus 可选的已查服务状态（printStatus 一次查询多处复用，
 *   避免 getServiceStatus 内部的 launchctl print + print-disabled 重复执行）
 */
export function getRunningState(serviceStatus?: ServiceStatus): RunningState {
  // RunningState 只消费 running/pid，不透出 disabled——默认查询跳过 print-disabled
  //（白多一次的阻塞 spawn，withDisabled:false 先例见 tryHotReload）；需要 disabled
  // 的调用方（status）自行查完整状态后经 serviceStatus 传入
  const service = serviceStatus ?? getServiceStatus({ withDisabled: false });
  if (service.running) {
    return { running: true, pid: service.pid, kind: 'service', memory: null };
  }

  const status = getStatus();
  if (status.running) {
    return { running: true, pid: status.pid, kind: 'tun', memory: status.memory };
  }

  return { running: false, pid: null, kind: null, memory: null };
}

/**
 * 纯决策：配置变更后应以哪种模式重启，取决于**实际在跑的东西**（判据唯一份，命令层不另写）。
 *
 * kind='tun' → 'tun'——**即便服务已装**：`stop` 服务再 `start tun` 的正常形态是
 * 服务 installed+disabled+unloaded、TUN 内核以 root 在跑，此刻 getRuntimeMode 按
 * 「装了服务恒 Mixed」答 mixed，照它重启会把 TUN 静默切回 Mixed、还为清 root 内核弹 sudo。
 * 其余（服务在跑或没在跑）回落 fallbackMode，调用方传 getRuntimeMode()：
 * 服务在跑必已装、它恒答 mixed；「装了服务恒 Mixed」的判据仍只有一份，本函数不重写。
 */
export function restartModeFor(state: RunningState, fallbackMode: RuntimeMode): RuntimeMode {
  return state.kind === 'tun' ? 'tun' : fallbackMode;
}

/**
 * 改动配置(切换订阅、覆写开关)后应以哪种模式重启内核使之生效；没有实例在跑返回
 * null——服务已装但未启动时不该顺手把它拉起来。
 *
 * 只查一次 getRunningState：「要不要重启」与「以哪种模式重启」共用同一份观察。
 * 分开查两次 launchctl 之间状态会漂移：期间内核恰好停掉时，模式判断会回落
 * getRuntimeMode（装了服务恒 Mixed），TUN 就被静默切走——正是要防的缺陷。
 */
export function restartModeOnChange(): RuntimeMode | null {
  const state = getRunningState();
  return state.running ? restartModeFor(state, getRuntimeMode()) : null;
}

/**
 * 启动内核，或(服务已在跑时)重启使新配置生效，返回 PID。
 * **不负责停止旧进程**——TUN 的清理由其启动脚本内的 pkill 完成。
 *   mixed → 已在跑走 restartService(优先热重载，免密)；否则 startService(enable + bootstrap)
 *   tun   → 启动前复核（assertTunStartNotRaced），再 startTun()
 *
 * Mixed 路径必须做健康确认：`launchctl bootstrap` 成功只代表任务被装载，不代表进程活着
 * （详见 waitServiceHealthy）。热重载路径无需确认：它没有重启进程，且配置被拒时会
 * 回退到 kickstart（走确认分支）。
 *
 * 并发判据统一走 startAbortedByConcurrentStop（命令入口基线，D4）；TUN 分支在 cmdStart
 * bump 自启后已重捕获基线，此处复核消费的是重捕获后的值。
 */
export async function launchOrRestart(mode: RuntimeMode): Promise<number | null> {
  if (mode === 'tun') {
    // 复核与 startTun 的 pkill 前复核共用同一份装载态：两次查询在同一同步拍，
    // 透传进去免 startTun 再发一次 launchctl print
    const prefetched = assertTunStartNotRaced();
    let pid: number;
    try {
      pid = await startTun(prefetched);
    } catch (e) {
      // sudo 等待或启动后的观察窗内发生 stop：报错归属取消，并确认没有留下刚起的进程
      await throwIfTunStartCancelled();
      throw e;
    }
    // sudo 返回后的进程健康只证明「有进程」，不证明「后执行的 stop 仍应被覆盖」。
    // 终态必须以最后一条命令为准，清理成功后才可报告取消
    await throwIfTunStartCancelled();
    return pid;
  }

  const status = getServiceStatus();

  // running && !disabled 才走热重载：`stop` 后被手动 bootstrap 的服务处于「在跑但 disabled」，
  // 只看 running 会走热重载、不清 disable 位，用户以为开了自启其实没有
  let hotReloaded = false;
  let started: boolean;
  if (status.running && !status.disabled) {
    // status 就是上方同一同步拍的查询，透传进去免热重载再发一次 launchctl print
    ({ hotReloaded, started } = await restartService(status));
  } else {
    ({ started } = await startService());
  }

  // 被并发的 stop 取消。必须单独成一条错误：落进 assertServiceHealthy 会报
  // 「内核未能进入运行状态」并附一个从未被创建的日志路径，指向完全错误的排查方向
  if (!started) throw cancelledByConcurrentStop();
  // 热重载的成功依据是 PUT 2xx + 端口身份确认（restartService），pid 只是展示附加值：
  // 取快照撞上 launchctl 瞬时失败时降级为 null（上层打印「已启动」不带 PID），
  // 不让已完成的重载被一次只读查询报成失败
  if (hotReloaded) {
    try {
      return getServiceStatus().pid;
    } catch {
      return null;
    }
  }

  try {
    return await assertServiceHealthy();
  } catch (e) {
    // 健康确认失败有两种成因，报错必须区分：内核真崩了，还是「期间有人 stop 把它 bootout 了」。
    // 后者报「内核未能进入运行状态」+ 日志尾部会把用户指向完全错误的方向——而 bootstrap
    // 之后到健康确认结束有 1.2–3s（SERVICE_OBSERVE_MS + GRACE）**完全在锁外**，锁内判据
    // 覆盖不到这段。
    // 判据仍是唯一那份 startAbortedByConcurrentStop，只是多一个消费点：只在**失败之后**复读，
    // 绝不改写健康的结果，也绝不在计数未变时吞掉真实死因
    if (startAbortedByConcurrentStop()) throw cancelledByConcurrentStop();
    throw e;
  }
}

/** 并发 stop 已发生后，撤销在途 TUN 的启动结果；清不干净时不得再报「已取消并保持停止」 */
async function stopTunAfterConcurrentStop(): Promise<void> {
  const result = await stopProcesses();
  if (result.remaining && result.remaining.length > 0) {
    throw new CliError(`检测到停止操作，但 TUN 进程未能终止（PID ${result.remaining.join(', ')}）`, {
      label: '停止失败',
      hint: [MANUAL_PKILL_HINT],
    });
  }
}

/** 未取消时放行原结果；已取消时先清理 TUN，再统一报告取消。 */
async function throwIfTunStartCancelled(): Promise<void> {
  if (!startAbortedByConcurrentStop()) return;
  await stopTunAfterConcurrentStop();
  throw cancelledByConcurrentStop();
}

/**
 * 「启动已取消：期间检测到停止操作」这条错误的唯一出处。三个消费点共用（锁内判据、
 * 健康确认失败后复读、TUN 启动前复核），文案只此一份——散写两份，改一处忘一处就是
 * 本仓反复栽的漂移。
 *
 * 文案刻意说「停止操作」而非「执行了 mihomo-cli stop」：递增点不止 `stop`，`tun` 与 install
 * 首装同样会关闭自启并递增，说成 stop 是在讲一件没发生的事。
 */
function cancelledByConcurrentStop(): CliError {
  return new CliError('启动已取消：期间检测到停止操作', {
    label: '启动失败',
    hint: [
      '另一个终端在本次启动过程中关闭了服务自启（mihomo-cli stop，或 tun / install 等同样会关闭自启的命令），已按最后一条命令保持停止。',
      '',
      '确实要启动: mihomo-cli start',
    ],
  });
}

/**
 * TUN 启动前的并发复核。TUN 的慢速阶段（订阅更新约 10s、sudo 密码窗最长 60s）全在
 * 锁外，没有这道复核的话（C1，全对枚举推演确认的两条矛盾交错）：
 * ① 并发 stop 在密码窗期间执行「无事可做」并 bump 后，TUN 照常启动——终态与用户
 *    最后一条命令相反；窗口是秒级（密码窗），不是已接受的毫秒级探测交错；
 * ② 并发的 mixed start 在本命令 bump 之后完成 bootstrap（其锁内判定的基线是本命令
 *    bump 后的值，不触发它的取消），TUN 脚本的 pkill 会杀掉它的服务内核。
 * ①用 epoch 判据（本命令已在 bump 后重捕获基线，自己的递增不计入）；②复核装载态。
 * 两个判据都不写第二份比较——epoch 判据走 startAbortedByConcurrentStop 唯一读法（D2）。
 *
 * 返回本次装载态快照供 startTun 的 pkill 前复核复用（同一同步拍，不重查）。
 */
export function assertTunStartNotRaced(): ServiceStatus {
  if (startAbortedByConcurrentStop()) throw cancelledByConcurrentStop();
  // withDisabled:false——本判据只消费 loaded，print-disabled 是白多一次的阻塞查询
  const status = getServiceStatus({ withDisabled: false });
  if (status.loaded) throw tunBlockedByConcurrentStart();
  return status;
}

/** 按当前运行模式给出重启提示命令：TUN 在跑时裸 `mihomo-cli start` 会静默切回
 * Mixed（还要一次 sudo），必须给 `start tun`。sub update / sub remove / kernel
 * 更新的重启提示共用此判据——各写一份会在改判据时漏一边 */
export function startCommandForCurrentMode(state: RunningState): string {
  return state.kind === 'tun' ? 'mihomo-cli start tun' : 'mihomo-cli start';
}

/**
 * 确认服务真正跑起来了，否则抛出带日志尾部的 CliError。
 *
 * 崩溃循环下必须报错而非报成功：KeepAlive 会每隔约 10s 重新拉起坏内核，日志被刷爆，
 * 而用户拿到的是「已启动 (PID xxx)」。日志尾部直接附在错误里——那是用户唯一的线索。
 *
 * 导出供 cmdInstall 的重装恢复路径共用：那里同样 bootstrap 后就打印
 * 「已按原状态重新启动」，缺这道确认就是「bootstrap 返回 0 ≠ 内核活着」的漏网分支。
 *
 * 死因文案走 `describeExitCause`（service.ts 的唯一判据），**不能自己拼
 * `退出码 ${exitCode}`**：信号死亡时 launchd 不写 last exit code，exitCode 为 null，
 * 被 OOM killer / `kill -9` 杀掉的内核会显示成「退出码 null」。
 */
export async function assertServiceHealthy(label = '启动失败'): Promise<number | null> {
  const health = await waitServiceHealthy();
  if (health.healthy) return health.pid;

  const tail = readLogTail();
  const cause = describeExitCause(health.exitCode, health.terminatingSignal);
  const reason = health.crashed ? `内核启动后立即退出（${cause ?? '死因未记录'}）` : '内核未能进入运行状态';

  throw new CliError(reason, {
    label,
    hint: [
      ...(health.crashed ? ['launchd 会每隔约 10 秒反复拉起它，请先修正配置或执行 mihomo-cli stop。'] : []),
      ...(tail.length > 0 ? ['', '--- 日志尾部 ---', ...tail] : ['', `日志: ${PATHS.logFile}`]),
      '',
      '完整日志: mihomo-cli logs 0',
    ],
  });
}

const TUN_MODE_POST_WAIT_MS = 500;

/**
 * 生成 TUN 启动脚本 body（不写盘：写盘 + chmod + sudo + 清理由 runSudoScript 统一完成，
 * 与 service 的 sudo 路径共用同一套范式，不再各自手写 spawnSync('sudo')）。
 *
 * 命令行为 `<mihomoBinary> -d <data> -f <configFile>`——与服务的 plist 同构（后者
 * ProgramArguments[0] 是符号链），两者都被 MAIN_INSTANCE_PATTERN 的二选一分支覆盖。
 *
 * 导出仅为测试观察窗契约：脚本本体的执行形态见 runtime.spec（真实 sudo 不进自动化）
 */
export function buildTunLaunchScript(): string {
  const binary = shellQuote(PATHS.mihomoBinary);
  const configFile = shellQuote(PATHS.configFile);
  const logFile = shellQuote(PATHS.logFile);
  const pidFile = shellQuote(PATHS.pidFile);
  const dataDir = shellQuote(DIRS.data);
  const killPattern = shellQuote(MAIN_INSTANCE_PATTERN);

  return (
    '#!/bin/bash\n' +
    `BINARY=${binary}\n` +
    `CONFIG_FILE=${configFile}\n` +
    `LOG_FILE=${logFile}\n` +
    `PID_FILE=${pidFile}\n` +
    `DATA_DIR=${dataDir}\n` +
    `KILL_PATTERN=${killPattern}\n` +
    '\n' +
    '# 终止旧进程\n' +
    'pkill -9 -f "${KILL_PATTERN}" 2>/dev/null || true\n' +
    'sleep 0.2\n' +
    'rm -f "${PID_FILE}" 2>/dev/null || true\n' +
    '\n' +
    '# 写入启动标记\n' +
    'echo "=== TUN 启动: $(date) ===" >> "${LOG_FILE}"\n' +
    '\n' +
    '# 启动\n' +
    'cd /tmp\n' +
    '"${BINARY}" -d "${DATA_DIR}" -f "${CONFIG_FILE}" >> "${LOG_FILE}" 2>&1 &\n' +
    'NEW_PID=$!\n' +
    'echo ${NEW_PID} > "${PID_FILE}"\n' +
    '\n' +
    '# 进程判定：活着 = ps 能查到且状态非 Z。不能只用 kill -0——它对僵尸\n' +
    '#（bash 尚未收割的已死子进程）同样返回成功，实测 150ms 退出的桩进程 10 次中\n' +
    '# 5 次被误报存活；查不到（已被收割/不存在）同样算死。\n' +
    'is_alive() {\n' +
    '  local stat\n' +
    '  stat=$(ps -p "$1" -o stat= 2>/dev/null) || return 1\n' +
    '  case "${stat}" in\n' +
    "    Z*|'') return 1 ;;\n" +
    '    *) return 0 ;;\n' +
    '  esac\n' +
    '}\n' +
    '\n' +
    '# 验证：观察满一个窗口（12 × 0.1s ≈ 1.2s，与服务路径 SERVICE_OBSERVE_MS 对齐）。\n' +
    '# 不能「一看到活着就收口」——内核常在 spawn 后数百 ms 才退出（实测 180ms 与 540ms\n' +
    '# 两种），此前的 0.4s 单次检查必漏；期间死亡立即走失败路径。\n' +
    'i=0\n' +
    'while [ $i -lt 12 ]; do\n' +
    '  sleep 0.1\n' +
    '  is_alive ${NEW_PID} || break\n' +
    '  i=$((i+1))\n' +
    'done\n' +
    'if is_alive ${NEW_PID}; then\n' +
    '  exit 0\n' +
    'fi\n' +
    '\n' +
    '# 失败，显示日志（退出码 2：避开 sudo 的 1=鉴权失败/取消，供调用方区分）\n' +
    'rm -f "${PID_FILE}" 2>/dev/null || true\n' +
    'echo "TUN 启动失败"\n' +
    'echo ""\n' +
    'echo "--- 日志 ---"\n' +
    'tail -25 "${LOG_FILE}" 2>/dev/null\n' +
    'exit 2\n'
  );
}

/**
 * @param prefetched 调用方（launchOrRestart）在同一同步拍经 assertTunStartNotRaced
 *   取得的装载态；缺省时自行复核（直接调用与测试路径）。
 *   两处是同一拍的同一件事，不该各发一次 launchctl
 */
export async function startTun(prefetched?: ServiceStatus): Promise<number> {
  ensureDirs();

  // 存在性校验先于日志轮转：轮转把 mihomo.log rename 成归档后，仍在运行的旧 TUN
  // 内核（fd 指向被改名的 inode、O_APPEND）会继续往「归档文件」写——秒失败错误
  // （内核没装、配置缺失）不该先动日志。sudo 取消路径的同类窗口无法完全消除
  // （rename 进不了 root 脚本），但校验前置消掉了最常见的形态
  assertKernelInstalled();
  assertRuntimeConfigPresent();

  // pkill 前最后一道复核（存在性校验之后、日志轮转**之前**）：cmdStart 的 loaded
  // 守卫读的是命令开头的快照，此后隔着订阅更新与配置构建两个慢速阶段；期间另一
  // 终端 start（mixed）把服务拉起的话，不但脚本的 pkill 会无差别杀掉它、KeepAlive
  // 拉回后与 root TUN 内核抢同一组端口，**轮转还会先把在跑服务的 mihomo.log rename
  // 进归档**（launchd fd 继续写归档，`logs 0` 从此看不到服务的新日志）——检出即
  // 中止，日志未动、服务的运行不动。故校验与复核都必须排在轮转之前。
  // 复核点到 pkill 执行之间仍隔着 sudo 密码窗口，无法归零（pkill 在 root 脚本内，
  // 进不了锁）；那一侧由 stop epoch 防线兜底：TUN 分支过守卫后已 bump，start 的
  // enable+bootstrap 在锁内必读到变化而放弃——与 kickstart 60s 锁外交错同一级别的
  // 已知残余，见 CONCLUSIONS「TUN 与 sudo」。
  // withDisabled:false——只消费 loaded，print-disabled 是白多一次的阻塞查询
  const serviceLoaded = prefetched ? prefetched.loaded : getServiceStatus({ withDisabled: false }).loaded;
  if (serviceLoaded) {
    throw tunBlockedByConcurrentStart();
  }

  rotateAndCleanupLogs();

  // 系统级服务或此前的 TUN 曾以 root 写过 mihomo.log；日志此后仍由 root 追加，
  // 但 rotateAndCleanupLogs 的 rename 需要目录权限（logs/ 属用户，可行）。
  // 若日志本身不可写且非 root 场景（用户态服务留下的），删掉让 root 重建，避免权限僵局。
  const logFile = PATHS.logFile;
  if (fs.existsSync(logFile)) {
    try {
      fs.accessSync(logFile, fs.constants.W_OK);
    } catch {
      try {
        fs.unlinkSync(logFile);
      } catch {
        /* ignore：极端情况下留给启动脚本的 >> 重定向抛出可读错误 */
      }
    }
  }

  const stalePids = getMihomoPids();
  if (stalePids.length > 0) {
    console.log(`清理 ${stalePids.length} 个残留进程...`);
  } else if (isPidFileOwnedByRoot()) {
    // 无残留进程但 pid 文件是 root 属主：按文件说，「清理 0 个残留进程」是误导
    console.log('清理残留的 root pid 文件...');
  }
  console.log('TUN 模式需要 sudo 权限...');

  // runSudoScript 统一处理：写临时脚本 + chmod 700 + 单次 sudo + 退出码映射 + 用后即删。
  // 退出码 2 是脚本自身的「启动失败（详见上方日志）」；1 留给 sudo 鉴权取消/密码错误。
  runSudoScript(buildTunLaunchScript(), {
    action: 'TUN 启动',
    file: 'launch-tun.sh',
    codeMessages: { 2: 'TUN 启动失败（详见上方日志）' },
  });

  await sleep(TUN_MODE_POST_WAIT_MS);

  // 复核存活而非只读 pid 文件：脚本观察窗（1.2s）结束后内核仍可能退出（端口冲突等
  // 晚期失败），pid 文件还在而进程已死——只读文件会把这报成启动成功。
  // isRunning 同时校验命令行，防 pid 被无关进程复用
  const finalPid = getPid();
  if (!finalPid || !isRunning()) {
    const tail = readLogTail();
    throw new CliError('TUN 启动失败（内核未能保持运行）', {
      hint: [...(tail.length > 0 ? ['--- 日志尾部 ---', ...tail, ''] : [`日志: ${PATHS.logFile}`]), '', '完整日志: mihomo-cli logs 0'],
    });
  }

  return finalPid;
}
