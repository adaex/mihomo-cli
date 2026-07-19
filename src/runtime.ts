import { getConfigInfo } from './config.js';
import { DAEMON_BOOT_WAIT_MS, getDaemonStatus, isDaemonEnabled, isDaemonRunning, restartDaemon } from './daemon.js';
import * as processManager from './process.js';
import { sleep } from './utils.js';

/**
 * 运行时门面：收敛「普通进程(pidFile) vs launchd 托管(保活)」双轨的差异。
 *
 * 保活开启后,内核由系统 LaunchDaemon 托管、不写 pidFile,启动/重启/状态查询都与普通模式不同。
 * 命令层若各自 `if (isDaemonEnabled())` 分支处理,极易重复与不一致(历史上 clean 两分支输出就已分叉)。
 * 本模块把这三类差异各收敛为一个函数,命令层只调门面、不再关心底层是哪种运行时。
 *
 * 依赖方向:runtime → config/daemon/process(单向,四者均不反向依赖 runtime,无循环)。
 */

export type RuntimeMode = 'mixed' | 'tun';

/**
 * 当前应使用的运行模式。保活恒为 Mixed(仅支持 Mixed);
 * 否则沿用运行时配置的 tun 字段——避免订阅/覆写残留 tun 字段时被误判。
 */
export function getRuntimeMode(): RuntimeMode {
  if (isDaemonEnabled()) return 'mixed';
  return getConfigInfo()?.tun ? 'tun' : 'mixed';
}

export interface RunningState {
  running: boolean;
  pid: number | null;
  /** 是否处于保活模式(内核由 launchd 托管) */
  daemon: boolean;
}

/**
 * 统一的运行状态。保活模式下内核不写 pidFile,以 daemon 状态为准;否则看普通进程状态。
 * 收敛 status.ts 原先的双源判断。
 */
export function getRunningState(): RunningState {
  if (isDaemonEnabled()) {
    const daemon = getDaemonStatus();
    return { running: isDaemonRunning(daemon), pid: daemon.pid, daemon: true };
  }
  const status = processManager.getStatus();
  return { running: status.running, pid: status.pid, daemon: false };
}

/**
 * 改动配置(切换订阅、覆写开关、清理节点)后是否需要重启内核使之生效。
 * 保活模式恒需(launchd 不写 pidFile,须显式感知);普通模式仅在运行中时需要。
 */
export function isRestartNeededOnChange(): boolean {
  return isDaemonEnabled() || processManager.getStatus().running;
}

/**
 * 启动内核,或(保活时)重启托管内核使新配置生效,返回 PID。
 * **不负责停止旧进程**——普通模式的 stop 由调用方按需先行处理(保留其 handleStopResult 残留检查)。
 *   保活 → restartDaemon()(优先热重载,失败回退 kickstart)+ 等待 launchd + 读 PID
 *   普通 → processManager.start(mode)
 */
export async function launchOrRestart(mode: RuntimeMode): Promise<number | null> {
  if (isDaemonEnabled()) {
    await restartDaemon();
    await sleep(DAEMON_BOOT_WAIT_MS);
    return getDaemonStatus().pid;
  }
  const result = await processManager.start(mode);
  return result.pid;
}
