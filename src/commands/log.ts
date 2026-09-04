import { CliError } from '../errors.js';
import { getLogPath, listLogs } from '../log-files.js';
import { openLogFile, viewLogWithTail } from '../open.js';
import type { LogEntry } from '../types.js';
import { formatBytes, formatDate, getNonFlagArg, hasFlag, parseIntArg } from '../utils.js';

export function cmdLog(args: string[]): void {
  const logPath = getLogPath();

  if (hasFlag(args, '-o', '--open')) {
    openLogFile(logPath);
    return;
  }

  viewLogWithTail(logPath, { follow: true, lines: 50 });
}

export function cmdLogs(args: string[]): void {
  const targetName = getNonFlagArg(args, 1);
  const lines = parseIntArg(args, '-n', '--lines', 100);
  const openInViewer = hasFlag(args, '-o', '--open');

  if (targetName) {
    // 只认「当前」与列表序号：归档名是 mihomo.<时间戳>.log，没人会去敲它，
    // 而支持按名/子串查找就得额外防路径穿越（历史上确实为此加过 isPathUnderDir）
    let logPath: string;

    if (targetName === '0') {
      logPath = getLogPath();
    } else {
      const parsedIdx = parseInt(targetName, 10);
      if (Number.isNaN(parsedIdx) || parsedIdx < 1 || String(parsedIdx) !== targetName) {
        throw new CliError(`无效的日志编号 "${targetName}"`, { hint: '用法: mihomo logs <编号>（0=当前，1+=归档）；查看列表: mihomo logs' });
      }
      const archive = listLogs().archives[parsedIdx - 1];
      if (!archive) {
        throw new CliError(`未找到日志 "${targetName}"`, { hint: '使用 "mihomo logs" 查看可用日志列表' });
      }
      logPath = archive.path;
    }

    if (openInViewer) {
      openLogFile(logPath);
      return;
    }

    viewLogWithTail(logPath, { follow: false, lines });
    return;
  }

  const logs = listLogs();
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
