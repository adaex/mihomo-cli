import fs from 'node:fs';
import path from 'node:path';

import { DIRS, PATHS } from './paths.js';
import type { LogList } from './types.js';
import { formatLocalTimestamp } from './utils.js';

/**
 * mihomo 日志文件的轮转、清理与列表。与进程启停解耦：
 * 启动时调 rotateAndCleanupLogs，log/logs 命令调 listLogs/getLogPath。
 */

const DEFAULT_LOG_RETENTION_DAYS = 7;

export function rotateAndCleanupLogs(): void {
  rotateLog();
  cleanupOldLogs(DEFAULT_LOG_RETENTION_DAYS);
}

export function getLogPath(): string {
  return PATHS.logFile;
}

function rotateLog(): string | null {
  const logFile = PATHS.logFile;
  if (!fs.existsSync(logFile)) return null;

  const stat = fs.statSync(logFile);
  if (stat.size === 0) return null;

  const rotatedName = `mihomo.${formatLocalTimestamp()}.log`;
  const rotatedPath = path.join(DIRS.logs, rotatedName);

  fs.renameSync(logFile, rotatedPath);
  return rotatedPath;
}

export function cleanupOldLogs(maxAgeDays = DEFAULT_LOG_RETENTION_DAYS): { deleted: number; errors: number } {
  const logsDir = DIRS.logs;
  if (!fs.existsSync(logsDir)) return { deleted: 0, errors: 0 };

  const files = fs.readdirSync(logsDir);
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  let deleted = 0;
  let errors = 0;

  for (const file of files) {
    if (!file.match(/^mihomo\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/)) continue;

    try {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {
      errors++;
    }
  }

  return { deleted, errors };
}

export function listLogs(): LogList {
  const logsDir = DIRS.logs;
  const result: LogList = { current: null, archives: [] };

  if (fs.existsSync(PATHS.logFile)) {
    const stat = fs.statSync(PATHS.logFile);
    result.current = {
      name: 'mihomo.log (当前)',
      path: PATHS.logFile,
      size: stat.size,
      mtime: stat.mtime,
      isCurrent: true,
    };
  }

  if (!fs.existsSync(logsDir)) return result;

  const files = fs.readdirSync(logsDir);
  for (const file of files) {
    const match = file.match(/^mihomo\.(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.log$/);
    if (!match) continue;

    try {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      result.archives.push({
        name: file,
        path: filePath,
        size: stat.size,
        mtime: stat.mtime,
        isCurrent: false,
      });
    } catch {
      // ignore
    }
  }

  result.archives.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return result;
}
