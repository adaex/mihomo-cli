const path = require('path');
const fs = require('fs');
const os = require('os');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

const IS_PKG = typeof process.pkg !== 'undefined';

let PROJECT_ROOT;
if (IS_PKG) {
  PROJECT_ROOT = path.dirname(process.execPath);
} else {
  PROJECT_ROOT = path.join(__dirname, '..');
}

function getUserDataDir() {
  if (process.env.MIHOMO_CLI_DIR) {
    return process.env.MIHOMO_CLI_DIR;
  }
  return path.join(os.homedir(), '.mihomo-cli');
}

const USER_DATA_DIR = getUserDataDir();

const DIRS = {
  root: PROJECT_ROOT,
  core: path.join(USER_DATA_DIR, 'core'),
  subscriptions: path.join(USER_DATA_DIR, 'subscriptions'),
  logs: path.join(USER_DATA_DIR, 'logs'),
  data: path.join(USER_DATA_DIR, 'data'),
  runtime: path.join(USER_DATA_DIR, '.runtime'),
  overwrites: path.join(USER_DATA_DIR, 'overwrites'),
};

const PATHS = {
  root: DIRS.root,
  data: DIRS.data,
  userDataDir: USER_DATA_DIR,
  mihomoBinary: path.join(DIRS.core, 'mihomo'),
  settingsFile: path.join(USER_DATA_DIR, 'settings.json'),
  subscriptionsCacheFile: path.join(DIRS.subscriptions, 'cache.json'),
  configFile: path.join(DIRS.runtime, 'config.yaml'),
  logFile: path.join(DIRS.logs, 'mihomo.log'),
  pidFile: path.join(DIRS.runtime, 'pid'),
};

function ensureDirs() {
  Object.values(DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  });
}

function maskUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const tokenKeys = ['token', 'key', 'secret', 'pass', 'password', 'auth', 'access_token', 'api_key'];
    for (const key of tokenKeys) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    if (parsed.username) {
      parsed.username = '***';
    }
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    if (url.length > 30) {
      return url.slice(0, 15) + '...' + url.slice(-10);
    }
    return url;
  }
}

let _settingsCache = null;

function readSettings() {
  if (_settingsCache !== null) return _settingsCache;
  ensureDirs();
  if (fs.existsSync(PATHS.settingsFile)) {
    try {
      const content = fs.readFileSync(PATHS.settingsFile, 'utf8');
      _settingsCache = JSON.parse(content);
      return _settingsCache;
    } catch (e) {
      _settingsCache = {};
      return _settingsCache;
    }
  }
  _settingsCache = {};
  return _settingsCache;
}

function writeSettings(settings) {
  ensureDirs();
  const existing = readSettings();
  const merged = { ...existing, ...settings };
  fs.writeFileSync(PATHS.settingsFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
  _settingsCache = merged;
  return merged;
}

// GitHub 镜像配置
const DEFAULT_GITHUB_MIRROR = 'https://v6.gh-proxy.org/';
const AVAILABLE_MIRRORS = ['v6.gh-proxy.org', 'gh-proxy.org', 'hk.gh-proxy.org', 'cdn.gh-proxy.org', 'edgeone.gh-proxy.org'];

function getGitHubMirror() {
  const settings = readSettings();
  // 空字符串或 false 表示禁用镜像
  if (settings.github_mirror === '' || settings.github_mirror === false) {
    return null;
  }
  return settings.github_mirror || DEFAULT_GITHUB_MIRROR;
}

function setGitHubMirror(mirror) {
  // mirror 取值:
  // - 完整 URL: 'https://hk.gh-proxy.org/'
  // - 短域名: 'hk.gh-proxy.org'
  // - '' 或 false: 禁用镜像
  // - null 或 undefined: 恢复默认

  if (mirror === null || mirror === undefined) {
    const settings = readSettings();
    delete settings.github_mirror;
    writeSettings(settings);
    return DEFAULT_GITHUB_MIRROR;
  }

  if (mirror === '' || mirror === false) {
    writeSettings({ github_mirror: '' });
    return null;
  }

  let mirrorUrl = mirror;
  if (!mirrorUrl.startsWith('http')) {
    mirrorUrl = 'https://' + mirrorUrl;
  }
  if (!mirrorUrl.endsWith('/')) {
    mirrorUrl += '/';
  }

  writeSettings({ github_mirror: mirrorUrl });
  return mirrorUrl;
}

// 订阅缓存读写（动态数据：流量、用户名、更新时间等）
function readSubscriptionsCache() {
  ensureDirs();
  if (fs.existsSync(PATHS.subscriptionsCacheFile)) {
    try {
      const content = fs.readFileSync(PATHS.subscriptionsCacheFile, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function writeSubscriptionsCache(cache) {
  ensureDirs();
  fs.writeFileSync(PATHS.subscriptionsCacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function saveSubscriptionCache(subName, data) {
  const cache = readSubscriptionsCache();
  cache[subName] = { ...cache[subName], ...data };
  writeSubscriptionsCache(cache);
}

function getSubscriptions() {
  const settings = readSettings();
  return settings.subscriptions || [];
}

// 获取合并了缓存数据的订阅列表
function getSubscriptionsWithCache() {
  const subs = getSubscriptions();
  const cache = readSubscriptionsCache();
  return subs.map(s => ({
    ...s,
    ...(cache[s.name] || {}),
  }));
}

function addSubscription(url, name) {
  if (name === undefined) name = 'default';
  const settings = readSettings();
  const subs = settings.subscriptions || [];
  const existingIndex = subs.findIndex(s => s.name === name);
  if (existingIndex >= 0) {
    subs[existingIndex] = { name, url };
  } else {
    subs.push({ name, url });
  }
  writeSettings({ subscriptions: subs });
}

function setDefaultSubscription(name) {
  const settings = readSettings();
  const subs = settings.subscriptions || [];
  const idx = subs.findIndex(s => s.name === name);
  if (idx < 0) {
    return false;
  }
  if (idx === 0) {
    return true; // 已经是第一个
  }
  const [sub] = subs.splice(idx, 1);
  subs.unshift(sub);
  writeSettings({ subscriptions: subs });
  return true;
}

function getSubRawConfigPath(subName) {
  return path.join(DIRS.subscriptions, subName + '.yaml');
}

function saveSubRawConfig(subName, content) {
  ensureDirs();
  const filePath = getSubRawConfigPath(subName);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

function readSubRawConfig(subName) {
  const filePath = getSubRawConfigPath(subName);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function hasKernel() {
  return fs.existsSync(PATHS.mihomoBinary);
}

let _kernelVersionCache = undefined;

function getKernelVersion() {
  if (!hasKernel()) {
    _kernelVersionCache = undefined;
    return null;
  }
  if (_kernelVersionCache !== undefined) return _kernelVersionCache;
  try {
    const output = execSync('"' + PATHS.mihomoBinary + '" -v 2>&1 || true', {
      encoding: 'utf8',
    }).trim();
    if (output) {
      const match = output.match(/v?[\d]+\.[\d]+\.[\d]+/);
      _kernelVersionCache = match ? match[0] : output;
      return _kernelVersionCache;
    }
    _kernelVersionCache = 'unknown';
    return _kernelVersionCache;
  } catch (e) {
    _kernelVersionCache = 'unknown';
    return _kernelVersionCache;
  }
}

const TUN_CONFIG = {
  tun: {
    enable: true,
    stack: 'mixed',
    'dns-hijack': ['0.0.0.0:53'],
    'auto-route': true,
    'auto-detect-interface': true,
    'strict-route': true,
  },
  ipv6: false,
};

const BASE_CONFIG = {
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

function parseYamlOrJson(content, errorMsg) {
  if (!content || !content.trim()) {
    throw new Error((errorMsg || '内容') + '为空');
  }
  try {
    const result = yaml.load(content);
    if (result !== undefined) return result;
  } catch (e) {}
  try {
    return JSON.parse(content);
  } catch (e2) {
    throw new Error((errorMsg || '内容') + '格式错误，无法解析为 YAML 或 JSON');
  }
}

function buildConfig(subRawContent, mode) {
  const baseConfig = parseYamlOrJson(subRawContent, '订阅内容');

  if (!baseConfig) {
    throw new Error('订阅内容为空');
  }

  // 延迟加载以避免循环依赖
  const overwrite = require('./overwrite');

  // 应用覆写配置
  const withOverwrites = overwrite.applyOverwrites(baseConfig);

  // 合并 BASE_CONFIG（优先级高于覆写）
  const merged = { ...withOverwrites, ...BASE_CONFIG };

  if (mode === 'tun') {
    // 合并 TUN 配置
    merged.tun = TUN_CONFIG.tun;
    merged.ipv6 = TUN_CONFIG.ipv6;

    // 确保 DNS 配置与 TUN 模式兼容（保留订阅的 DNS 服务器）
    merged.dns = merged.dns || {};
    merged.dns.enable = true;
    merged.dns['enhanced-mode'] = 'fake-ip';
    merged.dns['fake-ip-range'] = merged.dns['fake-ip-range'] || '198.18.0.1/16';
  }

  return merged;
}

function writeMihomoConfig(configObj) {
  ensureDirs();
  const content = yaml.dump(configObj, {
    indent: 2,
    lineWidth: -1,
    noCompat: true,
  });
  fs.writeFileSync(PATHS.configFile, content, { mode: 0o600 });
}

function hasConfig() {
  return fs.existsSync(PATHS.configFile);
}

function getConfigInfo() {
  if (!hasConfig()) {
    return null;
  }

  try {
    const content = fs.readFileSync(PATHS.configFile, 'utf8');
    const cfg = yaml.load(content);

    if (!cfg) return null;

    return {
      proxies: cfg.proxies ? cfg.proxies.length : 0,
      proxyGroups: cfg['proxy-groups'] ? cfg['proxy-groups'].length : 0,
      mode: cfg.mode || 'rule',
      mixedPort: cfg['mixed-port'] || null,
      httpPort: cfg.port || null,
      socksPort: cfg['socks-port'] || null,
      tun: cfg.tun ? cfg.tun.enable : false,
    };
  } catch (e) {
    return null;
  }
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function resetUserData(options) {
  if (options === undefined) options = {};
  const keepKernel = options.keepKernel !== false;

  const itemsToRemove = [PATHS.settingsFile, DIRS.subscriptions, DIRS.logs, DIRS.data, DIRS.runtime];

  if (!keepKernel) {
    itemsToRemove.push(DIRS.core);
  }

  let removedCount = 0;
  for (const item of itemsToRemove) {
    if (fs.existsSync(item)) {
      try {
        rmrf(item);
        removedCount++;
      } catch (e) {
        console.warn('  警告: 无法删除 ' + item + ': ' + e.message);
      }
    }
  }

  ensureDirs();
  _settingsCache = null;
  return removedCount;
}

module.exports = {
  PATHS,
  DIRS,
  PROJECT_ROOT,
  USER_DATA_DIR,
  IS_PKG,
  ensureDirs,
  readSettings,
  writeSettings,
  readSubscriptionsCache,
  writeSubscriptionsCache,
  saveSubscriptionCache,
  maskUrl,
  getSubscriptions,
  getSubscriptionsWithCache,
  addSubscription,
  setDefaultSubscription,
  getSubRawConfigPath,
  saveSubRawConfig,
  readSubRawConfig,
  hasKernel,
  getKernelVersion,
  clearKernelVersionCache: () => {
    _kernelVersionCache = undefined;
  },
  getGitHubMirror,
  setGitHubMirror,
  DEFAULT_GITHUB_MIRROR,
  AVAILABLE_MIRRORS,
  TUN_CONFIG,
  BASE_CONFIG,
  parseYamlOrJson,
  buildConfig,
  writeMihomoConfig,
  hasConfig,
  getConfigInfo,
  resetUserData,
  rmrf,
};
