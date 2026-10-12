import fs from 'node:fs';

import { getServiceStatus } from './launchctl.js';
import { PATHS } from './paths.js';
import { lsofListenPids } from './proxy-probe.js';
import { getControllerEndpoint } from './settings.js';
import type { ServiceStatus } from './types.js';

/**
 * 热重载（PUT /configs）探测与结论，及 kickstart 顺便轮转的 oversized 判定。
 * restartService 留在 service.ts（它消费 startService 的自举链路，拆出去会成环）；
 * 本模块被 service.ts 单向引用。
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
  // 必须先确认 controller 端口上确实是我们托管的服务内核：端口被其他程序占用且对 PUT
  // 返回 2xx 时，CLI 会报「已启动」而内核仍跑旧配置。任何探测失败（含状态查询抛错）都
  // 按「热重载不可用」回退 kickstart——launchd 病态时恰恰最需要 kickstart 自愈
  const controller = new AbortController();
  try {
    // prefetched：调用方同一同步拍已查过的状态，免再发一次 launchctl print
    const status = prefetched ?? getServiceStatus({ withDisabled: false });
    if (!status.running || status.pid === null) return false;

    // 端口与 secret 取同一份 settings 快照（D10）；端口非法按「热重载不可用」回退
    const endpoint = getControllerEndpoint();
    if (endpoint.port === null) return false;
    const baseUrl = `http://127.0.0.1:${endpoint.port}`;
    // 配置了 controller_secret 时必须带 Bearer，否则内核返回 401 → 热重载恒失败回退重启
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (endpoint.secret) headers.Authorization = `Bearer ${endpoint.secret}`;
    // timer 起表在状态查询之后：abort 预算只覆盖 /version、lsof 与 PUT，不被慢 launchctl 分食
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
      const listenerPids = lsofListenPids(endpoint.port);
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
