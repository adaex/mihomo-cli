import { cmdBench } from './commands/bench.js';
import { cmdDirectory } from './commands/directory.js';
import { printHelp, printShortHelp, printVersion } from './commands/help.js';
import { cmdKernel } from './commands/kernel.js';
import { cmdLog, cmdLogs } from './commands/log.js';
import { cmdOverwrite } from './commands/overwrite.js';
import { cmdReset } from './commands/reset.js';
import { cmdStart } from './commands/start.js';
import { printStatus } from './commands/status.js';
import { cmdStop } from './commands/stop.js';
import { cmdSubscription } from './commands/subscription.js';
import { cmdUI } from './commands/ui.js';
import { cmdUpdate } from './commands/update.js';
import { ensureDirs } from './paths.js';

let exiting = false;

process.on('SIGINT', () => {
  if (exiting) {
    console.log('\n强制退出');
    process.exit(1);
  }
  exiting = true;
  console.log('\n正在退出...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('uncaughtException', (e: Error) => {
  console.error(`\n未捕获的异常: ${e.message}`);
  if (e.stack) {
    console.error(e.stack.split('\n').slice(1).join('\n'));
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`\n未处理的 Promise 拒绝: ${msg}`);
  process.exit(1);
});

async function main(): Promise<void> {
  ensureDirs();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    printStatus();
    printShortHelp();
    return;
  }

  const cmd = args[0].toLowerCase();

  if (['help', '-h', '--help'].includes(cmd)) {
    printHelp();
    return;
  }
  if (['version', '-v', '--version'].includes(cmd)) {
    printVersion();
    return;
  }

  switch (cmd) {
    case 'up':
    case 'start':
      await cmdStart(args);
      break;
    case 'tun':
      await cmdStart(['start', 'tun']);
      break;
    case 'down':
    case 'stop':
      await cmdStop();
      break;
    case 'status':
      printStatus();
      break;
    case 'log':
      cmdLog(args);
      break;
    case 'logs':
      cmdLogs(args);
      break;
    case 'open':
      cmdDirectory(['dir', 'open', ...args.slice(1)]);
      break;
    case 'ui':
      cmdUI(args);
      break;
    case 'kernel':
      await cmdKernel(args);
      break;
    case 'upd':
    case 'update':
    case 'upgrade':
      await cmdUpdate();
      break;
    case 'use':
      await cmdSubscription(['sub', 'use', ...args.slice(1)]);
      break;
    case 'sub':
    case 'subscription':
    case 'subscriptions':
      await cmdSubscription(args);
      break;
    case 'dir':
    case 'dirs':
    case 'directory':
    case 'directories':
      cmdDirectory(args);
      break;
    case 'reset':
      await cmdReset(args);
      break;
    case 'on':
      await cmdOverwrite(['ow', 'on']);
      break;
    case 'off':
      await cmdOverwrite(['ow', 'off']);
      break;
    case 'ow':
    case 'overwrite':
      await cmdOverwrite(args);
      break;
    case 'bench':
      await cmdBench(args);
      break;
    default:
      console.error(`未知命令: ${cmd}`);
      console.error('使用 "mihomo help" 查看帮助');
      process.exit(1);
  }
}

main().catch(e => {
  console.error(`错误: ${(e as Error).message}`);
  process.exit(1);
});
