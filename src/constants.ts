import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** CLI 自身版本与包名（package.json 单一来源；http UA、version/update 命令共用） */
export const VERSION: string = pkg.version;
export const PKG_NAME: string = pkg.name;

export const AVAILABLE_MIRRORS = ['v6.gh-proxy.org', 'gh-proxy.org', 'hk.gh-proxy.org', 'cdn.gh-proxy.org'];

/** --mirror 不带值时的默认镜像（与 AVAILABLE_MIRRORS 首项一致） */
export const DEFAULT_MIRROR = 'https://v6.gh-proxy.org/';

export const UI_URLS: Record<string, string> = {
  zash: 'https://board.zash.run.place',
  dash: 'https://metacubex.github.io/metacubexd',
  yacd: 'https://yacd.metacubex.one',
};

/**
 * launchd 保活任务的 LaunchDaemon 标签（同时用作 /Library/LaunchDaemons/ 下的 plist 文件名）。
 * 可用 MIHOMO_CLI_DAEMON_LABEL 覆盖，供隔离测试使用一次性 label，避免碰生产 plist 文件名。
 *
 * 非法值在此静默回退到默认标签，另由 assertDaemonLabelSafe()（daemon.ts 的写操作入口）
 * 抛出可读错误——不能在模块顶层抛：constants 在 import 阶段求值，早于 index.ts 的
 * main().catch 注册，抛出会直接打印堆栈而绕过统一收口。
 */
export const DEFAULT_DAEMON_LABEL = 'com.mihomo-cli.daemon';

/**
 * 合法 label 字符集。必须校验：该值经 path.join 拼成 plist 路径后，是 daemon.ts 里
 * `sudo install -m 644 -o root -g wheel` 的写入目标与 `sudo rm -f` 的删除目标。
 * path.join 会折叠 `..`（`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`），
 * 未校验时可借此以 root 身份写入/删除任意路径，内容还部分可控 → 提权原语。
 * 同时该值也拼进 launchctl 的 SERVICE_TARGET（`system/<label>`）。
 */
export const DAEMON_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidDaemonLabel(label: string): boolean {
  return DAEMON_LABEL_RE.test(label) && !label.includes('..');
}

const RAW_DAEMON_LABEL = process.env.MIHOMO_CLI_DAEMON_LABEL;
/** 环境变量提供的原始 label（可能非法），供 daemon.ts 校验时报出用户实际传入的值。 */
export const RAW_DAEMON_LABEL_INPUT: string | undefined = RAW_DAEMON_LABEL;
export const LAUNCH_DAEMON_LABEL: string = RAW_DAEMON_LABEL && isValidDaemonLabel(RAW_DAEMON_LABEL) ? RAW_DAEMON_LABEL : DEFAULT_DAEMON_LABEL;

/**
 * external-controller 地址(系统强制,不受订阅/覆写影响)。
 * host 固定 127.0.0.1:loopback 必可达;控制面板 API 与热重载统一走此地址。
 */
export const CONTROLLER_PORT = 9090;
export const CONTROLLER_ADDR = `127.0.0.1:${CONTROLLER_PORT}`;
/** 控制面板 API 基址。config.ts 恒把 external-controller 覆盖为该地址，故调用方无需运行时解析 */
export const CONTROLLER_BASE_URL = `http://${CONTROLLER_ADDR}`;

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
  'mixed-port': 7890,
  'allow-lan': false,
  'external-controller': CONTROLLER_ADDR,
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

/** 非 GitHub 订阅默认更新间隔（小时） */
export const DEFAULT_UPDATE_INTERVAL_HOURS = 12;
/** GitHub 订阅默认更新间隔（小时，更新更频繁） */
export const DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB = 6;
/** 启动时自动更新订阅的默认超时（毫秒），超时后使用缓存配置 */
export const DEFAULT_AUTO_UPDATE_TIMEOUT = 10_000;
