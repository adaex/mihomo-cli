import * as processManager from '../process.js';
import type { LogEntry } from '../types.js';
import { formatBytes, formatDate, getNonFlagArg, hasFlag, parseIntArg } from '../utils.js';

export function cmdLog(args: string[]): void {
  const logPath = processManager.getLogPath();

  if (hasFlag(args, '-o', '--open')) {
    processManager.openLogFile(logPath);
    return;
  }

  processManager.viewLogWithTail(logPath, { follow: true, lines: 50 });
}

export function cmdLogs(args: string[]): void {
  const targetName = getNonFlagArg(args, 1);
  const lines = parseIntArg(args, '-n', '--lines', 100);
  const openInViewer = hasFlag(args, '-o', '--open');

  if (targetName) {
    let logPath: string | null;

    if (targetName === 'current' || targetName === '0') {
      logPath = processManager.getLogPath();
    } else {
      const parsedIdx = parseInt(targetName, 10);
      if (!Number.isNaN(parsedIdx) && parsedIdx > 0 && String(parsedIdx) === targetName) {
        const archiveLogs = processManager.listLogs();
        const archive = archiveLogs.archives[parsedIdx - 1];
        if (!archive) {
          console.error(`错误: 未找到日志 "${targetName}"`);
          console.log('使用 "mihomo logs" 查看可用日志列表');
          process.exit(1);
        }
        logPath = archive.path;
      } else {
        logPath = processManager.getLogPathByName(targetName);
      }
    }

    if (!logPath) {
      console.error(`错误: 未找到日志 "${targetName}"`);
      console.log('使用 "mihomo logs" 查看可用日志列表');
      process.exit(1);
    }

    if (openInViewer) {
      processManager.openLogFile(logPath);
      return;
    }

    processManager.viewLogWithTail(logPath, { follow: false, lines });
    return;
  }

  const logs = processManager.listLogs();
  const all: LogEntry[] = [];

  if (logs.current) all.push(logs.current);
  all.push(...logs.archives);

  if (all.length === 0) {
    console.log('暂无日志');
    return;
  }

  console.log('');
  console.log('日志列表:');
  console.log('');

  let archiveCounter = 0;
  for (const log of all) {
    let num: string;
    if (log.isCurrent) {
      num = ' 0';
    } else {
      archiveCounter++;
      num = archiveCounter < 10 ? ` ${archiveCounter}` : `${archiveCounter}`;
    }
    const time = formatDate(log.mtime);
    const size = formatBytes(log.size);
    const name = log.isCurrent ? 'mihomo.log (当前运行中)' : log.name;

    console.log(` ${num}. ${name}`);
    console.log(`    时间: ${time}  大小: ${size}`);
    if (!log.isCurrent) {
      console.log(`    查看: mihomo logs ${archiveCounter}  或  mihomo logs ${archiveCounter} -o`);
    }
    console.log('');
  }

  console.log('用法:');
  console.log('  mihomo logs 0          # 查看当前日志 (最后 100 行)');
  console.log('  mihomo logs 1          # 查看第 1 个归档日志（最新）');
  console.log('  mihomo logs 1 -n 200   # 查看 200 行');
  console.log('  mihomo logs 1 -o       # 用系统默认程序打开');
  console.log('');
}
