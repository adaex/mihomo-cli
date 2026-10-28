import fs from 'node:fs';
import path from 'node:path';

import { CliError } from './errors.js';
import { formatLocalTimestamp } from './format.js';
import { DIRS, PATHS } from './paths.js';
import type { LogList } from './types.js';

/**
 * mihomo-cli 日志文件的轮转、清理与列表。与进程启停解耦：
 * 启动时调 rotateAndCleanupLogs，log/logs 命令调 listLogs。
 */

const DEFAULT_LOG_RETENTION_DAYS = 7;

/** readLogTail 取末尾的最大行数 */
const LOG_TAIL_LINES = 15;

/**
 * 归档日志文件名的**唯一判据**：`mihomo.<yyyy-MM-dd_HH-mm-ss>[.<序号>].log`。
 *
 * 序号后缀由同秒二次轮转产生（`rotateLog` 与 `restartService` 的 copy-truncate 都会加），
 * 而「start 失败后立即重试」正是它最常出现的场景——也正是用户最需要翻日志的时候。
 * 清理（cleanupOldLogs）与列表（listLogs）必须共用本判据：只认序号的清理会把
 * `.N.log` 按时清掉却永远不进 `logs` 列表，用户拿不到它只能自己进目录翻。
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
  cleanupOldLogs();
}

/**
 * 读日志末尾若干行，用于把内核的失败原因直接呈现在错误里。
 *
 * 服务启动失败时，用户唯一能看到的线索就在这里（见 waitServiceHealthy——
 * 没有这道确认时用户只拿到一句谎报的「已启动」）。
 * 只读尾部 64KB：崩溃循环下日志可能很大，全量读入没有必要。
 */
export function readLogTail(): string[] {
  const TAIL_BYTES = 64 * 1024;
  let fd: number | null = null;
  try {
    const size = fs.statSync(PATHS.logFile).size;
    if (size === 0) return [];
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(PATHS.logFile, 'r');
    // 必须用实际读到的字节数切片：stat 与 read 之间日志可能被并发截断/轮转重建成
    // 更小的文件（copy-truncate、双终端 start），此时 read 返回 0 或短读，直接解码
    // 整块零填充 buffer 会把 NUL 字节打进错误提示的日志尾部
    const bytesRead = fs.readSync(fd, buf, 0, length, start);
    return buf
      .subarray(0, bytesRead)
      .toString('utf8')
      .split('\n')
      .map(l => l.trimEnd())
      .filter(l => l.length > 0)
      .slice(-LOG_TAIL_LINES);
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
 * 同秒序号的重试上限。正常并发（双终端 start、start + tun）至多烧掉个位数；
 * 到达上限说明 logs/ 里躺着上千个同一秒的归档——只有失控的循环轮转造得出来，
 * 按 CliError 报出来，不能无限换名。
 */
const MAX_ARCHIVE_SEQ = 1000;

/**
 * 分配一个归档路径并**原子占名**：默认 `mihomo.<时间戳>.log`，名字被占则追加序号。
 * 诊断事件复用同一原子占名原语，传入固定 prefix/extension；内核归档判据 ARCHIVE_LOG_RE 不变。
 *
 * 返回时该名字已被本进程以空占位文件占住（`openSync` 的 `wx`/O_EXCL）：两个进程同秒轮转时
 * existsSync 判否是 TOCTOU，后到者会静默覆盖先到者的归档。调用方随后的 rename/copy 直接
 * 盖掉占位即可；覆写失败残留的空归档随各自保留期清理。
 */
export function allocateArchivePath(prefix = 'mihomo', extension = 'log'): string {
  const timestamp = formatLocalTimestamp();
  for (let seq = 0; seq <= MAX_ARCHIVE_SEQ; seq++) {
    const name = seq === 0 ? `${prefix}.${timestamp}.${extension}` : `${prefix}.${timestamp}.${seq}.${extension}`;
    const archivePath = path.join(DIRS.logs, name);
    let fd: number | null = null;
    try {
      fd = fs.openSync(archivePath, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue; // 名字被占（并发进程或同秒既有归档），换下一个序号
      throw e;
    }
    try {
      fs.closeSync(fd);
    } catch {
      /* 名字已占住；关闭失败只是泄漏一个 fd，不影响轮转 */
    }
    return archivePath;
  }
  throw new CliError(`同一秒的归档序号已达上限 ${MAX_ARCHIVE_SEQ}，无法分配新的归档名`, {
    label: '日志轮转失败',
    hint: [`${DIRS.logs} 下存在大量同一时间戳的归档，通常由失控的循环轮转造成；请检查是否有脚本在反复触发 start/tun，确认后手动清理归档。`],
  });
}

/** 达到 minBytes 时 rename 到原子占名的归档；返回是否由本次调用完成轮转。 */
export function rotateFile(filePath: string, minBytes: number, prefix = 'mihomo', extension = 'log'): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    // 日志不存在，或恰好被并发轮转搬走（检查与 stat 之间被 rename）——都没有可轮转的内容
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  if (stat.size < minBytes) return false;

  const rotatedPath = allocateArchivePath(prefix, extension);
  try {
    // rename 对已存在目标是原子替换：直接盖掉分配时的空占位
    fs.renameSync(filePath, rotatedPath);
    return true;
  } catch (e) {
    // 覆写失败时回收占位，不留一个混进 logs 列表的空归档。最常见的 ENOENT 是
    // 并发轮转已把日志搬走：归档已由对方完成，本次无事可做，不能让并发的
    // start/tun 因此报错。
    try {
      fs.unlinkSync(rotatedPath);
    } catch {
      /* ignore */
    }
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function rotateLog(): void {
  rotateFile(PATHS.logFile, 1);
}

export function cleanupOldArchives(isArchive: (filename: string) => boolean): void {
  const logsDir = DIRS.logs;
  if (!fs.existsSync(logsDir)) return;

  const files = fs.readdirSync(logsDir);
  const now = Date.now();
  const maxAgeMs = DEFAULT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  for (const file of files) {
    if (!isArchive(file)) continue;

    try {
      const filePath = path.join(logsDir, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // 单个归档删不动（权限/并发删除）不挡其余清理
    }
  }
}

export function cleanupOldLogs(): void {
  cleanupOldArchives(isArchiveLogFilename);
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
