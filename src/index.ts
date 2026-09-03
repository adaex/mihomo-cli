import { colors } from './colors.js';
import { printShortHelp } from './commands/help.js';
import { allCommandTokens, findCommand } from './commands/registry.js';
import { printStatus } from './commands/status.js';
import { CliError } from './errors.js';
import { isSilentSigint, runCleanup } from './lifecycle.js';
import { ensureDirs } from './paths.js';
import { suggestSimilar } from './utils.js';

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

/**
 * 平台守卫：本工具的进程保活（launchd/LaunchDaemon）、目录与 UI 打开（open）、提权（sudo）
 * 全部为 macOS 专有实现，无其他平台后端。缺此守卫时非 macOS 会「部分成功」——
 * status/sub 看着正常，daemon on 输完 root 密码才在 /Library/LaunchDaemons 撞墙，
 * ui 报成功却什么都没打开（Linux 的 open 多指向 run-mailcap，会把 URL 当附件处理）。
 * 快速失败优于这种静默误行为。help/version 为纯信息命令，不受限。
 * MIHOMO_CLI_ALLOW_ANY_PLATFORM=1 可绕过，仅供在非 macOS 上开发调试。
 */
const PLATFORM_FREE_COMMANDS = new Set(['help', 'version']);

function assertSupportedPlatform(commandName: string): void {
  if (process.platform === 'darwin') return;
  if (PLATFORM_FREE_COMMANDS.has(commandName)) return;
  if (process.env.MIHOMO_CLI_ALLOW_ANY_PLATFORM === '1') return;
  throw new CliError(`mihomo-cli 目前仅支持 macOS（当前平台: ${process.platform}）`, {
    label: '平台不支持',
    hint: [
      '进程保活依赖 launchd、目录/UI 打开依赖 open、提权依赖 sudo，均无其他平台实现。',
      'Windows / Linux 适配仍在进行中。',
      '如需在非 macOS 上开发调试，可设 MIHOMO_CLI_ALLOW_ANY_PLATFORM=1（功能不保证可用）。',
    ],
  });
}

/**
 * v3.10.0 移除的顶层命令 → 引导文案。
 * 走单独一张表而非泛化的 did-you-mean：后者会把 `test` 猜成 `reset`（编辑距离 2），
 * 把想测速的用户指向一个删数据的命令，比不给建议更糟。
 */
const REMOVED_COMMANDS: Record<string, string[]> = {
  test: ['节点测速改用 Web 面板: mihomo ui（zash / metacubexd / yacd 均内置逐节点测延迟）', '自动选路请在订阅里配置 url-test 分组，由内核持续测速。'],
  clean: [
    '按测速结果删节点的功能已移除：一次抖动就可能永久改写订阅文件，误删只能重下订阅。',
    '失效节点交给内核的 url-test / fallback 分组自动绕开即可。',
    '',
    '查看节点延迟: mihomo ui',
  ],
};

async function main(): Promise<void> {
  clearProxyEnv();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    assertSupportedPlatform('status');
    ensureDirs();
    await printStatus();
    printShortHelp();
    return;
  }

  const token = args[0].toLowerCase();
  const command = findCommand(token);

  if (!command) {
    if (Object.hasOwn(REMOVED_COMMANDS, token)) {
      throw new CliError(`${token} 已移除（v3.10.0）`, { hint: REMOVED_COMMANDS[token] });
    }
    const suggestion = suggestSimilar(token, allCommandTokens());
    throw new CliError(`未知命令: ${token}`, {
      hint: [suggestion.length > 0 ? `是否想输入: ${suggestion.join(' / ')}?` : '使用 "mihomo help" 查看帮助'],
    });
  }

  // 守卫先于 ensureDirs：不支持的平台上不应在用户家目录留下数据目录
  assertSupportedPlatform(command.name);
  ensureDirs();

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
