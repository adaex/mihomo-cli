import { spawnSync } from 'node:child_process';

import { colors } from './colors.js';

/**
 * 系统代理（macOS 系统设置 → 网络 → 代理）的只读检测与提示。
 *
 * Mixed 不自动设置系统代理是产品边界，本模块只做「检测 + 告知」：让 start 结束时的
 * 提示变准——已指向 Mixed 端口就一句确认，指向别处或未设置才给出可粘贴的设置命令。
 *
 * 用 `scutil --proxy` 而非逐个 `networksetup -get*proxy`：<dictionary> 是**当前生效
 * 网络集**的聚合视图，一次调用拿到 HTTP/HTTPS/SOCKS 全部状态；networksetup 按服务
 * 持久配置（Wi-Fi 与有线的配置可以不同），逐个查既慢又要再判哪个服务是活跃的——
 * 而「现在流量走不走代理」的判据恰恰是当前生效集。
 *
 * 解析纯函数与 spawn 分离：spec 只测解析，不依赖本机代理状态。
 */

/** 一个启用中的代理条目（host + port） */
export interface ProxyDictEntry {
  host: string;
  port: number;
}

/** scutil --proxy 输出中本模块关心的三类代理；未启用/未解析出则缺省 */
export interface ScutilProxyView {
  http?: ProxyDictEntry;
  https?: ProxyDictEntry;
  socks?: ProxyDictEntry;
}

/**
 * 解析 scutil --proxy 的 `<dictionary>` 输出。纯函数。
 * 键行是两空格缩进的 `Key : Value`；数组元素行（四空格的 `0 : *.local`）与
 * `<dictionary>` 外壳不匹配该形态，天然排除。未启用（Enable ≠ 1）或 host/port
 * 不完整的条目按缺省处理——探测是提醒用的，不完整就不参与判定，不猜。
 */
export function parseScutilProxy(stdout: string): ScutilProxyView {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = line.match(/^ {2}([A-Za-z]+) : (.+)$/);
    if (m) values.set(m[1], m[2].trim());
  }
  const read = (prefix: 'HTTP' | 'HTTPS' | 'SOCKS'): ProxyDictEntry | undefined => {
    if (values.get(`${prefix}Enable`) !== '1') return undefined;
    const host = values.get(`${prefix}Proxy`);
    const port = Number.parseInt(values.get(`${prefix}Port`) ?? '', 10);
    if (!host || !Number.isFinite(port)) return undefined;
    return { host, port };
  };
  return { http: read('HTTP'), https: read('HTTPS'), socks: read('SOCKS') };
}

export interface SystemProxySummary {
  /** HTTP/HTTPS/SOCKS 任一启用且指向给定回环端口 */
  matched: boolean;
  /** 启用中的条目（去重后的 `host:port`），用于「指向别处」的提示 */
  active: string[];
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** 判定系统代理与 Mixed 端口的关系。纯函数 */
export function summarizeSystemProxy(view: ScutilProxyView, mixedPort: number): SystemProxySummary {
  const entries = [view.http, view.https, view.socks].filter((e): e is ProxyDictEntry => e !== undefined);
  return {
    matched: entries.some(e => isLoopbackHost(e.host) && e.port === mixedPort),
    active: [...new Set(entries.map(e => `${e.host}:${e.port}`))],
  };
}

/**
 * 检测当前生效的系统代理。scutil 不可用/超时/输出形态异常返回 null，
 * 调用方回退静态提示——检测失败不该丢掉「Mixed 需手动配代理」这个最大的日常摩擦提醒。
 */
export function detectSystemProxy(mixedPort: number): SystemProxySummary | null {
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 3_000 });
  } catch {
    return null;
  }
  if (r.error || r.status !== 0 || typeof r.stdout !== 'string' || !r.stdout.includes('<dictionary>')) return null;
  return summarizeSystemProxy(parseScutilProxy(r.stdout), mixedPort);
}

/**
 * start（mixed）成功后的系统代理提示：按检测结果分三档。
 * - 已指向 Mixed 端口：一句灰色确认，不再重复教学
 * - 指向别处/未设置：黄色提醒 + 可粘贴的 networksetup 命令（服务名让用户按实际替换）
 * - 检测不可用：原静态提示原样保留
 */
export function printSystemProxyHint(mixedPort: number): void {
  const summary = detectSystemProxy(mixedPort);
  if (summary === null) {
    console.log(colors.gray(`提示: Mixed 模式需在系统设置配置 HTTP/SOCKS 代理 127.0.0.1:${mixedPort}（TUN 模式无需）`));
    return;
  }
  if (summary.matched) {
    console.log(colors.gray(`系统代理已指向 127.0.0.1:${mixedPort}`));
    return;
  }
  const pointing = summary.active.length > 0 ? `，当前指向 ${summary.active.join('、')}` : '';
  console.log(colors.yellow(`提示: 系统代理未指向 127.0.0.1:${mixedPort}${pointing}；需要代理的应用请配置后使用（TUN 模式无需）`));
  console.log(colors.gray('  设置命令（把 Wi-Fi 换成实际网络服务，全部服务见 networksetup -listallnetworkservices）:'));
  console.log(colors.gray(`  networksetup -setwebproxy "Wi-Fi" 127.0.0.1 ${mixedPort}`));
  console.log(colors.gray(`  networksetup -setsocksfirewallproxy "Wi-Fi" 127.0.0.1 ${mixedPort}`));
}
