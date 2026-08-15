import { printShortHelp } from './commands/help.js';
import { findCommand } from './commands/registry.js';
import { printStatus } from './commands/status.js';
import { isSilentSigint, runCleanup } from './lifecycle.js';
import { ensureDirs } from './paths.js';
import { CliError, colors } from './utils.js';

process.on('SIGINT', () => {
  if (!isSilentSigint()) {
    console.log('\n正在退出...');
  }
  runCleanup();
  process.exit(130);
});

process.on('SIGTERM', () => {
  runCleanup();
  process.exit(143);
});

process.on('uncaughtException', (e: Error) => {
  console.error(`\n未捕获的异常: ${e.message}`);
  if (e.stack) {
    console.error(e.stack.split('\n').slice(1).join('\n'));
  }
  runCleanup();
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`\n未处理的 Promise 拒绝: ${msg}`);
  runCleanup();
  process.exit(1);
});

function clearProxyEnv(): void {
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.all_proxy;
  delete process.env.ALL_PROXY;
}

async function main(): Promise<void> {
  clearProxyEnv();
  ensureDirs();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    printStatus();
    printShortHelp();
    return;
  }

  const token = args[0].toLowerCase();
  const command = findCommand(token);

  if (!command) {
    throw new CliError(`未知命令: ${token}`, { hint: '使用 "mihomo help" 查看帮助' });
  }

  // rewrite 把顶层快捷命令(tun/use/on/off/open)映射为子命令形式;其余命令原样透传。
  await command.handler(command.rewrite ? command.rewrite(args) : args);
}

main().catch(e => {
  if (e instanceof CliError) {
    console.error(`${colors.red(`${e.label}:`)} ${e.message}`);
    for (const line of e.hint) console.error(line);
    runCleanup();
    process.exit(e.exitCode);
  }
  // 未预期错误 = bug：打印堆栈辅助定位（与 uncaughtException 处理器一致）
  const err = e as Error;
  console.error(`${colors.red('错误:')} ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1).join('\n'));
  runCleanup();
  process.exit(1);
});
