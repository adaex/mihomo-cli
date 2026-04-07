// 内置模块
const { execSync } = require('child_process');

// 第三方模块
const axios = require('axios');

// 本地模块
// （无本地模块依赖）

const VERSION = require('../package.json').version;

const sleepBuf = new Int32Array(1);

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

function colorize(code, str) {
  if (NO_COLOR) return String(str);
  return code + String(str) + '\x1b[0m';
}

const colors = {
  bold: s => colorize('\x1b[1m', s),
  red: s => colorize('\x1b[31m', s),
  green: s => colorize('\x1b[32m', s),
  yellow: s => colorize('\x1b[33m', s),
  cyan: s => colorize('\x1b[36m', s),
  gray: s => colorize('\x1b[90m', s),
};

function sleepSync(ms) {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return '未知';
  const num = Number(bytes);
  if (isNaN(num) || num < 0) return '未知';
  if (num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTimestamp(ts) {
  if (ts === undefined || ts === null) return '未知';
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  } catch {
    return '未知';
  }
}

function formatDate(dateOrIso) {
  if (dateOrIso === undefined || dateOrIso === null) return '未知';
  try {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
    if (isNaN(d.getTime())) return '未知';
    return d.toLocaleString('zh-CN');
  } catch {
    return '未知';
  }
}

function hasFlag(args, short, long) {
  return args && (args.includes(short) || args.includes(long));
}

function parseIntArg(args, short, long, defaultValue) {
  if (!args) return defaultValue;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === short || args[i] === long) {
      if (i + 1 < args.length) {
        const val = parseInt(args[i + 1]);
        return isNaN(val) ? defaultValue : val;
      }
    }
  }
  return defaultValue;
}

function getNonFlagArg(args, startIdx) {
  if (!args) return null;
  for (let i = startIdx; i < args.length; i++) {
    if (!args[i].startsWith('-')) {
      return args[i];
    }
  }
  return null;
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    const output = execSync('ps -p ' + pid + ' -o pid= 2>/dev/null || true', {
      encoding: 'utf8',
    }).trim();
    return output.length > 0;
  } catch (_e) {
    return false;
  }
}

function isProcessRoot(pid) {
  if (!pid) return false;
  try {
    const uidOutput = execSync('ps -p ' + pid + ' -o uid= 2>/dev/null || true', {
      encoding: 'utf8',
    }).trim();
    return uidOutput === '0';
  } catch (_e) {
    return false;
  }
}

/**
 * 创建统一的 HTTP 客户端
 */
function createHttpClient(options) {
  const opts = options || {};
  const timeout = opts.timeout || 60000;
  const maxContentLength = opts.maxContentLength || 50 * 1024 * 1024;
  const userAgent = opts.userAgent || 'mihomo-cli/' + VERSION;

  return axios.create({
    timeout,
    headers: { 'User-Agent': userAgent },
    maxContentLength,
    maxBodyLength: maxContentLength,
  });
}

/**
 * 规范化镜像 URL（从 index.js 移入）
 */
function normalizeMirrorUrl(val) {
  if (!val) return null;
  if (val === 'direct' || val === 'no' || val === 'none') return null;

  let url = val;
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }
  if (!url.endsWith('/')) {
    url += '/';
  }
  return url;
}

/**
 * 解析镜像参数（从 index.js 移入）
 * 返回: { mirror: 镜像URL|null, isOverride: boolean, type: 'download'|'all' }
 * mirror = null 表示禁用镜像（直连）
 * mirror = undefined 表示使用默认/配置
 * type: download=仅下载用镜像, all=API和下载都用镜像
 */
function parseMirrorArg(args) {
  if (!args || args.length < 2) {
    return { mirror: null, isOverride: false, type: 'download' };
  }

  if (args.includes('--no-mirror') || args.includes('--direct')) {
    return { mirror: null, isOverride: true, type: 'download' };
  }

  const mirrorAllIdx = args.indexOf('--mirror-all');
  if (mirrorAllIdx >= 0) {
    const nextArg = args[mirrorAllIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      return { mirror: 'https://v6.gh-proxy.org/', isOverride: true, type: 'all' };
    }
    return { mirror: normalizeMirrorUrl(nextArg), isOverride: true, type: 'all' };
  }

  const mirrorIdx = args.indexOf('--mirror');
  if (mirrorIdx >= 0) {
    const nextArg = args[mirrorIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      return { mirror: 'https://v6.gh-proxy.org/', isOverride: true, type: 'download' };
    }
    return { mirror: normalizeMirrorUrl(nextArg), isOverride: true, type: 'download' };
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      return { mirror: normalizeMirrorUrl(arg), isOverride: true };
    }
  }

  return { mirror: null, isOverride: false };
}

module.exports = {
  VERSION,
  sleepSync,
  formatBytes,
  formatTimestamp,
  formatDate,
  hasFlag,
  parseIntArg,
  getNonFlagArg,
  isProcessRunning,
  isProcessRoot,
  colors,
  createHttpClient,
  normalizeMirrorUrl,
  parseMirrorArg,
};
