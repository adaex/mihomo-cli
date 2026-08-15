import { VERSION } from './constants.js';
import type { HttpClient, HttpClientOptions, HttpResponse } from './types.js';
import { formatBytes } from './utils.js';

/** HTTP 响应体大小上限（50MB）：订阅/内核产物远小于此，超限视为异常（劫持/故障）并中止，防 OOM。 */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const { timeout = 60_000, secret } = options;
  // 访问带鉴权的 external-controller 时附带 Bearer token；secret 为空则退化为无鉴权（订阅下载等外部 HTTP 不受影响）
  const authHeaders: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};

  return {
    async get<T = string>(url: string, config?: { responseType?: 'text' | 'json'; signal?: AbortSignal }): Promise<HttpResponse<T>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const signal = config?.signal ? AbortSignal.any([controller.signal, config.signal]) : controller.signal;
      try {
        const response = await fetch(url, {
          signal,
          headers: { 'User-Agent': `mihomo-cli/${VERSION}`, ...authHeaders },
        });
        if (!response.ok) {
          const error: Error & { response?: { status: number; data?: Record<string, unknown> } } = new Error(`HTTP ${response.status}`);
          error.response = { status: response.status };
          try {
            error.response.data = (await response.json()) as Record<string, unknown>;
          } catch {
            // ignore json parse errors
          }
          throw error;
        }
        // 提前拒绝声明超大的响应，避免把 GB 级 body 读进内存（订阅/内核下载被劫持或故障时的 OOM 防护）
        const declaredLen = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
          throw new Error(`响应体过大（${formatBytes(declaredLen)}，上限 ${formatBytes(MAX_RESPONSE_BYTES)}）`);
        }
        const text = await readBodyWithLimit(response, controller);
        const data = config?.responseType === 'json' ? JSON.parse(text) : text;
        return { data: data as T, headers: response.headers, status: response.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 流式读取响应体并强制大小上限：即使服务端不声明 Content-Length（分块传输），
 * 累计超过 MAX_RESPONSE_BYTES 也立即 abort 中止，避免边读边膨胀撑爆内存。
 */
async function readBodyWithLimit(response: Response, controller: AbortController): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new Error(`响应体超过大小上限（${formatBytes(MAX_RESPONSE_BYTES)}）`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
