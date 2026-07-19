export const AVAILABLE_MIRRORS = ['gh-proxy.org', 'v6.gh-proxy.org', 'hk.gh-proxy.org', 'cdn.gh-proxy.org'];

export const UI_URLS: Record<string, string> = {
  zash: 'https://board.zash.run.place',
  dash: 'https://metacubex.github.io/metacubexd',
  yacd: 'https://yacd.metacubex.one',
};

/**
 * launchd 保活任务的 LaunchDaemon 标签（同时用作 /Library/LaunchDaemons/ 下的 plist 文件名）。
 * 可用 MIHOMO_CLI_DAEMON_LABEL 覆盖，供隔离测试使用一次性 label，避免碰生产 plist 文件名。
 */
export const LAUNCH_DAEMON_LABEL = process.env.MIHOMO_CLI_DAEMON_LABEL || 'com.mihomo-cli.daemon';

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

export const TEST_CONFIG: Record<string, unknown> = {
  'mixed-port': 27890,
  'allow-lan': false,
  'external-controller': '127.0.0.1:29090',
  'log-level': 'error',
  'geodata-mode': true,
};

export const BASE_CONFIG: Record<string, unknown> = {
  'mixed-port': 7890,
  'allow-lan': false,
  'external-controller': '127.0.0.1:9090',
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

// === 节点测速 / 清理默认值 ===

/** 测速默认超时（毫秒） */
export const DEFAULT_TEST_TIMEOUT = 2000;
/** 测速默认并发数 */
export const DEFAULT_TEST_CONCURRENCY = 100;
/** 测速使用的连通性探测 URL */
export const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
/** 自动清理默认测试轮次（失败节点重试轮数） */
export const DEFAULT_CLEAN_ROUNDS = 2;
/** 非 GitHub 订阅启动后自动清理阈值（节点数超过则测速清理） */
export const AUTO_CLEAN_THRESHOLD = 100;
/** GitHub 订阅启动后自动清理阈值 */
export const AUTO_CLEAN_THRESHOLD_GITHUB = 50;
