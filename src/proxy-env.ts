/**
 * 进程 env 的自指代理判定与入口清理（docs/decisions.md D9）。
 *
 * 只有指向本机 Mixed 端口的代理会在入口清除，避免内核将停或未跑时经死端口出网；
 * 企业网络或其他工具的代理必须保留。这里不读取 macOS 系统代理。
 */

const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const;

/** 回环/本机主机名判定，忽略大小写；0.0.0.0 与 :: 的 connect 也会路由到本机监听器。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::';
}

/**
 * 解析代理 env 值为 host/port。裸 `localhost:7890` 要补协议重解析，否则 URL 会把
 * localhost 当 scheme。http/https 未写端口或显式写协议默认端口时都按 80/443；
 * WHATWG URL 会把显式默认端口归一为空串，不能只读 parsed.port。其他协议不猜默认端口。
 */
export function parseProxyEndpoint(value: string): { host: string; port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
    if (parsed.hostname === '') parsed = new URL(`http://${value}`);
  } catch {
    try {
      parsed = new URL(`http://${value}`);
    } catch {
      return null;
    }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const defaultPort = parsed.protocol === 'http:' ? 80 : parsed.protocol === 'https:' ? 443 : null;
  const port = parsed.port === '' ? defaultPort : Number.parseInt(parsed.port, 10);
  if (!host || port === null || !Number.isInteger(port)) return null;
  return { host, port };
}

/** 只认回环/本机地址加当前 Mixed 端口；其他代理一律保留。 */
export function proxyEnvPointsAtSelf(value: string, selfPort: number): boolean {
  const endpoint = parseProxyEndpoint(value);
  if (!endpoint) return false;
  return isLoopbackHost(endpoint.host) && endpoint.port === selfPort;
}

/**
 * 从 source 删除全部自指代理键并返回原值。生产入口刻意传 process.env：进程内 fetch
 * 在 NODE_USE_ENV_PROXY=1 时也必须受到同一防护；测试传独立对象，不碰真实环境。
 */
export function clearSelfProxyEnv(source: NodeJS.ProcessEnv, selfPort: number): Record<string, string> {
  const cleared: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = source[key];
    if (value && proxyEnvPointsAtSelf(value, selfPort)) {
      cleared[key] = value;
      delete source[key];
    }
  }
  return cleared;
}

/** 入口清除的原值只登记、不自动恢复；npm 是否恢复由每次 spawn 前的端口探活决定。 */
let clearedSelfProxyEnv: Record<string, string> | null = null;

export function recordClearedProxyEnv(cleared: Record<string, string> | null): void {
  clearedSelfProxyEnv = cleared === null ? null : { ...cleared };
}

export function getClearedProxyEnv(): Record<string, string> | null {
  return clearedSelfProxyEnv === null ? null : { ...clearedSelfProxyEnv };
}
