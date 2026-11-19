import { assertKnownFlags, assertPositionalCount, getNonFlagArg, hasFlag, parseIntArg } from '../argv.js';
import { CliError } from '../errors.js';
import { formatBytes, formatDate } from '../format.js';
import { listLogs } from '../log-files.js';
import { openUrl, viewLogWithTail } from '../open.js';
import { PATHS } from '../paths.js';
import type { LogEntry } from '../types.js';

/** 编号类报错共用的用法提示（两处同款报错共用一份，改口径不漂移） */
const INVALID_INDEX_HINT = '用法: mihomo-cli logs <编号>（0=当前，1+=归档）；查看列表: mihomo-cli logs';

export function cmdLogs(args: string[]): void {
  assertKnownFlags(args, ['-f', '--follow', '-n', '--lines', '-o', '--open'], 'logs [-f] [-n N] [编号] [-o]');
  assertPositionalCount(args, 1, 1, 'mihomo-cli logs [-f] [-n N] [编号] [-o]');
  const lines = parseIntArg(args, '-n', '--lines', 100);
  const openInViewer = hasFlag(args, '-o', '--open');
  const follow = hasFlag(args, '-f', '--follow');
  // 除裸 logs 外，合法选项都用于查看日志，未给编号时看当前日志
  const positional = getNonFlagArg(args, 1);
  // 空串按显式提供处理（与 ui ""/sub update "" 同口径）：getNonFlagArg 对空串返回 '' 而非
  // null，下方 if (targetName) 会把它当缺省静默落列表——变量展开为空的笔误要有反馈
  if (positional === '') {
    throw new CliError('无效的日志编号 ""', { hint: INVALID_INDEX_HINT });
  }
  const targetName = positional ?? (args.length > 1 ? '0' : null);

  if (targetName) {
    // 只认「当前」与列表序号：归档名是 mihomo.<时间戳>.log，没人会去敲它，
    // 而支持按名/子串查找就得额外防路径穿越
    let logPath: string;

    if (targetName === '0') {
      logPath = PATHS.logFile;
    } else {
      const parsedIdx = parseInt(targetName, 10);
      if (Number.isNaN(parsedIdx) || parsedIdx < 1 || String(parsedIdx) !== targetName) {
        throw new CliError(`无效的日志编号 "${targetName}"`, { hint: INVALID_INDEX_HINT });
      }
      const archive = listLogs().archives[parsedIdx - 1];
      if (!archive) {
        throw new CliError(`未找到日志 "${targetName}"`, { hint: '使用 "mihomo-cli logs" 查看可用日志列表' });
      }
      logPath = archive.path;
    }

    if (openInViewer) {
      // -o 用系统查看器打开后即返回，tail 进程无处附身——静默忽略 -f 会让用户以为
      // 在跟随刷新。互斥显式报错，与「用户以为选项生效了」的红线一致
      if (follow) {
        throw new CliError('-o（系统查看器打开）与 -f（终端跟随）互斥', {
          hint: '跟随输出请去掉 -o: mihomo-cli logs 0 -f',
        });
      }
      console.log(`用系统默认程序打开: ${logPath}`);
      openUrl(logPath);
      return;
    }

    viewLogWithTail(logPath, { follow, lines });
    return;
  }

  const { current, archives } = listLogs();
  if (!current && archives.length === 0) {
    console.log('暂无内核日志');
    return;
  }

  console.log('');
  console.log('日志列表:');
  console.log('');

  const printEntry = (log: LogEntry, index: number) => {
    console.log(` ${String(index).padStart(2)}. ${log.name}${index === 0 ? ' (当前运行中)' : ''}`);
    console.log(`    时间: ${formatDate(log.mtime)}  大小: ${formatBytes(log.size)}`);
    console.log('');
  };
  if (current) printEntry(current, 0);
  for (const [i, log] of archives.entries()) printEntry(log, i + 1);

  console.log('用法:');
  console.log('  mihomo-cli logs 0          # 查看当前日志 (最后 100 行)');
  console.log('  mihomo-cli logs 0 -f       # 实时跟随当前日志');
  console.log('  mihomo-cli logs 1          # 查看第 1 个归档日志(最新)');
  console.log('  mihomo-cli logs 1 -n 200   # 查看 200 行');
  console.log('  mihomo-cli logs 1 -o       # 用系统默认程序打开');
  console.log('');
}
