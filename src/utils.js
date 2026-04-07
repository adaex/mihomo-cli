// 内置模块
const { execSync } = require('child_process');

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
  } catch (e) {
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
  } catch (e) {
    return false;
  }
}

module.exports = {
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
};
