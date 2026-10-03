import fs from 'node:fs';

import { getServiceStatus } from './launchctl.js';
import { PATHS } from './paths.js';
import { lsofListenPids } from './proxy-probe.js';
import { getPorts, readSettings } from './settings.js';
import { shouldAbortStartOnDisable } from './stop-epoch.js';
import type { ServiceStatus } from './types.js';

/**
 * 热重载（PUT /configs）探测与结论，及 kickstart 顺便轮转的 oversized 判定。
 * restartService 留在 service.ts（它消费 startService 的自举链路，拆出去会成环）；
 * 本模块被 service.ts 单向引用。既有消费方经 service.ts 的 re-export 取用。
 */

/** 热重载（PUT /configs）超时 */
const HOT_RELOAD_TIMEOUT_MS = 5000;

/** 日志超过该大小时，restartService 借 kickstart 顺便 copy-truncate（startService 走 rotateAndCleanupLogs 无条件轮转） */
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;

export function logOversized(): boolean {
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
export async function tryHotReload(prefetched?: ServiceStatus): Promise<boolean> {
  // 先确认 controller 端口上确实是我们托管的服务内核，再把配置变更托付给它。
  // 只看「服务已装」+ PUT 返回 2xx 是不够的：该端口被其他服务占用（另一个 Clash、
  // 开发服务器）且对该 PUT 返回 2xx 时，CLI 会打印「已启动」而服务内核仍跑旧配置——
  // 配置变更静默未生效，是最难排查的一类失败。
  const controller = new AbortController();
  try {
    // 状态查询同样可能抛错（launchctl 超时/112/125、settings 端口非法）：探测类失败
    // 必须按「热重载不可用」处理并回退 kickstart，不能让一次读状态失败直接废掉整个
    // restartService——launchd 病态时恰恰最需要 kickstart 自愈。契约见函数头注释。
    // 调用方（restartService←launchOrRestart）在同一同步拍已查过完整状态时经
    // prefetched 透传，免再发一次 launchctl print；缺省自查保留直接调用与测试路径。
    // withDisabled:false——热重载只消费 running/pid，print-disabled 是白多一次的阻塞
    // 查询；abort 预算也不该被它分食（见下方 timer 起表位置的注释）
    const status = prefetched ?? getServiceStatus({ withDisabled: false });
    if (!status.running || status.pid === null) return false;

    // 端口经 settings.ports 解析（默认 9090），与 buildConfig 写进配置的值同源；
    // 只读一次，下面的 PUT 与 lsof 核对同一端口（两次读之间 settings 变更会自相矛盾）
    const { controller: controllerPort } = getPorts();
    const baseUrl = `http://127.0.0.1:${controllerPort}`;
    // 配置了 controller_secret 时必须带 Bearer，否则内核返回 401 → 热重载恒失败回退重启。
    // 只接受字符串：非字符串在 buildConfig 已 fail-closed（start 链路先构建配置），
    // 这里是纵深防御，别把数字/对象拼进 Authorization
    const secret = readSettings().controller_secret;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (typeof secret === 'string' && secret) headers.Authorization = `Bearer ${secret}`;
    // timer 起表在状态查询之后、第一个 fetch 之前：abort 预算覆盖 /version 探测、
    // lsof（自带 5s 超时的同步调用，夹在两个 fetch 之间）与 PUT，唯独不被前置的
    // launchctl 查询分食——launchctl 病态慢（print 各 2-3s）时 timer 在 fetch 前已
    // 到点会令热重载恒不可用，每次 restart 都退化为完整重启（代理瞬断）
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
      const listenerPids = lsofListenPids(controllerPort);
      if (listenerPids === null || listenerPids[0] !== status.pid) return false;

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
