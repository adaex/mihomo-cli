import { printShortHelp } from './commands/help.js';
import { findCommand } from './commands/registry.js';
import { printStatus } from './commands/status.js';
import { runCleanup } from './lifecycle.js';
import { ensureDirs } from './paths.js';

process.on('SIGINT', () => {
  console.log('\n正在退出...');
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
    console.error(`未知命令: ${token}`);
    console.error('使用 "mihomo help" 查看帮助');
    process.exit(1);
  }

  // rewrite 把顶层快捷命令(tun/use/on/off/open)映射为子命令形式;其余命令原样透传。
  await command.handler(command.rewrite ? command.rewrite(args) : args);
}

main().catch(e => {
  console.error(`错误: ${(e as Error).message}`);
  runCleanup();
  process.exit(1);
});
