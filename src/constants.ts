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

export const BASE_CONFIG: Record<string, unknown> = {
  'allow-lan': false,
  'external-controller': '127.0.0.1:9090',
  port: 7890,
  'socks-port': 7891,
  'log-level': 'warning',
  'geodata-mode': true,
  'geo-update-interval': 24,
  'geox-url': {
    geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip-lite.dat',
    geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite-lite.dat',
    mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country-lite.mmdb',
    asn: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb',
  },
};
