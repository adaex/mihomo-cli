import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { CliError } from './errors.js';
import { rotateAndCleanupLogs } from './log-files.js';
import { DIRS, ensureDirs, PATHS } from './paths.js';
import { checkStaleState, getPid, isRunning, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import { cleanupAll, clearPid } from './process-stop.js';
import { runSudoScript } from './sudo.js';
import type { StaleState, StartResult } from './types.js';
import { shellQuote } from './utils.js';

/**
 * 内核进程的启动（Mixed 普通 spawn / TUN sudo 脚本两条路径）。
 * 停止与清理在 process-stop.ts，探测在 process-probe.ts。
 */

const STARTUP_WAIT_MS = 800;
const TUN_MODE_POST_WAIT_MS = 500;

function savePid(pid: number): void {
  ensureDirs();
  fs.writeFileSync(PATHS.pidFile, pid.toString(), { mode: 0o600 });
}

/**
 * 生成 TUN 启动脚本 body（不写盘：写盘 + chmod + sudo + 清理由 runSudoScript 统一完成，
 * 与 daemon 的 enable/disable/restart 共用同一套 sudo 范式，不再各自手写 spawnSync('sudo')）。
 */
function buildTunLaunchScript(): string {
  const binary = shellQuote(PATHS.mihomoBinary);
  const configFile = shellQuote(PATHS.configFile);
  const logFile = shellQuote(PATHS.logFile);
  const pidFile = shellQuote(PATHS.pidFile);
  const dataDir = shellQuote(DIRS.data);
  const killPattern = shellQuote(MAIN_INSTANCE_PATTERN);

  return (
    '#!/bin/bash\n' +
    `BINARY=${binary}\n` +
    `CONFIG_FILE=${configFile}\n` +
    `LOG_FILE=${logFile}\n` +
    `PID_FILE=${pidFile}\n` +
    `DATA_DIR=${dataDir}\n` +
    `KILL_PATTERN=${killPattern}\n` +
    '\n' +
    '# 终止旧进程\n' +
    'pkill -9 -f "${KILL_PATTERN}" 2>/dev/null || true\n' +
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
    '# 失败，显示日志（退出码 2：避开 sudo 的 1=鉴权失败/取消，供调用方区分）\n' +
    'rm -f "${PID_FILE}" 2>/dev/null || true\n' +
    'echo "TUN 启动失败"\n' +
    'echo ""\n' +
    'echo "--- 日志 ---"\n' +
    'tail -25 "${LOG_FILE}" 2>/dev/null\n' +
    'exit 2\n'
  );
}

export async function start(mode = 'mixed'): Promise<StartResult> {
  const isTunMode = mode === 'tun';

  ensureDirs();
  rotateAndCleanupLogs();

  const binary = PATHS.mihomoBinary;
  if (!fs.existsSync(binary)) {
    throw new CliError('未找到 mihomo 内核，请先下载内核');
  }

  const configFile = PATHS.configFile;
  if (!fs.existsSync(configFile)) {
    throw new CliError('未找到配置文件，请先添加订阅并启动');
  }

  const staleState = checkStaleState();

  if (isTunMode) {
    return startTunMode(staleState);
  }
  return startMixedMode(staleState);
}

async function startMixedMode(staleState: StaleState): Promise<StartResult> {
  if (staleState.needsCleanup) {
    if (staleState.needsSudo) {
      console.log('\n发现需要 root 权限清理的残留进程/文件');
      console.log(`请先手动清理: sudo pkill -9 mihomo && sudo rm -f ${PATHS.pidFile}`);
      console.log('或者切换到 TUN 模式，启动时会自动清理');
      throw new Error('存在需要 root 权限清理的残留');
    }

    const cleanupResult = cleanupAll();
    if (cleanupResult.killed > 0) {
      console.log(`清理了 ${cleanupResult.killed} 个残留进程`);
    }
  }

  if (isRunning()) {
    const pid = getPid() as number;
    return { success: true, pid, alreadyRunning: true };
  }

  const configFile = PATHS.configFile;
  const logFile = PATHS.logFile;
  const args = ['-d', DIRS.data, '-f', configFile];

  // 防御：保活（root LaunchDaemon）曾运行时可能把 mihomo.log 变成 root 属主，
  // 用户态 openSync('a') 会 EACCES。若不可写则直接删除（父目录用户拥有，unlink 必成功；
  // rotateLog 对 size===0 会跳过，故不能依赖它），让下面重建用户属主的新日志。
  if (fs.existsSync(logFile)) {
    try {
      fs.accessSync(logFile, fs.constants.W_OK);
    } catch {
      try {
        fs.unlinkSync(logFile);
      } catch {
        /* ignore：极端情况下留给 openSync 抛出可读错误 */
      }
    }
  }

  const logFd = fs.openSync(logFile, 'a');

  const child = spawn(PATHS.mihomoBinary, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  // 监听 error（如二进制不可执行 EACCES/ENOENT）：detached 进程的 error 事件若无 handler 会冒泡为
  // uncaughtException。这里吞掉，交由下面的 isRunning() + 日志读取给出可读错误。
  child.on('error', () => {});

  fs.closeSync(logFd);

  child.unref();

  const pid = child.pid;
  if (!pid) {
    clearPid();
    throw new Error('启动失败：无法创建内核进程（内核二进制可能不可执行）');
  }
  savePid(pid);

  await new Promise(resolve => setTimeout(resolve, STARTUP_WAIT_MS));

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
              .map(l => `  ${l}`)
              .join('\n');
        }
      } catch {
        /* ignore */
      }
    }
    throw new Error(errorMsg);
  }

  return { success: true, pid, mode: 'mixed' };
}

async function startTunMode(staleState: StaleState): Promise<StartResult> {
  if (staleState.needsCleanup) {
    console.log(`清理 ${staleState.allPids.length} 个残留进程...`);
  }
  console.log('TUN 模式需要 sudo 权限...');

  // runSudoScript 统一处理：写临时脚本 + chmod 700 + 单次 sudo + 退出码映射 + 用后即删。
  // 退出码 2 是脚本自身的「启动失败（详见上方日志）」；1 留给 sudo 鉴权取消/密码错误。
  runSudoScript(buildTunLaunchScript(), {
    action: 'TUN 启动',
    file: 'launch-tun.sh',
    codeMessages: { 2: 'TUN 启动失败（详见上方日志）' },
  });

  await new Promise(resolve => setTimeout(resolve, TUN_MODE_POST_WAIT_MS));

  const finalPid = getPid();
  if (!finalPid) {
    throw new Error('TUN 启动失败');
  }

  return { success: true, pid: finalPid, mode: 'tun' };
}
