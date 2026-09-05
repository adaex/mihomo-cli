import fs from 'node:fs';

import { CliError } from './errors.js';
import { readLogTail, rotateAndCleanupLogs } from './log-files.js';
import { DIRS, ensureDirs, PATHS } from './paths.js';
import { checkStaleState, getPid, isRunning, MAIN_INSTANCE_PATTERN } from './process-probe.js';
import { runSudoScript } from './sudo.js';
import type { StartResult } from './types.js';
import { shellQuote } from './utils.js';

/**
 * TUN 内核的启动（临时 sudo 脚本，不走 launchd）。
 *
 * Mixed 模式**没有**用户态启动路径了：它由 launchd 服务托管（service.ts），
 * 此前的 startMixedMode（detached spawn + pid 文件）已随 v4.1.0 删除。
 * TUN 保持临时进程语义——本就需要提权，且用完即走，交给 launchd 托管没有意义。
 *
 * 停止与清理在 process-stop.ts，探测在 process-probe.ts。
 */

const TUN_MODE_POST_WAIT_MS = 500;

/**
 * 生成 TUN 启动脚本 body（不写盘：写盘 + chmod + sudo + 清理由 runSudoScript 统一完成，
 * 与 service 的 sudo 路径共用同一套范式，不再各自手写 spawnSync('sudo')）。
 *
 * 命令行为 `<mihomoBinary> -d <data> -f <configFile>`——与服务的 plist 同构（后者
 * ProgramArguments[0] 是符号链），两者都被 MAIN_INSTANCE_PATTERN 的二选一分支覆盖。
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
    '# 进程判定：活着 = ps 能查到且状态非 Z。不能只用 kill -0——它对僵尸\n' +
    '#（bash 尚未收割的已死子进程）同样返回成功，实测 150ms 退出的桩进程 10 次中\n' +
    '# 5 次被误报存活；查不到（已被收割/不存在）同样算死。\n' +
    'is_alive() {\n' +
    '  local stat\n' +
    '  stat=$(ps -p "$1" -o stat= 2>/dev/null) || return 1\n' +
    '  case "${stat}" in\n' +
    "    Z*|'') return 1 ;;\n" +
    '    *) return 0 ;;\n' +
    '  esac\n' +
    '}\n' +
    '\n' +
    '# 验证：观察满一个窗口（12 × 0.1s ≈ 1.2s，与服务路径 SERVICE_OBSERVE_MS 对齐）。\n' +
    '# 不能「一看到活着就收口」——内核常在 spawn 后数百 ms 才退出（实测 180ms 与 540ms\n' +
    '# 两种），此前的 0.4s 单次检查必漏；期间死亡立即走失败路径。\n' +
    'i=0\n' +
    'while [ $i -lt 12 ]; do\n' +
    '  sleep 0.1\n' +
    '  is_alive ${NEW_PID} || break\n' +
    '  i=$((i+1))\n' +
    'done\n' +
    'if is_alive ${NEW_PID}; then\n' +
    '  exit 0\n' +
    'fi\n' +
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

export async function startTun(): Promise<StartResult> {
  ensureDirs();
  rotateAndCleanupLogs();

  if (!fs.existsSync(PATHS.mihomoBinary)) {
    throw new CliError('未找到 mihomo 内核，请先下载内核', { hint: '下载内核: mihomo kernel' });
  }
  if (!fs.existsSync(PATHS.configFile)) {
    throw new CliError('未找到配置文件，请先添加订阅并启动');
  }

  // 系统级服务或此前的 TUN 曾以 root 写过 mihomo.log；日志此后仍由 root 追加，
  // 但 rotateAndCleanupLogs 的 rename 需要目录权限（logs/ 属用户，可行）。
  // 若日志本身不可写且非 root 场景（用户态服务留下的），删掉让 root 重建，避免权限僵局。
  const logFile = PATHS.logFile;
  if (fs.existsSync(logFile)) {
    try {
      fs.accessSync(logFile, fs.constants.W_OK);
    } catch {
      try {
        fs.unlinkSync(logFile);
      } catch {
        /* ignore：极端情况下留给启动脚本的 >> 重定向抛出可读错误 */
      }
    }
  }

  const staleState = checkStaleState();
  if (staleState.needsCleanup) {
    // needsCleanup 也可能仅因 root pid 文件存在（无进程），此时「清理 0 个残留进程」是误导
    if (staleState.allPids.length > 0) {
      console.log(`清理 ${staleState.allPids.length} 个残留进程...`);
    } else {
      console.log('清理残留的 root pid 文件...');
    }
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

  // 复核存活而非只读 pid 文件：脚本观察窗（1.2s）结束后内核仍可能退出（端口冲突等
  // 晚期失败），pid 文件还在而进程已死——只读文件会把这报成启动成功。
  // isRunning 同时校验命令行，防 pid 被无关进程复用
  const finalPid = getPid();
  if (!finalPid || !isRunning()) {
    const tail = readLogTail();
    throw new CliError('TUN 启动失败（内核未能保持运行）', {
      hint: [...(tail.length > 0 ? ['--- 日志尾部 ---', ...tail, ''] : [`日志: ${PATHS.logFile}`]), '', '完整日志: mihomo logs 0'],
    });
  }

  return { success: true, pid: finalPid, mode: 'tun' };
}
