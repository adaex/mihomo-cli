import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** CLI 自身版本与包名（package.json 单一来源；http UA、version/update 命令共用） */
export const VERSION: string = pkg.version;
export const PKG_NAME: string = pkg.name;

/**
 * 镜像的**单一真相源**：短别名 → 完整地址。`--mirror <别名>` 经 `MIRROR_ALIASES` 展开，
 * 帮助文案里的「可用镜像」由 `AVAILABLE_MIRRORS` 从本表派生。
 *
 * 此前是三份各自维护的清单（`AVAILABLE_MIRRORS` 手写域名、`MIRROR_ALIASES` 手写别名、
 * `getDefaultMirror` 里硬编码裸域），增删镜像要改三处且无机制兜底：漏改
 * `AVAILABLE_MIRRORS` 只是帮助文案过期，漏改 `MIRROR_ALIASES` 则是别名直接不认。
 *
 * `bare` 是不带子域的裸域，供无 IPv6 时的默认选择（见 utils.ts 的 getDefaultMirror）；
 * 它不作为短别名（用户写 `--mirror gh-proxy.org` 走裸主机名补 https 的通路即可）。
 */
export const MIRROR_HOST = 'gh-proxy.org';

/** --mirror <短别名> 映射：cdn/v4/v6/axisnow → 完整镜像地址 */
export const MIRROR_ALIASES: Record<string, string> = {
  v4: `https://v4.${MIRROR_HOST}/`,
  v6: `https://v6.${MIRROR_HOST}/`,
  cdn: `https://cdn.${MIRROR_HOST}/`,
  axisnow: `https://axisnow.${MIRROR_HOST}/`,
};

/** 裸域镜像（无子域）：无全局 IPv6 时的默认选择 */
export const MIRROR_BARE = `https://${MIRROR_HOST}/`;

/**
 * 可用镜像的展示清单（帮助/错误提示用），从 MIRROR_ALIASES 派生。
 * 裸域排最前，与 getDefaultMirror 的回退顺序一致。
 */
export const AVAILABLE_MIRRORS: string[] = [MIRROR_HOST, ...Object.values(MIRROR_ALIASES).map(url => new URL(url).hostname)];

export const UI_URLS: Record<string, string> = {
  zash: 'https://board.zash.run.place',
  dash: 'https://metacubex.github.io/metacubexd',
  yacd: 'https://yacd.metacubex.one',
};

/**
 * launchd 服务的标签（同时用作 plist 文件名：用户级在 ~/Library/LaunchAgents/，
 * 系统级在 /Library/LaunchDaemons/）。
 * 可用 MIHOMO_CLI_DAEMON_LABEL 覆盖，供隔离测试使用一次性 label，避免碰生产 plist 文件名。
 *
 * 非法值在此静默回退到默认标签，另由 assertServiceLabelSafe()（service.ts 的写操作入口）
 * 抛出可读错误——不能在模块顶层抛：constants 在 import 阶段求值，早于 index.ts 的
 * main().catch 注册，抛出会直接打印堆栈而绕过统一收口。
 *
 * **值与环境变量名都保持 `daemon` 字样不变**（v4.1.0 只改常量名不改值）：改了值会让老用户
 * v4.0 及更早装的 /Library/LaunchDaemons/com.mihomo-cli.daemon.plist 变成新 CLI 看不见的幽灵，
 * 而它带 KeepAlive 会持续拉起内核，用户没有任何途径卸载它。保持不变则 detectInstalledDomain()
 * 天然识别出旧的系统级安装并可直接接管。
 */
export const DEFAULT_SERVICE_LABEL = 'com.mihomo-cli.daemon';

/**
 * 合法 label 字符集。必须校验：该值经 path.join 拼成 plist 路径后，是系统级安装时
 * `sudo install -m 644 -o root -g wheel` 的写入目标与 `sudo rm -f` 的删除目标。
 * path.join 会折叠 `..`（`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`），
 * 未校验时可借此以 root 身份写入/删除任意路径，内容还部分可控 → 提权原语。
 * 同时该值也拼进 launchctl 的服务目标（`gui/<uid>/<label>` 或 `system/<label>`）。
 */
export const SERVICE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidServiceLabel(label: string): boolean {
  return SERVICE_LABEL_RE.test(label) && !label.includes('..');
}

const RAW_SERVICE_LABEL = process.env.MIHOMO_CLI_DAEMON_LABEL;
/** 环境变量提供的原始 label（可能非法），供 service.ts 校验时报出用户实际传入的值。 */
export const RAW_SERVICE_LABEL_INPUT: string | undefined = RAW_SERVICE_LABEL;
export const SERVICE_LABEL: string = RAW_SERVICE_LABEL && isValidServiceLabel(RAW_SERVICE_LABEL) ? RAW_SERVICE_LABEL : DEFAULT_SERVICE_LABEL;

/** 服务二进制符号链名。见 paths.ts 的 serviceBinary 与 service.ts 的 ensureServiceSymlink。 */
export const SERVICE_BINARY_NAME = 'mihomo-cli-service';

/**
 * 默认混合端口（HTTP + SOCKS5）与 external-controller 端口。
 * 系统强制、不受订阅/覆写影响：端口是 UI 与热重载的统一依赖地址。
 * 可在 settings.json 的 `ports` 里覆盖（见 settings.ts 的 getPorts）——
 * 供默认端口被其他代理工具占用的场景逃生，不是给订阅/覆写的配置面。
 */
export const DEFAULT_MIXED_PORT = 7890;
export const CONTROLLER_PORT = 9090;

export const TUN_CONFIG = {
  tun: {
    enable: true,
    stack: 'mixed',
    'dns-hijack': ['any:53', 'tcp://any:53'],
    'auto-route': true,
    'auto-detect-interface': true,
    'strict-route': true,
  },
};

export const BASE_CONFIG: Record<string, unknown> = {
  // 注意：mixed-port 与 external-controller 不在此表——它们来自 settings.ports（getPorts），
  // config.ts 单独写入 systemConfig，订阅/覆写恒不可改
  'allow-lan': false,
  'unified-delay': true,
  'tcp-concurrent': true,
  'geo-auto-update': true,
  'geo-update-interval': 24,
  'geodata-mode': true,
  'log-level': 'warning',
  profile: {
    'store-selected': true,
  },
  'geox-url': {
    geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip-lite.dat',
    geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite-lite.dat',
    mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country-lite.mmdb',
    asn: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb',
  },
};

// === 订阅更新默认值 ===

/** 默认更新间隔（小时）。此前对 GitHub 订阅设过更短的 6h，但国内直连 GitHub 更难，
 * 更频繁地撞墙只产生失败噪音，故统一 12h */
export const DEFAULT_UPDATE_INTERVAL_HOURS = 12;
/** 启动时自动更新订阅的默认超时（毫秒），超时后使用缓存配置 */
export const DEFAULT_AUTO_UPDATE_TIMEOUT = 10_000;
