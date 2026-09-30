import { spawnSync } from 'node:child_process';

import { colors } from './colors.js';

/**
 * 代理指向判定与系统代理（macOS 系统设置 → 网络 → 代理）的只读检测与提示。
 *
 * env 自代理判定（proxyEnvPointsAtSelf）与系统代理指向判定（entryMatches）共用
 * isLoopbackHost——本机语义两边一致，不各自维护清单，任何一边扩集都同时生效。
 *
 * Mixed 不自动设置系统代理是产品边界，本模块只做「检测 + 告知」：让 start 结束时的
 * 提示变准——已指向 Mixed 端口就一句确认，指向别处或未设置才给出可粘贴的设置命令。
 *
 * 用 `scutil --proxy` 而非逐个 `networksetup -get*proxy`：<dictionary> 是**当前生效
 * 网络集**的聚合视图，一次调用拿到 HTTP/HTTPS/SOCKS/PAC 全部状态；networksetup 按服务
 * 持久配置（Wi-Fi 与有线的配置可以不同），逐个查既慢又要再判哪个服务是活跃的——
 * 而「现在流量走不走代理」的判据恰恰是当前生效集。
 *
 * 解析纯函数与 spawn 分离：spec 只测解析，不依赖本机代理状态。
 */

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
 * 判定一个代理环境变量的值（http_proxy/https_proxy/all_proxy，大小写两种形式）
 * 是否指向**本机自己的 Mixed 端口**——这是唯一必须清除的形态：下载订阅/内核时
 * 流量经自己的代理，而重启过程中旧内核会先被停掉，形成下载死锁（见 docs/decisions.md D9）。
 *
 * 指向其他任何地址（企业网络的 env 代理、别的代理工具）都必须保留。
 * 接受的形态：`http://127.0.0.1:7890`、`socks5://localhost:7890`、无协议的裸
 * `127.0.0.1:7890` 与裸 `localhost:7890`（all_proxy 常见写法，补协议再解析——
 * `new URL('localhost:7890')` 不抛异常、把 localhost 当 scheme、hostname 为空串，
 * 不补协议恰好漏判，而 curl/gh 都认这个形态）。无端口或解析失败一律不判为自代理。
 */
export function proxyEnvPointsAtSelf(value: string, selfPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
    if (parsed.hostname === '') parsed = new URL(`http://${value}`);
  } catch {
    try {
      parsed = new URL(`http://${value}`);
    } catch {
      return false;
    }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!isLoopbackHost(host)) return false;
  return Number.parseInt(parsed.port, 10) === selfPort;
}

/** 一个启用中的代理条目（host + port） */
export interface ProxyDictEntry {
  host: string;
  port: number;
}

/** PAC / WPAD 接管状态；两者都未启用则为缺省 */
export interface ScutilPacInfo {
  /** PAC 脚本地址（URL 形态或 host:port 老形态），取不到则空串 */
  source: string;
  /** WPAD 自动发现（无固定脚本地址） */
  wpad: boolean;
}

/** scutil --proxy 输出中本模块关心的代理形态；未启用/未解析出则缺省 */
export interface ScutilProxyView {
  http?: ProxyDictEntry;
  https?: ProxyDictEntry;
  socks?: ProxyDictEntry;
  pac?: ScutilPacInfo;
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
  const readPac = (): ScutilPacInfo | undefined => {
    if (values.get('ProxyAutoConfigEnable') === '1') {
      const url = values.get('ProxyAutoConfigURLString') ?? '';
      const host = values.get('ProxyAutoConfigHost');
      const port = values.get('ProxyAutoConfigPort');
      const legacy = host ? `${host}${port ? `:${port}` : ''}` : '';
      return { source: url || legacy, wpad: false };
    }
    if (values.get('ProxyAutoDiscoveryEnable') === '1') {
      return { source: '', wpad: true };
    }
    return undefined;
  };
  return { http: read('HTTP'), https: read('HTTPS'), socks: read('SOCKS'), pac: readPac() };
}

export interface SystemProxySummary {
  /** HTTP/HTTPS/SOCKS 任一启用且指向给定回环端口 */
  matched: boolean;
  /** 启用中的条目（去重后的 `host:port`），用于「指向别处」的提示 */
  active: string[];
  /** 启用中但**未**指向 Mixed 端口的条目——matched 时它非空说明只配了一部分 */
  diverged: string[];
  /** PAC/WPAD 接管（此时三键通常未启用，流量走向由脚本内容决定，无法静态判定） */
  pac: ScutilPacInfo | null;
}

const entryMatches = (e: ProxyDictEntry, mixedPort: number): boolean => isLoopbackHost(e.host) && e.port === mixedPort;

/** 判定系统代理与 Mixed 端口的关系。纯函数 */
export function summarizeSystemProxy(view: ScutilProxyView, mixedPort: number): SystemProxySummary {
  const entries = [view.http, view.https, view.socks].filter((e): e is ProxyDictEntry => e !== undefined);
  return {
    matched: entries.some(e => entryMatches(e, mixedPort)),
    active: [...new Set(entries.map(e => `${e.host}:${e.port}`))],
    diverged: [...new Set(entries.filter(e => !entryMatches(e, mixedPort)).map(e => `${e.host}:${e.port}`))],
    pac: view.pac ?? null,
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
 * start（mixed）成功后的系统代理提示：按检测结果分档。
 * - PAC/WPAD 接管：说明接管状态，**不给设置命令**——照敲手动代理命令会把本来可用的
 *   PAC 配置覆盖掉（脚本可能正把流量分给 mihomo），改不改是用户的决定
 * - 已指向 Mixed 端口：一句灰色确认；仍有其他条目指向别处时升级为黄色（部分流量不走 mihomo）
 * - 指向别处/未设置：黄色提醒 + 可粘贴的 networksetup 命令（服务名让用户按实际替换）
 * - 检测不可用：原静态提示原样保留
 */
export function printSystemProxyHint(mixedPort: number): void {
  const summary = detectSystemProxy(mixedPort);
  if (summary === null) {
    console.log(colors.gray(`提示: Mixed 模式需在系统设置配置 HTTP/SOCKS 代理 127.0.0.1:${mixedPort}（TUN 模式无需）`));
    return;
  }
  if (summary.pac) {
    const desc = summary.pac.wpad ? 'WPAD 自动发现' : `PAC 文件${summary.pac.source ? `（${summary.pac.source}）` : ''}`;
    console.log(colors.gray(`系统代理由 ${desc} 接管，是否走 mihomo 由脚本决定；如需固定全量走代理，可在系统设置改用手动代理 127.0.0.1:${mixedPort}`));
    return;
  }
  if (summary.matched) {
    if (summary.diverged.length > 0) {
      console.log(colors.yellow(`提示: 部分系统代理已指向 127.0.0.1:${mixedPort}，但 ${summary.diverged.join('、')} 仍指向别处——对应流量可能不经 mihomo`));
    } else {
      console.log(colors.gray(`系统代理已指向 127.0.0.1:${mixedPort}`));
    }
    return;
  }
  const pointing = summary.active.length > 0 ? `，当前指向 ${summary.active.join('、')}` : '';
  console.log(colors.yellow(`提示: 系统代理未指向 127.0.0.1:${mixedPort}${pointing}；需要代理的应用请配置后使用（TUN 模式无需）`));
  console.log(colors.gray('  设置命令（把 Wi-Fi 换成实际网络服务，全部服务见 networksetup -listallnetworkservices）:'));
  console.log(colors.gray(`  networksetup -setwebproxy "Wi-Fi" 127.0.0.1 ${mixedPort}`));
  console.log(colors.gray(`  networksetup -setsecurewebproxy "Wi-Fi" 127.0.0.1 ${mixedPort}`));
  console.log(colors.gray(`  networksetup -setsocksfirewallproxy "Wi-Fi" 127.0.0.1 ${mixedPort}`));
}
