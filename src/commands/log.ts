import { assertKnownFlags, assertPositionalCount, getNonFlagArg, hasFlag, parseIntArg } from '../argv.js';
import { CliError } from '../errors.js';
import { matchValueFlagToken } from '../flags.js';
import { formatBytes, formatDate } from '../format.js';
import { getLogPath, listLogs } from '../log-files.js';
import { openLogFile, viewLogWithTail } from '../open.js';
import type { LogEntry } from '../types.js';

export function cmdLogs(args: string[]): void {
  assertKnownFlags(args, ['-f', '--follow', '-n', '--lines', '-o', '--open'], 'logs [-f] [-n N] [编号] [-o]');
  // 编号至多一个：`logs 1 2` 此前静默忽略 2
  assertPositionalCount(args, 1, 1, 'mihomo-cli logs [-f] [-n N] [编号] [-o]');
  const lines = parseIntArg(args, '-n', '--lines', 100);
  const openInViewer = hasFlag(args, '-o', '--open');
  const follow = hasFlag(args, '-f', '--follow');
  // 编号省略但给了查看类选项时默认看当前日志：`logs -f` / `logs -n 200` / `logs -o`
  // 的意图明确是「看日志」，落到列表分支等于选项静默失效——
  // `logs -f` 是跟随当前日志的自然写法，不能无声无息地只打印列表
  // -n 的三种形式判定与白名单/解析共用 matchValueFlagToken，不再本地手写
  const hasLinesFlag = args.some(a => matchValueFlagToken(a)?.spec.forms.includes('-n') === true);
  const positional = getNonFlagArg(args, 1);
  // 空串按显式提供处理（与 ui ""/sub update "" 同口径）：getNonFlagArg 对空串返回 '' 而非
  // null，下方 if (targetName) 会把它当缺省静默落列表——变量展开为空的笔误要有反馈
  if (positional === '') {
    throw new CliError('无效的日志编号 ""', { hint: '用法: mihomo-cli logs <编号>（0=当前，1+=归档）；查看列表: mihomo-cli logs' });
  }
  const targetName = positional ?? (follow || openInViewer || hasLinesFlag ? '0' : null);

  if (targetName) {
    // 只认「当前」与列表序号：归档名是 mihomo.<时间戳>.log，没人会去敲它，
    // 而支持按名/子串查找就得额外防路径穿越
    let logPath: string;

    if (targetName === '0') {
      logPath = getLogPath();
    } else {
      const parsedIdx = parseInt(targetName, 10);
      if (Number.isNaN(parsedIdx) || parsedIdx < 1 || String(parsedIdx) !== targetName) {
        throw new CliError(`无效的日志编号 "${targetName}"`, { hint: '用法: mihomo-cli logs <编号>（0=当前，1+=归档）；查看列表: mihomo-cli logs' });
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
      openLogFile(logPath);
      return;
    }

    viewLogWithTail(logPath, { follow, lines });
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
      console.log(`    查看: mihomo-cli logs ${archiveCounter}  或  mihomo-cli logs ${archiveCounter} -o`);
    }
    console.log('');
  }

  console.log('用法:');
  console.log('  mihomo-cli logs 0          # 查看当前日志 (最后 100 行)');
  console.log('  mihomo-cli logs 0 -f       # 实时跟随当前日志');
  console.log('  mihomo-cli logs 1          # 查看第 1 个归档日志(最新)');
  console.log('  mihomo-cli logs 1 -n 200   # 查看 200 行');
  console.log('  mihomo-cli logs 1 -o       # 用系统默认程序打开');
  console.log('');
}
