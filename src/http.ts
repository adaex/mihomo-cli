import { VERSION } from './constants.js';
import type { HttpClient, HttpClientOptions, HttpResponse } from './types.js';
import { formatBytes } from './utils.js';

/** HTTP 响应体大小上限（50MB）：订阅/内核产物远小于此，超限视为异常（劫持/故障）并中止，防 OOM。 */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
/**
 * 错误响应体只读取用于诊断的前缀（64KB）。错误体不参与业务解析，
 * 无需完整读入——此前 !ok 分支直接 await response.json() 完全绕过大小上限，
 * 服务端返回超大错误体即可撑爆内存（实测 60MB 错误体使 RSS 增长 300MB+）。
 */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/**
 * URL 是否为 https 协议。降级重定向守卫的判据，**必须用 URL 解析而非
 * `startsWith('https://')`**：URL 解析会把 scheme 规范化为小写——`HTTPS://…`
 * 照常 fetch 却绕过 startsWith 判定，整条 https→http 降级检查被跳过。
 * 非法 URL 返回 false（与旧 startsWith 行为一致，fetch 自会报错）。
 */
export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 构造带响应载荷的 HTTP 错误。直连 fetch 与代理 curl（GitHub API 版本查询）两条
 * 路径共用同一形态：message 为 `HTTP <status>`，`response.data` 为限量摘录后
 * 尽力解析的错误体——命令层据此提取「原因/文档」（GitHub 错误体的 message /
 * documentation_url 字段），保证两条路径的诊断等价。
 */
export function createHttpError(status: number, bodyText: string): Error & { response: { status: number; data?: Record<string, unknown> } } {
  const error = new Error(`HTTP ${status}`) as Error & { response: { status: number; data?: Record<string, unknown> } };
  error.response = { status };
  try {
    // 限量摘录：错误体不参与业务解析，只做诊断。curl 路径的 body 已整体读入内存，
    // 统一在这里截断（fetch 路径读取时已限量，截两次无副作用）
    error.response.data = JSON.parse(bodyText.slice(0, MAX_ERROR_BODY_BYTES)) as Record<string, unknown>;
  } catch {
    // 错误体读取/解析失败无所谓：status 已足够定位问题
  }
  return error;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const { timeout = 60_000 } = options;

  return {
    async get<T = string>(url: string, config?: { responseType?: 'text' | 'json'; signal?: AbortSignal }): Promise<HttpResponse<T>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const signal = config?.signal ? AbortSignal.any([controller.signal, config.signal]) : controller.signal;
      try {
        const response = await fetch(url, {
          signal,
          headers: { 'User-Agent': `mihomo-cli/${VERSION}` },
        });
        // 防 https→http 降级重定向：fetch 默认静默跟随协议降级，
        // 订阅配置等敏感内容明文传输可被 MITM 替换。内核下载走 curl --proto =https 有同等防线。
        if (isHttpsUrl(url) && !isHttpsUrl(response.url)) {
          throw new Error(`请求被重定向到非 https 地址（${response.url}），已拒绝`);
        }
        if (!response.ok) {
          let text = '';
          try {
            // 限量读取错误体：读满 64KB 即 abort，不把整个 body 拉进内存
            text = await readBodyWithLimit(response, controller, MAX_ERROR_BODY_BYTES);
          } catch {
            // 错误体读取失败无所谓：status 已足够定位问题
          }
          throw createHttpError(response.status, text);
        }
        // 提前拒绝声明超大的响应，避免把 GB 级 body 读进内存（订阅/内核下载被劫持或故障时的 OOM 防护）
        const declaredLen = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
          throw new Error(`响应体过大（${formatBytes(declaredLen)}，上限 ${formatBytes(MAX_RESPONSE_BYTES)}）`);
        }
        const text = await readBodyWithLimit(response, controller, MAX_RESPONSE_BYTES);
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
 * 累计超过 limit 也立即 abort 中止，避免边读边膨胀撑爆内存。
 * 成功路径用 MAX_RESPONSE_BYTES，错误路径用更小的 MAX_ERROR_BODY_BYTES。
 */
async function readBodyWithLimit(response: Response, controller: AbortController, limit: number): Promise<string> {
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
        if (total > limit) {
          controller.abort();
          throw new Error(`响应体超过大小上限（${formatBytes(limit)}）`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
