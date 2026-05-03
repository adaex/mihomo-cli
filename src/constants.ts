export const DEFAULT_GITHUB_MIRROR = 'https://v6.gh-proxy.org/';

export const AVAILABLE_MIRRORS = ['gh-proxy.org', 'v6.gh-proxy.org', 'hk.gh-proxy.org', 'cdn.gh-proxy.org'];

export const UI_URLS: Record<string, string> = {
  zash: 'https://board.zash.run.place',
  dash: 'https://metacubex.github.io/metacubexd',
  yacd: 'https://yacd.metacubex.one',
};

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

export function getFreeSubscriptionSources(): Array<{ name: string; url: string }> {
  return [
    // 完整配置（ACL4SSR 29 组）
    { name: 'FreeSubsCheck', url: 'https://gh-proxy.org/raw.githubusercontent.com/kooker/FreeSubsCheck/main/mihomo.yaml' },
    { name: 'yahr601', url: 'https://gh-proxy.org/raw.githubusercontent.com/yahr601-prog/1/main/clash.yaml' },
    { name: 'Auto-Sync', url: 'https://gh-proxy.org/raw.githubusercontent.com/walke2019/Auto-Sync/main/clash/GG/clash.yaml' },
    { name: 'ssrsub', url: 'https://gh-proxy.org/raw.githubusercontent.com/ssrsub/ssr/master/clash.yaml' }, // OpenAi → Ai平台
    { name: 'shaoyouvip', url: 'https://gh-proxy.org/raw.githubusercontent.com/shaoyouvip/free/main/mihomo.yaml' },
    { name: 'dalazhi', url: 'https://gh-proxy.org/raw.githubusercontent.com/dalazhi/v2ray/main/data/mihomo.yaml' },
    { name: 'getnode', url: 'https://gh-proxy.org/raw.githubusercontent.com/limitless-d/getnode/main/clash.yaml' },
    // 完整配置（24 组）
    { name: 'freeSub', url: 'https://gh-proxy.org/raw.githubusercontent.com/Ruk1ng001/freeSub/main/clash.yaml' },
    // 完整配置（13 组）
    { name: 'PuddinCat', url: 'https://gh-proxy.org/raw.githubusercontent.com/PuddinCat/BestClash/refs/heads/main/proxies.yaml' },
    { name: 'cn-news', url: 'https://gh-proxy.org/raw.githubusercontent.com/hello-world-1989/cn-news/refs/heads/main/clash.yaml' },
    // 基础分组（10-11 组）
    { name: 'naidounode', url: 'https://gh-proxy.org/raw.githubusercontent.com/xiaoji235/airport-free/main/clash/naidounode.txt' },
    { name: 'v2rayshare', url: 'https://gh-proxy.org/raw.githubusercontent.com/xiaoji235/airport-free/main/clash/v2rayshare.txt' },
    // 简单配置（2 组）
    { name: 'proxypool', url: 'https://gh-proxy.org/raw.githubusercontent.com/snakem982/proxypool/main/source/clash-meta.yaml' },
    { name: 'chromego', url: 'https://gh-proxy.org/raw.githubusercontent.com/Misaka-blog/chromego_merge/main/sub/merged_proxies_new.yaml' },
    // 纯节点列表
    { name: 'awesome-vpn', url: 'https://gh-proxy.org/raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/clash.yaml' },
    { name: 'V2RayAggregator', url: 'https://gh-proxy.org/raw.githubusercontent.com/mahdibland/V2RayAggregator/master/Eternity.yml' },
    { name: 'Pawdroid', url: 'https://gh-proxy.org/raw.githubusercontent.com/Pawdroid/Free-servers/main/sub' },
    { name: 'ermaozi', url: 'https://gh-proxy.org/raw.githubusercontent.com/ermaozi/get_subscribe/main/subscribe/clash.yml' },
    { name: 'v2rayfree', url: 'https://gh-proxy.org/raw.githubusercontent.com/v2raynnodes/v2rayfree/main/nodes/clashmeta.yaml' },
    { name: 'yudou66', url: 'https://gh-proxy.org/raw.githubusercontent.com/Barabama/FreeNodes/main/nodes/yudou66.yaml' },
    { name: 'wenode', url: 'https://gh-proxy.org/raw.githubusercontent.com/Barabama/FreeNodes/main/nodes/wenode.yaml' },
    { name: 'dongtai-sub', url: 'https://gh-proxy.org/raw.githubusercontent.com/wenxig/dongtai-sub/refs/heads/main/data/sub.yaml' },
    { name: 'kasesm', url: 'https://gh-proxy.org/raw.githubusercontent.com/kasesm/Free-Config/refs/heads/main/all_raw.txt' },
    { name: 'Au1rxx', url: 'https://gh-proxy.org/raw.githubusercontent.com/Au1rxx/free-vpn-subscriptions/main/output/clash.yaml' },
    // 完整配置但需要完整版 GeoSite.dat（geosite-lite 不兼容, 22 组）
    { name: 'NoMoreWalls', url: 'https://gh-proxy.org/raw.githubusercontent.com/peasoft/NoMoreWalls/master/list.meta.yml' },
  ];
}

export const BENCH_CONFIG: Record<string, unknown> = {
  'mixed-port': 17890,
  'allow-lan': false,
  'external-controller': '127.0.0.1:19090',
  'log-level': 'error',
  'geodata-mode': true,
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
