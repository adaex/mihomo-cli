// 内置模块
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// 第三方模块
const yaml = require('js-yaml');

// 本地模块
// （无额外本地模块，overwrite.js 在 buildConfig 中延迟加载以避免循环依赖）

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
  kernel: path.join(USER_DATA_DIR, 'kernel'),
  subscriptions: path.join(USER_DATA_DIR, 'subscriptions'),
  logs: path.join(USER_DATA_DIR, 'logs'),
  data: path.join(USER_DATA_DIR, 'data'),
  runtime: path.join(USER_DATA_DIR, 'runtime'),
};

const PATHS = {
  root: DIRS.root,
  mihomoBinary: path.join(DIRS.kernel, 'mihomo'),
  settingsFile: path.join(USER_DATA_DIR, 'settings.json'),
  subscriptionsCacheFile: path.join(DIRS.subscriptions, 'cache.json'),
  configFile: path.join(DIRS.runtime, 'config.yaml'),
  logFile: path.join(DIRS.logs, 'mihomo.log'),
  pidFile: path.join(DIRS.runtime, 'pid'),
  configStage1Subscription: path.join(DIRS.runtime, '1.subscription.yaml'),
  configStage2Overwrite: path.join(DIRS.runtime, '2.overwrite.yaml'),
  configStage3System: path.join(DIRS.runtime, '3.system.yaml'),
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

let settingsCache = null;

function readSettings() {
  if (settingsCache !== null) return settingsCache;
  ensureDirs();
  if (fs.existsSync(PATHS.settingsFile)) {
    try {
      const content = fs.readFileSync(PATHS.settingsFile, 'utf8');
      settingsCache = JSON.parse(content);
      return settingsCache;
    } catch (_e) {
      console.warn('警告: settings.json 格式损坏，使用默认设置（原文件已保留）');
      settingsCache = {};
      return settingsCache;
    }
  }
  settingsCache = {};
  return settingsCache;
}

function writeSettings(settings) {
  ensureDirs();
  const existing = readSettings();
  const merged = { ...existing, ...settings };
  // undefined 值表示删除该键
  for (const key of Object.keys(settings)) {
    if (settings[key] === undefined) delete merged[key];
  }
  fs.writeFileSync(PATHS.settingsFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
  settingsCache = merged;
  return merged;
}

// GitHub 镜像配置
const DEFAULT_GITHUB_MIRROR = 'https://v6.gh-proxy.org/';
const AVAILABLE_MIRRORS = ['gh-proxy.org', 'v6.gh-proxy.org', 'hk.gh-proxy.org', 'cdn.gh-proxy.org'];

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
    writeSettings({ github_mirror: undefined });
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
function readSubscriptionCache() {
  ensureDirs();
  if (fs.existsSync(PATHS.subscriptionsCacheFile)) {
    try {
      const content = fs.readFileSync(PATHS.subscriptionsCacheFile, 'utf8');
      return JSON.parse(content);
    } catch (_e) {
      return {};
    }
  }
  return {};
}

function writeSubscriptionCache(cache) {
  ensureDirs();
  fs.writeFileSync(PATHS.subscriptionsCacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function saveSubscriptionCache(subName, data) {
  const cache = readSubscriptionCache();
  cache[subName] = { ...cache[subName], ...data };
  writeSubscriptionCache(cache);
}

function getSubscriptions() {
  const settings = readSettings();
  return settings.subscriptions || [];
}

// 获取合并了缓存数据的订阅列表
function getSubscriptionsWithCache() {
  const subs = getSubscriptions();
  const cache = readSubscriptionCache();
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
  const updates = { subscriptions: subs };
  if (!settings.active_subscription && subs.length === 1) {
    updates.active_subscription = name;
  }
  writeSettings(updates);
}

function setDefaultSubscription(name) {
  const settings = readSettings();
  const subs = settings.subscriptions || [];
  const idx = subs.findIndex(s => s.name === name);
  if (idx < 0) {
    return false;
  }
  writeSettings({ active_subscription: name });
  return true;
}

function getSubscriptionRawConfigPath(subName) {
  return path.join(DIRS.subscriptions, subName + '.yaml');
}

function saveSubscriptionRawConfig(subName, content) {
  ensureDirs();
  const filePath = getSubscriptionRawConfigPath(subName);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

function readSubscriptionRawConfig(subName) {
  const filePath = getSubscriptionRawConfigPath(subName);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function hasKernel() {
  return fs.existsSync(PATHS.mihomoBinary);
}

let kernelVersionCache = null;
let kernelVersionCached = false;

function getKernelVersion() {
  if (!hasKernel()) {
    kernelVersionCache = null;
    kernelVersionCached = false;
    return null;
  }
  if (kernelVersionCached) return kernelVersionCache;
  try {
    const output = execSync('"' + PATHS.mihomoBinary + '" -v 2>&1 || true', {
      encoding: 'utf8',
    }).trim();
    if (output) {
      const match = output.match(/v?[\d]+\.[\d]+\.[\d]+/);
      kernelVersionCache = match ? match[0] : output;
    } else {
      kernelVersionCache = 'unknown';
    }
  } catch (_e) {
    kernelVersionCache = 'unknown';
  }
  kernelVersionCached = true;
  return kernelVersionCache;
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
  } catch (_e) {}
  try {
    return JSON.parse(content);
  } catch (_e2) {
    throw new Error((errorMsg || '内容') + '格式错误，无法解析为 YAML 或 JSON');
  }
}

function buildConfig(subRawContent, mode) {
  const subscriptionConfig = parseYamlOrJson(subRawContent, '订阅内容');

  if (!subscriptionConfig) {
    throw new Error('订阅内容为空');
  }

  // 延迟加载以避免循环依赖
  const overwrite = require('./overwrite');

  // 应用覆写配置
  const overwriteEnabled = overwrite.isOverwriteEnabled();
  const withOverwrites = overwrite.applyOverwrite(subscriptionConfig);
  const overwriteFiles = overwriteEnabled ? overwrite.loadOverwriteFile() : [];

  // 构建系统覆盖值（BASE_CONFIG + 可选 TUN）
  // 只补充订阅中缺失的字段，不覆盖已有值
  const systemConfig = {};
  for (const [key, value] of Object.entries(BASE_CONFIG)) {
    if (!(key in withOverwrites)) {
      systemConfig[key] = value;
    }
  }

  if (mode === 'tun') {
    // tun 块始终由系统控制
    systemConfig.tun = TUN_CONFIG.tun;
    // dns 只补充 TUN 必需的字段
    const subDns = withOverwrites.dns || {};
    systemConfig.dns = {};
    if (!subDns.enable) systemConfig.dns.enable = true;
    if (!subDns['enhanced-mode']) systemConfig.dns['enhanced-mode'] = 'fake-ip';
    if (!subDns['fake-ip-range']) systemConfig.dns['fake-ip-range'] = '198.18.0.1/16';
    // 如果没有需要补充的 dns 字段，则不设置
    if (Object.keys(systemConfig.dns).length === 0) {
      delete systemConfig.dns;
    }
  }

  // 合并：订阅(+overwrite) → 系统补充
  const merged = { ...withOverwrites, ...systemConfig };

  // dns 需要深度合并：保留订阅的 DNS 服务器，叠加系统补充
  if (systemConfig.dns) {
    merged.dns = { ...(withOverwrites.dns || {}), ...systemConfig.dns };
  }

  return {
    config: merged,
    subscriptionConfig,
    overwriteFiles,
    systemConfig,
  };
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

function writeDebugConfig(buildResult) {
  ensureDirs();
  const dumpOpts = { indent: 2, lineWidth: -1, noCompat: true };

  // 1. 订阅原始配置
  fs.writeFileSync(PATHS.configStage1Subscription, yaml.dump(buildResult.subscriptionConfig, dumpOpts), { mode: 0o600 });

  // 2. overwrite 覆写内容（禁用时写空文件）
  const overwriteMerged = {};
  for (const f of buildResult.overwriteFiles) {
    Object.assign(overwriteMerged, f.config);
  }
  const overwriteContent = buildResult.overwriteFiles.length > 0 ? yaml.dump(overwriteMerged, dumpOpts) : '# overwrite 已禁用或无覆写文件\n';
  fs.writeFileSync(PATHS.configStage2Overwrite, overwriteContent, { mode: 0o600 });

  // 3. 系统覆盖值（BASE_CONFIG + TUN_CONFIG）
  fs.writeFileSync(PATHS.configStage3System, yaml.dump(buildResult.systemConfig, dumpOpts), { mode: 0o600 });
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
  } catch (_e) {
    return null;
  }
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function resetUserData(options) {
  if (options === undefined) options = {};
  const keepKernel = options.keepKernel !== false;
  const kernelOnly = options.kernelOnly === true;

  let itemsToRemove;
  if (kernelOnly) {
    itemsToRemove = [DIRS.kernel];
  } else {
    itemsToRemove = [PATHS.settingsFile, DIRS.subscriptions, DIRS.logs, DIRS.data, DIRS.runtime];
    if (!keepKernel) {
      itemsToRemove.push(DIRS.kernel);
    }
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

  if (!kernelOnly) {
    ensureDirs();
    settingsCache = null;
  }
  return removedCount;
}

// 目录目标映射（从 index.js 移入，精确匹配）
const DIRECTORY_TARGETS = {
  root: { path: null, label: '根目录' },
  subs: { path: DIRS.subscriptions, label: '订阅目录' },
  logs: { path: DIRS.logs, label: '日志目录' },
  data: { path: DIRS.data, label: 'mihomo 数据目录' },
  runtime: { path: DIRS.runtime, label: '运行时目录' },
  kernel: { path: DIRS.kernel, label: '内核目录' },
};

module.exports = {
  PATHS,
  DIRS,
  USER_DATA_DIR,
  DIRECTORY_TARGETS,
  ensureDirs,
  readSettings,
  writeSettings,
  readSubscriptionCache,
  saveSubscriptionCache,
  maskUrl,
  getSubscriptions,
  getSubscriptionsWithCache,
  addSubscription,
  setDefaultSubscription,
  saveSubscriptionRawConfig,
  readSubscriptionRawConfig,
  hasKernel,
  getKernelVersion,
  clearKernelVersionCache: () => {
    kernelVersionCache = null;
    kernelVersionCached = false;
  },
  getGitHubMirror,
  setGitHubMirror,
  DEFAULT_GITHUB_MIRROR,
  AVAILABLE_MIRRORS,
  parseYamlOrJson,
  buildConfig,
  writeMihomoConfig,
  writeDebugConfig,
  hasConfig,
  getConfigInfo,
  resetUserData,
  invalidateSettingsCache: () => {
    settingsCache = null;
  },
  fsExistsSync: p => fs.existsSync(p),
  rmrf,
};
