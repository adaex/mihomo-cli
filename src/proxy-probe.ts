import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProxyProbeResult } from './types.js';

const execFileAsync = promisify(execFile);

/** 探测目标：gstatic generate_204 是连通性检查的事实标准，经代理访问应返回 204 */
const PROBE_URL = 'https://www.gstatic.com/generate_204';

/** 2xx 都算通：204 是标准形态，部分节点/机场会在中间返回 200 */
export function isProbeSuccessStatus(code: number | null): boolean {
  return code !== null && code >= 200 && code < 300;
}

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
export async function probeProxyConnectivity(port: number, timeoutMs = 5000): Promise<ProxyProbeResult> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '-x',
        `http://127.0.0.1:${port}`,
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        '--connect-timeout',
        '3',
        '--max-time',
        String(Math.ceil(timeoutMs / 1000)),
        PROBE_URL,
      ],
      { timeout: timeoutMs + 2_000 },
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
