import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import { buildCurlSpawnEnv } from './curl-spawn.js';
import { parsePidList } from './process-probe.js';
import { lastCurlErrorLine } from './text.js';
import type { ProxyProbeResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * lsof 查端口监听 pid（doctor 端口检查 / 热重载身份核对共用）：flags、超时与
 * 「查不到按无监听处理」的口径单点维护。返回 null 表示 lsof 本身不可用/调用失败
 * （探测失败 ≠ 端口没人听）；空数组 = 调用成立但无人监听。
 */
export function lsofListenPids(port: number): number[] | null {
  try {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return null;
    return parsePidList(r.stdout);
  } catch {
    return null;
  }
}

/** 探测目标：gstatic generate_204 是连通性检查的事实标准，经代理访问应返回 204 */
const PROBE_URL = 'https://www.gstatic.com/generate_204';

/** 2xx 都算通：204 是标准形态，部分节点/机场会在中间返回 200 */
export function isProbeSuccessStatus(code: number | null): boolean {
  return code !== null && code >= 200 && code < 300;
}

/** 探测超时：status 是高频命令，代理不通时不该干等；2s 对 generate_204 经代理足够 */
const PROBE_TIMEOUT_MS = 2000;

/**
 * 经本机混合端口发一次真实请求，确认「进程在跑」之外「代理真的通」。
 *
 * 这是 status/start 的独立确认层：进程活着而节点已死、订阅过期、流量用尽时，
 * 内核照样绿点运行，用户要自己开网页才发现断网。探测把这类失效变成可见的黄灯。
 *
 * 用 curl 而非 Node 原生 http：Node 不支持 HTTP 代理（CONNECT），引第三方依赖
 * 又不值当——内核下载本就依赖 curl。探测失败不抛错，返回 ok=false + 原因，
 * 由调用方决定如何展示（status 黄灯 / start 提示）。
 *
 * 不做进程内缓存：CLI 是单命令短进程，status 与 doctor 从不在同一进程同时发生，
 * 缓存没有第二个读端（与 settings 不缓存同一前提，见 D10）；--no-probe 在调用方跳过。
 */
export async function probeProxyConnectivity(port: number): Promise<ProxyProbeResult> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-x', `http://127.0.0.1:${port}`, '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(Math.ceil(PROBE_TIMEOUT_MS / 1000)), PROBE_URL],
      {
        timeout: PROBE_TIMEOUT_MS + 2_000,
        // 例外表会绕过显式 -x、让探测考成直连（绿灯作废），置空兜住统一走 curl-spawn.ts 出口
        env: buildCurlSpawnEnv(),
      },
    );
    const code = Number.parseInt(stdout.trim(), 10);
    const statusCode = Number.isFinite(code) ? code : null;
    const ok = isProbeSuccessStatus(statusCode);
    return {
      ok,
      statusCode,
      error: ok ? null : `HTTP ${statusCode ?? '无响应'}`,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    const err = e as { message?: string; stderr?: string | Buffer };
    const detail = lastCurlErrorLine(err.stderr) ?? err.message ?? '请求失败';
    return { ok: false, statusCode: null, error: detail, durationMs: Date.now() - start };
  }
}
