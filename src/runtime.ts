import { getConfigInfo } from './config.js';
import { CliError } from './errors.js';
import { readLogTail } from './log-files.js';
import { PATHS } from './paths.js';
import { getStatus } from './process-probe.js';
import { startTun } from './process-start.js';
import {
  describeExitCause,
  getServiceStatus,
  isServiceInstalled,
  readStopEpoch,
  restartService,
  shouldAbortStartOnDisable,
  startService,
  waitServiceHealthy,
} from './service.js';
import type { ProcessInfo, ServiceStatus } from './types.js';

/**
 * 运行时门面：收敛「launchd 服务(Mixed) vs 临时进程(TUN)」双轨的差异。
 *
 * 服务由 launchd 托管、不写 pidFile，状态查询走 launchctl；TUN 是 sudo 起的临时进程、
 * 写 pidFile，状态查询走 ps/pgrep。命令层若各自分支处理，极易重复与不一致
 * （历史上两分支输出就已分叉）。本模块把这几类差异各收敛为一个函数，
 * 命令层只调门面、不再关心底层是哪种运行时。
 *
 * 依赖方向：runtime → config/service/process（单向，三者均不反向依赖 runtime，无循环）。
 */

export type RuntimeMode = 'mixed' | 'tun';

/**
 * 当前应使用的运行模式。装了服务恒为 Mixed（服务只跑 Mixed）；
 * 否则沿用运行时配置的 tun 字段——避免订阅/覆写残留 tun 字段时被误判。
 */
export function getRuntimeMode(): RuntimeMode {
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
  processInfo: ProcessInfo | null;
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
  const service = serviceStatus ?? getServiceStatus();
  if (service.running) {
    return { running: true, pid: service.pid, kind: 'service', processInfo: null };
  }

  const status = getStatus();
  if (status.running) {
    return { running: true, pid: status.pid, kind: 'tun', processInfo: status.processInfo };
  }

  return { running: false, pid: null, kind: null, processInfo: null };
}

/**
 * 改动配置(切换订阅、覆写开关)后是否需要重启内核使之生效。
 * 只在确有实例在跑时才需要——服务已装但未启动时不该顺手把它拉起来。
 */
export function isRestartNeededOnChange(): boolean {
  return getRunningState().running;
}

/**
 * 启动内核，或(服务已在跑时)重启使新配置生效，返回 PID。
 * **不负责停止旧进程**——TUN 的清理由其启动脚本内的 pkill 完成。
 *   mixed → 已在跑走 restartService(优先热重载，免密)；否则 startService(enable + bootstrap)
 *   tun   → startTun()
 *
 * Mixed 路径必须做健康确认：`launchctl bootstrap` 成功只代表任务被装载，不代表进程活着。
 * 内核因坏配置立即退出时 KeepAlive 会反复拉起，而此前只固定 sleep 500ms 取一次 pid
 * 就报「已启动」——用户以为代理开着，实际完全没有代理。详见 waitServiceHealthy。
 * 热重载路径无需确认：它没有重启进程，且配置被拒时会回退到 kickstart（走确认分支）。
 *
 * @param stopEpochBefore 命令开始时的停止计数快照（`readStopEpoch()`），透传给
 *   `startService` / `restartService` 判定「本次执行期间是否有人 stop 过」。
 *   **必填**：可选默认值会让新调用方静默退化成「只防本函数执行期间的 stop」，
 *   而这正是本仓反复栽的「防线只铺一条路径」。TUN 分支不消费它（`startTun` 与 launchd
 *   无关），保留形参是为了调用方无需分支
 */
export async function launchOrRestart(mode: RuntimeMode, stopEpochBefore: number): Promise<number | null> {
  if (mode === 'tun') {
    const result = await startTun();
    return result.pid;
  }

  const status = getServiceStatus();

  // running && !disabled 才走热重载：`stop` 后被手动 bootstrap 的服务处于「在跑但 disabled」，
  // 只看 running 会走热重载、不清 disable 位，用户以为开了自启其实没有
  let hotReloaded = false;
  let started: boolean;
  if (status.running && !status.disabled) {
    ({ hotReloaded, started } = await restartService(stopEpochBefore));
  } else {
    ({ started } = await startService(stopEpochBefore));
  }

  // 被并发的 stop 取消。必须单独成一条错误：落进 assertServiceHealthy 会报
  // 「内核未能进入运行状态」并附一个从未被创建的日志路径，指向完全错误的排查方向
  if (!started) throw cancelledByConcurrentStop();
  if (hotReloaded) return getServiceStatus().pid;

  try {
    return await assertServiceHealthy();
  } catch (e) {
    // 健康确认失败有两种成因，报错必须区分：内核真崩了，还是「期间有人 stop 把它 bootout 了」。
    // 后者报「内核未能进入运行状态」+ 日志尾部会把用户指向完全错误的方向——而 bootstrap
    // 之后到健康确认结束有 1.2–3s（SERVICE_OBSERVE_MS + GRACE）**完全在锁外**，
    // v4.7.7 的防线只覆盖了锁内那一瞬。
    //
    // 判据仍是唯一那份 shouldAbortStartOnDisable，只是多一个消费点：只在**失败之后**复读，
    // 绝不改写健康的结果，也绝不在计数未变时吞掉真实死因
    if (shouldAbortStartOnDisable(stopEpochBefore, readStopEpoch())) throw cancelledByConcurrentStop();
    throw e;
  }
}

/**
 * 「启动被并发的停止取消」这条错误的唯一出处。两个消费点共用（锁内判据、健康确认失败后复读），
 * 文案只此一份——散写两份，改一处忘一处就是本仓反复栽的漂移。
 *
 * 文案刻意说「停止操作」而非「执行了 mihomo stop」：递增点不止 `stop`，`tun` 与 install
 * 首装同样会关闭自启并递增，说成 stop 是在讲一件没发生的事。
 */
function cancelledByConcurrentStop(): CliError {
  return new CliError('启动已取消：期间检测到停止操作', {
    label: '启动失败',
    hint: [
      '另一个终端在本次启动过程中关闭了服务自启（mihomo stop，或 tun / install 等同样会关闭自启的命令），已按最后一条命令保持停止。',
      '',
      '确实要启动: mihomo start',
    ],
  });
}

/**
 * 确认服务真正跑起来了，否则抛出带日志尾部的 CliError。
 *
 * 崩溃循环下必须报错而非报成功：KeepAlive 会每隔约 10s 重新拉起坏内核，日志被刷爆，
 * 而用户拿到的是「已启动 (PID xxx)」。日志尾部直接附在错误里——那是用户唯一的线索
 * （TUN 的启动脚本本就 `tail -25`，服务路径此前什么都不给）。
 *
 * 导出供 cmdInstall 的重装恢复路径共用：那里同样 bootstrap 后就打印
 * 「已按原状态重新启动」，缺这道确认就是 v4.2.0 修过的「bootstrap 返回 0 ≠ 内核活着」
 * 的漏网分支。
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
      ...(health.crashed ? ['launchd 会每隔约 10 秒反复拉起它，请先修正配置或执行 mihomo stop。'] : []),
      ...(tail.length > 0 ? ['', '--- 日志尾部 ---', ...tail] : ['', `日志: ${PATHS.logFile}`]),
      '',
      '完整日志: mihomo logs 0',
    ],
  });
}
