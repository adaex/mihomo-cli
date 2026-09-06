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

/**
 * 归档日志文件名的**唯一判据**：`mihomo.<yyyy-MM-dd_HH-mm-ss>[.<序号>].log`。
 *
 * 序号后缀由同秒二次轮转产生（`rotateLog` 与 `restartService` 的 copy-truncate 都会加），
 * 而「start 失败后立即重试」正是它最常出现的场景——也正是用户最需要翻日志的时候。
 *
 * 此前 cleanupOldLogs 与 listLogs 各写一份正则，只有前者认序号后缀：于是 `.N.log`
 * 会被按时清理（不堆积），却永远不出现在 `logs` 列表里 → `logs <编号>` 拿不到它，
 * 用户只能自己进目录翻。判据收成一份，两边不可能再漂移。
 *
 * 捕获组 1 是时间戳（listLogs 不用，但保留以便按时间解析）。
 */
const ARCHIVE_LOG_RE = /^mihomo\.(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:\.\d+)?\.log$/;

/** 是否为归档日志文件名（清理与列表共用同一判据） */
export function isArchiveLogFilename(filename: string): boolean {
  return ARCHIVE_LOG_RE.test(filename);
}

export function rotateAndCleanupLogs(): void {
  rotateLog();
  cleanupOldLogs(DEFAULT_LOG_RETENTION_DAYS);
}

export function getLogPath(): string {
  return PATHS.logFile;
}

/**
 * 读日志末尾若干行，用于把内核的失败原因直接呈现在错误里。
 *
 * 服务启动失败时，用户唯一能看到的线索就在这里（TUN 的 sudo 脚本本就 `tail -25`，
 * 服务路径此前什么都不给，只报一句「已启动」——见 waitServiceHealthy）。
 * 只读尾部 64KB：崩溃循环下日志可能很大，全量读入没有必要。
 */
export function readLogTail(maxLines = 15): string[] {
  const TAIL_BYTES = 64 * 1024;
  let fd: number | null = null;
  try {
    const size = fs.statSync(PATHS.logFile).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(PATHS.logFile, 'r');
    fs.readSync(fd, buf, 0, length, start);
    return buf
      .toString('utf8')
      .split('\n')
      .map(l => l.trimEnd())
      .filter(l => l.length > 0)
      .slice(-maxLines);
  } catch {
    // 日志不存在/不可读都不是要报的错——调用方本就在报另一个失败
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 分配一个尚未占用的归档路径：`mihomo.<时间戳>.log`，已存在则追加序号。
 *
 * 同一秒内两次轮转（start 失败后立即重试、tun 紧接 start）会互相覆盖归档——
 * POSIX rename 与 copyFileSync 都静默覆盖已存在文件。加序号后缀避免丢日志。
 *
 * 导出供 service.ts 的 copy-truncate 轮转复用（运行中不能 rename，见 restartService）：
 * 此前两处各写一份同样的 while 循环，命名规则漂移就会让归档被静默覆盖或列不出来。
 */
export function allocateArchivePath(): string {
  const timestamp = formatLocalTimestamp();
  let archivePath = path.join(DIRS.logs, `mihomo.${timestamp}.log`);
  let seq = 1;
  while (fs.existsSync(archivePath)) {
    archivePath = path.join(DIRS.logs, `mihomo.${timestamp}.${seq}.log`);
    seq++;
  }
  return archivePath;
}

function rotateLog(): string | null {
  const logFile = PATHS.logFile;
  if (!fs.existsSync(logFile)) return null;

  const stat = fs.statSync(logFile);
  if (stat.size === 0) return null;

  const rotatedPath = allocateArchivePath();
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
    if (!isArchiveLogFilename(file)) continue;

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
    if (!isArchiveLogFilename(file)) continue;

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
