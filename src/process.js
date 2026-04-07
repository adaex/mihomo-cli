const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const config = require('./config');

const _sharedBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(_sharedBuf, 0, 0, ms);
}

function clearRuntime() {
  if (fs.existsSync(config.DIRS.runtime)) {
    config.rmrf(config.DIRS.runtime);
  }
  config.ensureDirs();
}

function getPid() {
  if (!fs.existsSync(config.PATHS.pidFile)) {
    return null;
  }
  try {
    const pid = parseInt(fs.readFileSync(config.PATHS.pidFile, 'utf8').trim());
    return pid > 0 ? pid : null;
  } catch (e) {
    return null;
  }
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

function isRunning() {
  const pid = getPid();
  return pid ? isProcessRunning(pid) : false;
}

function getAllMihomoPids() {
  const binaryPath = config.PATHS.mihomoBinary;

  try {
    const output = execSync('pgrep -f "' + binaryPath + '" 2>/dev/null || true', {
      encoding: 'utf8',
    }).trim();
    if (!output) return [];
    return output
      .split('\n')
      .filter(Boolean)
      .map(p => parseInt(p));
  } catch {
    return [];
  }
}

function isProcessRoot(pid) {
  try {
    const uidOutput = execSync('ps -p ' + pid + ' -o uid= 2>/dev/null || true', {
      encoding: 'utf8',
    }).trim();
    return uidOutput === '0';
  } catch (e) {
    return false;
  }
}

function isPidFileOwnedByRoot() {
  if (!fs.existsSync(config.PATHS.pidFile)) {
    return false;
  }
  try {
    const stat = fs.statSync(config.PATHS.pidFile);
    return stat.uid === 0;
  } catch (e) {
    return false;
  }
}

function checkStaleState() {
  const allPids = getAllMihomoPids();
  const hasRootProcess = allPids.some(p => isProcessRoot(p));
  const hasRootPidFile = isPidFileOwnedByRoot();

  return {
    needsCleanup: allPids.length > 0 || hasRootPidFile,
    allPids,
    hasRootProcess,
    hasRootPidFile,
    needsSudo: hasRootProcess || hasRootPidFile,
  };
}

function savePid(pid) {
  config.ensureDirs();
  fs.writeFileSync(config.PATHS.pidFile, pid.toString(), { mode: 0o600 });
}

function clearPid() {
  if (!fs.existsSync(config.PATHS.pidFile)) {
    return;
  }
  if (isPidFileOwnedByRoot()) {
    try {
      execSync('sudo rm -f "' + config.PATHS.pidFile + '" 2>/dev/null', {
        stdio: 'inherit',
        timeout: 10000,
      });
    } catch (e) {
      // 忽略失败，后续操作可能会检测到问题
    }
  } else {
    try {
      fs.unlinkSync(config.PATHS.pidFile);
    } catch (e) {
      // ignore
    }
  }
}

function killProcess(pid, needsSudo) {
  if (needsSudo === undefined) needsSudo = false;
  try {
    if (needsSudo) {
      try {
        execSync('sudo kill -9 ' + pid + ' 2>/dev/null', {
          stdio: 'inherit',
          timeout: 10000,
        });
        return true;
      } catch (e) {
        try {
          process.kill(pid, 'SIGKILL');
          return true;
        } catch (e2) {
          return false;
        }
      }
    } else {
      process.kill(pid, 'SIGKILL');
      return true;
    }
  } catch (e) {
    return false;
  }
}

function killAllMihomo(forceSudo) {
  if (forceSudo === undefined) forceSudo = false;
  const binaryPath = config.PATHS.mihomoBinary;

  if (forceSudo) {
    try {
      execSync('sudo pkill -9 -f "' + binaryPath + '" 2>/dev/null || true', {
        stdio: 'inherit',
        timeout: 15000,
      });
      return true;
    } catch {
      return false;
    }
  } else {
    try {
      execSync('pkill -9 -f "' + binaryPath + '" 2>/dev/null || true');
      return true;
    } catch {
      return false;
    }
  }
}

function cleanupAll(forceSudo) {
  if (forceSudo === undefined) forceSudo = false;
  const pids = getAllMihomoPids();
  if (pids.length === 0) {
    clearPid();
    return { killed: 0, failed: 0, remaining: [] };
  }

  const hasRootProcess = pids.some(p => isProcessRoot(p));
  const hasRootPidFile = isPidFileOwnedByRoot();
  const needsSudo = hasRootProcess;
  const allowSudo = forceSudo || hasRootProcess || hasRootPidFile;

  let killedCount = 0;
  let failedPids = [];

  if (needsSudo) {
    const success = killAllMihomo(true);
    if (success) {
      killedCount = pids.length;
    } else {
      failedPids = pids;
    }
  } else {
    if (pids.length > 3) {
      killAllMihomo(false);
      killedCount = pids.length;
    } else {
      pids.forEach(pid => {
        if (killProcess(pid, false)) {
          killedCount++;
        } else {
          failedPids.push(pid);
        }
      });
    }
  }

  for (let i = 0; i < 50; i++) {
    if (getAllMihomoPids().length === 0) break;
    sleepSync(100);
  }

  clearPid();

  return {
    killed: killedCount,
    failed: failedPids.length,
    remaining: getAllMihomoPids(),
  };
}

function createTunLaunchScript() {
  const binary = config.PATHS.mihomoBinary;
  const configFile = config.PATHS.configFile;
  const logFile = config.PATHS.logFile;
  const pidFile = config.PATHS.pidFile;
  const dataDir = config.DIRS.data;

  const scriptContent =
    '#!/bin/bash\n' +
    'BINARY="' +
    binary +
    '"\n' +
    'CONFIG_FILE="' +
    configFile +
    '"\n' +
    'LOG_FILE="' +
    logFile +
    '"\n' +
    'PID_FILE="' +
    pidFile +
    '"\n' +
    'DATA_DIR="' +
    dataDir +
    '"\n' +
    '\n' +
    '# 终止旧进程\n' +
    'pkill -9 -f "${BINARY}" 2>/dev/null || true\n' +
    'sleep 0.2\n' +
    'rm -f "${PID_FILE}" 2>/dev/null || true\n' +
    '\n' +
    '# 写入启动标记\n' +
    'echo "=== TUN 启动: $(date) ===" >> "${LOG_FILE}"\n' +
    '\n' +
    '# 启动\n' +
    'cd /tmp\n' +
    '"${BINARY}" -d "${DATA_DIR}" -f "${CONFIG_FILE}" >> "${LOG_FILE}" 2>&1 &\n' +
    'NEW_PID=$!\n' +
    'echo ${NEW_PID} > "${PID_FILE}"\n' +
    '\n' +
    '# 验证\n' +
    'for i in 1 2 3 4 5; do\n' +
    '  sleep 0.4\n' +
    '  if kill -0 ${NEW_PID} 2>/dev/null; then\n' +
    '    exit 0\n' +
    '  fi\n' +
    'done\n' +
    '\n' +
    '# 失败，显示日志\n' +
    'echo "TUN 启动失败"\n' +
    'echo ""\n' +
    'echo "--- 日志 ---"\n' +
    'tail -25 "${LOG_FILE}" 2>/dev/null\n' +
    'exit 1\n';

  const scriptPath = path.join(config.DIRS.runtime, 'launch-tun.sh');
  fs.writeFileSync(scriptPath, scriptContent, { mode: 0o700 });

  return scriptPath;
}

function getProcessInfo(pid) {
  try {
    const psOutput = execSync('ps -p ' + pid + ' -o rss=,pcpu=,comm= 2>/dev/null || true', {
      encoding: 'utf8',
    }).trim();

    if (!psOutput) return null;

    const parts = psOutput.split(/\s+/).filter(p => p);
    if (parts.length < 2) return null;

    const rss = parseInt(parts[0]);
    const pcpu = parseFloat(parts[1]);

    return {
      pid,
      memory: rss ? (rss / 1024).toFixed(1) + ' MB' : '未知',
      cpu: pcpu ? pcpu.toFixed(1) + '%' : '未知',
      isRoot: isProcessRoot(pid),
    };
  } catch (e) {
    return { pid, memory: '未知', cpu: '未知', isRoot: false };
  }
}

function getStatus() {
  const running = isRunning();
  const pid = getPid();
  const allPids = getAllMihomoPids();

  return {
    running,
    pid: running ? pid : null,
    processInfo: running && pid ? getProcessInfo(pid) : null,
    hasConfig: config.hasConfig(),
    hasKernel: config.hasKernel(),
    kernelVersion: config.getKernelVersion(),
    allProcesses: allPids,
    hasStaleProcesses: allPids.length > (running ? 1 : 0),
  };
}

async function start(mode) {
  if (mode === undefined) mode = 'mixed';
  const isTunMode = mode === 'tun';

  const staleState = checkStaleState();

  if (isTunMode) {
    return startTunMode(staleState);
  } else {
    return startMixedMode(staleState);
  }
}

async function startMixedMode(staleState) {
  if (staleState.needsCleanup) {
    if (staleState.needsSudo) {
      console.log('\n发现需要 root 权限清理的残留进程/文件');
      console.log('请先手动清理: sudo pkill -9 mihomo');
      console.log('或者切换到 TUN 模式，启动时会自动清理');
      throw new Error('存在需要 root 权限清理的残留');
    }

    const cleanupResult = cleanupAll();
    if (cleanupResult.killed > 0) {
      console.log('清理了 ' + cleanupResult.killed + ' 个残留进程');
    }
  }

  if (isRunning()) {
    const pid = getPid();
    return { success: true, pid, alreadyRunning: true };
  }

  config.ensureDirs();
  rotateAndCleanupLogs();

  const binary = config.PATHS.mihomoBinary;
  if (!fs.existsSync(binary)) {
    throw new Error('未找到 mihomo 内核，请先下载内核');
  }

  const configFile = config.PATHS.configFile;
  const logFile = config.PATHS.logFile;

  if (!fs.existsSync(configFile)) {
    throw new Error('未找到配置文件，请先添加订阅并启动');
  }

  const args = ['-d', config.DIRS.data, '-f', configFile];

  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');

  const child = spawn(binary, args, {
    detached: true,
    stdio: ['ignore', out, err],
    cwd: config.PATHS.root,
  });

  child.unref();

  const pid = child.pid;
  savePid(pid);

  await new Promise(resolve => setTimeout(resolve, 800));

  if (!isRunning()) {
    clearPid();
    let errorMsg = '启动失败';
    if (fs.existsSync(logFile)) {
      try {
        const logs = fs.readFileSync(logFile, 'utf8').slice(-3000);
        if (logs.trim()) {
          errorMsg +=
            '\n最近的日志:\n' +
            logs
              .split('\n')
              .map(l => '  ' + l)
              .join('\n');
        }
      } catch {}
    }
    throw new Error(errorMsg);
  }

  return { success: true, pid, mode: 'mixed' };
}

async function startTunMode(staleState) {
  config.ensureDirs();
  rotateAndCleanupLogs();

  const binary = config.PATHS.mihomoBinary;
  if (!fs.existsSync(binary)) {
    throw new Error('未找到 mihomo 内核，请先下载内核');
  }

  const configFile = config.PATHS.configFile;

  if (!fs.existsSync(configFile)) {
    throw new Error('未找到配置文件，请先添加订阅并启动');
  }

  const launchScript = createTunLaunchScript();

  if (staleState.needsCleanup) {
    console.log('清理 ' + staleState.allPids.length + ' 个残留进程...');
  }
  console.log('TUN 模式需要 sudo 权限...');

  try {
    execSync('sudo "' + launchScript + '"', {
      stdio: 'inherit',
      timeout: 60000,
    });
  } catch (e) {
    try {
      fs.unlinkSync(launchScript);
    } catch (e2) {}
    if (e.status === 1) {
      throw new Error('密码错误或取消');
    }
    throw new Error(e.message);
  }

  try {
    fs.unlinkSync(launchScript);
  } catch (e) {}

  await new Promise(resolve => setTimeout(resolve, 500));

  const finalPid = getPid();
  if (!finalPid) {
    throw new Error('TUN 启动失败');
  }

  return { success: true, pid: finalPid, mode: 'tun' };
}

function stop(forceSudo) {
  const allPids = getAllMihomoPids();
  if (allPids.length === 0) {
    clearPid();
    clearRuntime();
    return { success: true, notRunning: true };
  }

  const result = cleanupAll(forceSudo);

  const remaining = getAllMihomoPids();
  if (remaining.length > 0) {
    console.log('');
    console.log('仍有进程残留，需要手动清理:');
    console.log('进程 PID: ' + remaining.join(', '));
    console.log('手动命令: sudo pkill -9 mihomo');
    console.log('');
    return { success: true, warning: '部分进程未终止', remaining };
  }

  clearRuntime();
  return { success: true, killed: result.killed };
}

function rotateAndCleanupLogs() {
  rotateLog();
  cleanupOldLogs(7);
}

function getLogPath() {
  return config.PATHS.logFile;
}

function rotateLog() {
  const logFile = config.PATHS.logFile;
  if (!fs.existsSync(logFile)) {
    return null;
  }

  const stat = fs.statSync(logFile);
  if (stat.size === 0) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').replace(/\..+/, '');

  const rotatedName = `mihomo.${timestamp}.log`;
  const rotatedPath = path.join(config.DIRS.logs, rotatedName);

  fs.renameSync(logFile, rotatedPath);
  return rotatedPath;
}

function cleanupOldLogs(maxAgeDays) {
  if (maxAgeDays === undefined) maxAgeDays = 7;
  const logsDir = config.DIRS.logs;

  if (!fs.existsSync(logsDir)) {
    return { deleted: 0, errors: 0 };
  }

  const files = fs.readdirSync(logsDir);
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  let deleted = 0;
  let errors = 0;

  for (const file of files) {
    if (!file.match(/^mihomo\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/)) {
      continue;
    }

    try {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      const ageMs = now - stat.mtimeMs;

      if (ageMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch (e) {
      errors++;
    }
  }

  return { deleted, errors };
}

function listLogs() {
  const logsDir = config.DIRS.logs;
  const result = {
    current: null,
    archives: [],
  };

  if (fs.existsSync(config.PATHS.logFile)) {
    const stat = fs.statSync(config.PATHS.logFile);
    result.current = {
      name: 'mihomo.log (当前)',
      path: config.PATHS.logFile,
      size: stat.size,
      mtime: stat.mtime,
      isCurrent: true,
    };
  }

  if (!fs.existsSync(logsDir)) {
    return result;
  }

  const files = fs.readdirSync(logsDir);
  for (const file of files) {
    const match = file.match(/^mihomo\.(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.log$/);
    if (!match) continue;

    try {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      result.archives.push({
        name: file,
        timestamp: match[1],
        path: filePath,
        size: stat.size,
        mtime: stat.mtime,
        isCurrent: false,
      });
    } catch (e) {
      // ignore
    }
  }

  result.archives.sort((a, b) => b.mtime - a.mtime);
  return result;
}

function getLogPathByName(name) {
  const logsDir = config.DIRS.logs;

  // 处理部分匹配（用户只输入时间戳部分）
  let targetName = name;
  if (!name.endsWith('.log')) {
    targetName = 'mihomo.' + name + '.log';
  }
  if (!targetName.startsWith('mihomo.')) {
    targetName = 'mihomo.' + targetName;
  }

  const filePath = path.join(logsDir, targetName);
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  // 尝试模糊匹配
  if (fs.existsSync(logsDir)) {
    const files = fs.readdirSync(logsDir);
    for (const file of files) {
      if (file.includes(name)) {
        return path.join(logsDir, file);
      }
    }
  }

  return null;
}

function openUrl(url) {
  try {
    spawn('open', [url], { stdio: 'ignore', detached: true });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  getAllMihomoPids,
  cleanupAll,
  getStatus,
  start,
  stop,
  getLogPath,
  listLogs,
  getLogPathByName,
  openUrl,
};
