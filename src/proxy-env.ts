/**
 * 出网子进程的代理 env 自指处理（docs/decisions.md D9）。
 *
 * 自己 Mixed 端口的代理 env 在内核将停/未跑时指向死端口，出网子进程不得继承；
 * 指向其他地址的 env 代理（企业网络、别的代理工具）必须保留。
 * 一律 per-spawn、不写 process.env：新增会读 env 代理的出网子进程（gh/npm 类）必须经
 * stripSelfProxyEnv 构造 env，不得直接继承 process.env。
 */
import fs from 'node:fs';
import { DEFAULT_MIXED_PORT, isValidPortNumber } from './constants.js';
import { PATHS } from './paths.js';

const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const;

/**
 * 回环/本机主机名判定，忽略大小写：127.0.0.1、localhost、::1，
 * 以及未指定地址族写法 0.0.0.0 与 ::——macOS 上 connect 到它们会路由到
 * 本机监听器（0.0.0.0 实测 TCP connect 成功），curl 同样认这些代理形态。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::';
}

/**
 * 解析代理 env 值为 host/port。接受 `http://127.0.0.1:7890`、`socks5://localhost:7890`、
 * 无协议的裸 `127.0.0.1:7890` 与裸 `localhost:7890`（all_proxy 常见写法，补协议再解析——
 * `new URL('localhost:7890')` 不抛异常、把 localhost 当 scheme、hostname 为空串，
 * 不补协议恰好漏判，而 curl/gh/npm 都认这个形态）。无端口或解析失败返回 null。
 * IPv6 字面量剥掉 URL 的方括号（`[::1]` → `::1`）。
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
  const port = Number.parseInt(parsed.port, 10);
  if (!host || !Number.isInteger(port)) return null;
  return { host, port };
}

/**
 * 判定一个代理环境变量的值（http_proxy/https_proxy/all_proxy，大小写两种形式）
 * 是否指向**本机自己的 Mixed 端口**——这是唯一必须清除的形态：下载订阅/内核时
 * 流量经自己的代理，而重启过程中旧内核会先被停掉，形成下载死锁（见 docs/decisions.md D9）。
 *
 * 指向其他任何地址（企业网络的 env 代理、别的代理工具）都必须保留。
 */
export function proxyEnvPointsAtSelf(value: string, selfPort: number): boolean {
  const endpoint = parseProxyEndpoint(value);
  if (!endpoint) return false;
  return isLoopbackHost(endpoint.host) && endpoint.port === selfPort;
}

/**
 * 本机 Mixed 端口：直接读 settings.json 原始 JSON，无副作用（不备份损坏文件、不告警），
 * 绝不抛错，任何异常回退默认端口。它只服务「env 代理是否指向自己」这一个判断，
 * 不该因 settings 损坏、或 ports 另一侧非法（getPorts 会整体拒绝）而失效。
 */
function selfMixedPort(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.settingsFile, 'utf8')) as { ports?: { mixed?: unknown } } | null;
    const mixed = raw?.ports?.mixed;
    // 端口谓词与 settings 校验、--proxy 归一同源（isValidPortNumber）
    if (isValidPortNumber(mixed)) return mixed;
  } catch {
    // 文件不存在/损坏/非对象：用默认端口
  }
  return DEFAULT_MIXED_PORT;
}

/**
 * 子进程 env 副本：去掉指向本机 Mixed 端口的代理键，其余原样保留，不改 source。
 * removed 返回被去掉的键值，供「端口仍在监听就该保留用户原配置」的消费方（npm）探活。
 * selfPort 缺省读 settings；测试可显式传入免读盘。
 */
export function stripSelfProxyEnv(
  source: NodeJS.ProcessEnv = process.env,
  selfPort: number = selfMixedPort(),
): { env: NodeJS.ProcessEnv; removed: Record<string, string> } {
  const env = { ...source };
  const removed: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (value && proxyEnvPointsAtSelf(value, selfPort)) {
      removed[key] = value;
      delete env[key];
    }
  }
  return { env, removed };
}
