import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

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
    return r.stdout
      .split('\n')
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
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
 * 探测结果的短缓存（按端口）。排查时用户会连敲 status/doctor，代理不通时每次
 * 固定等满 2s——代理状态在几秒内不可能翻转（切节点+节点重连本身远超这个时长），
 * 第二次探测纯属白等。TTL 刻意短：只覆盖「连续查看」这个真实节奏，不牺牲
 * 三态灯的时效性；--no-probe 不经过本函数、不受影响。
 */
const PROBE_CACHE_TTL_MS = 3_000;
let probeCache: { port: number; at: number; result: ProxyProbeResult } | null = null;

/**
 * 经本机混合端口发一次真实请求，确认「进程在跑」之外「代理真的通」。
 *
 * 这是 status/start 的独立确认层：进程活着而节点已死、订阅过期、流量用尽时，
 * 内核照样绿点运行，用户要自己开网页才发现断网。探测把这类失效变成可见的黄灯。
 *
 * 用 curl 而非 Node 原生 http：Node 不支持 HTTP 代理（CONNECT），引第三方依赖
 * 又不值当——内核下载本就依赖 curl。探测失败不抛错，返回 ok=false + 原因，
 * 由调用方决定如何展示（status 黄灯 / start 提示）。
 */
export async function probeProxyConnectivity(port: number): Promise<ProxyProbeResult> {
  if (probeCache && probeCache.port === port && Date.now() - probeCache.at < PROBE_CACHE_TTL_MS) {
    return probeCache.result;
  }
  const result = await probeProxyConnectivityUncached(port);
  probeCache = { port, at: Date.now(), result };
  return result;
}

async function probeProxyConnectivityUncached(port: number): Promise<ProxyProbeResult> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-x', `http://127.0.0.1:${port}`, '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', String(Math.ceil(PROBE_TIMEOUT_MS / 1000)), PROBE_URL],
      { timeout: PROBE_TIMEOUT_MS + 2_000 },
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
    const stderr = err.stderr?.toString().trim();
    // curl 的错误行形如「curl: (7) Failed to connect to ...」，剥掉前缀更可读
    const lastLine = stderr ? stderr.split('\n').pop() : undefined;
    const detail = lastLine ? lastLine.replace(/^curl: \(\d+\)\s*/, '') : (err.message ?? '请求失败');
    return { ok: false, statusCode: null, error: detail, durationMs: Date.now() - start };
  }
}
