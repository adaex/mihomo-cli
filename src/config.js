const path = require('path');
const fs = require('fs');
const os = require('os');
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
  subs: path.join(USER_DATA_DIR, 'subs'),
  logs: path.join(USER_DATA_DIR, 'logs'),
  data: path.join(USER_DATA_DIR, 'data'),
  runtime: path.join(USER_DATA_DIR, '.runtime'),
};

const PATHS = {
  root: DIRS.root,
  data: DIRS.data,
  userDataDir: USER_DATA_DIR,
  mihomoBinary: path.join(DIRS.core, 'mihomo'),
  settingsFile: path.join(USER_DATA_DIR, 'settings.json'),
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

function readSettings() {
  ensureDirs();
  if (fs.existsSync(PATHS.settingsFile)) {
    try {
      const content = fs.readFileSync(PATHS.settingsFile, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      return {};
    }
  }
  return {};
}

function writeSettings(settings) {
  ensureDirs();
  const existing = readSettings();
  const merged = { ...existing, ...settings };
  fs.writeFileSync(PATHS.settingsFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

function getSubscriptions() {
  const settings = readSettings();
  return settings.subscriptions || [];
}

function addSubscription(url, name) {
  if (name === undefined) name = 'default';
  const settings = readSettings();
  const subs = settings.subscriptions || [];
  const existingIndex = subs.findIndex(s => s.name === name);
  if (existingIndex >= 0) {
    subs[existingIndex] = { name, url, updatedAt: new Date().toISOString() };
  } else {
    subs.push({ name, url, updatedAt: null });
  }
  writeSettings({ subscriptions: subs });
}

function getSubRawConfigPath(subName) {
  return path.join(DIRS.subs, subName + '.yaml');
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

function getKernelVersion() {
  if (!hasKernel()) {
    return null;
  }
  try {
    const output = execSync('"' + PATHS.mihomoBinary + '" -v 2>&1 || true', {
      encoding: 'utf8',
    }).trim();
    if (output) {
      const match = output.match(/v?[\d]+\.[\d]+\.[\d]+/);
      if (match) {
        return match[0];
      }
      return output;
    }
    return 'unknown';
  } catch (e) {
    return 'unknown';
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

function buildConfig(subRawContent, mode) {
  const yaml = require('js-yaml');

  let baseConfig;
  try {
    baseConfig = yaml.load(subRawContent);
  } catch (e) {
    try {
      baseConfig = JSON.parse(subRawContent);
    } catch (e2) {
      throw new Error('订阅内容格式错误，无法解析为 YAML 或 JSON');
    }
  }

  if (!baseConfig) {
    throw new Error('订阅内容为空');
  }

  const merged = { ...baseConfig, ...BASE_CONFIG };

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
  const yaml = require('js-yaml');
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
    const yaml = require('js-yaml');
    const content = fs.readFileSync(PATHS.configFile, 'utf8');
    const cfg = yaml.load(content);

    if (!cfg) return null;

    return {
      proxies: cfg.proxies ? cfg.proxies.length : 0,
      proxyGroups: cfg['proxy-groups'] ? cfg['proxy-groups'].length : 0,
      mode: cfg.mode || 'rule',
      port: cfg.port || cfg['mixed-port'] || '未知',
      tun: cfg.tun ? cfg.tun.enable : false,
    };
  } catch (e) {
    return null;
  }
}

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  const stat = fs.statSync(dir);
  if (stat.isDirectory()) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      rmrf(path.join(dir, f));
    }
    fs.rmdirSync(dir);
  } else {
    fs.unlinkSync(dir);
  }
}

function resetUserData(options) {
  if (options === undefined) options = {};
  const keepKernel = options.keepKernel !== false;

  const itemsToRemove = [
    PATHS.settingsFile,
    DIRS.subs,
    DIRS.logs,
    DIRS.data,
    DIRS.runtime,
  ];

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
  maskUrl,
  getSubscriptions,
  addSubscription,
  getSubRawConfigPath,
  saveSubRawConfig,
  readSubRawConfig,
  hasKernel,
  getKernelVersion,
  TUN_CONFIG,
  BASE_CONFIG,
  buildConfig,
  writeMihomoConfig,
  hasConfig,
  getConfigInfo,
  resetUserData,
  rmrf,
};
