import { colors } from './colors.js';
import { printShortHelp } from './commands/help.js';
import { allCommandTokens, findCommand } from './commands/registry.js';
import { printStatus } from './commands/status.js';
import { CliError } from './errors.js';
import { isSilentSigint } from './lifecycle.js';
import { ensureDirs } from './paths.js';
import { suggestSimilar } from './utils.js';

process.on('SIGINT', () => {
  if (!isSilentSigint()) {
    console.log('\n正在退出...');
  }
  process.exit(130);
});

process.on('SIGTERM', () => {
  process.exit(143);
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

function clearProxyEnv(): void {
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.all_proxy;
  delete process.env.ALL_PROXY;
}

/**
 * root 守卫：以 `sudo mihomo …` 运行会让所有服务操作静默失效，必须挡在最前面。
 *
 * 服务是**用户级 LaunchAgent**，域为 `gui/<uid>`。sudo 下 `process.getuid()` 是 0，
 * 于是域变成 `gui/0`——一个不存在的域，实测 launchctl 一律返回 **125**（`Bad request`），
 * 而不是「未找到」。后果全线静默（v4.2.2 实测）：
 *
 * - `runLaunchctl` 把 125 与「未装载」一视同仁 → `loaded/running` 恒 false
 * - `stopService` 的每条命令都带 `|| true`，125 被吞，脚本退 0 → CLI 报「已停止」
 * - 实际只有 `killResidualKernels()` 生效，而 plist 的 `KeepAlive` 是 true —— 实测约 10s
 *   节流后 launchd 把内核拉了回来（pid 变化可见）。用户看到的是「停了一下又活了」，
 *   且自启也没关掉（`disable` 同样失败）
 *
 * 不做「读 SUDO_UID 回落到真实用户域」的自动降级：sudo 下 `HOME` 等环境变量是否保留
 * 取决于 sudoers 配置，静默改域只会让「数据目录用 root 的、服务装用户的」这类错位更难查。
 * 明确报错、让用户去掉 sudo 才是唯一不会出错的路径。
 *
 * 豁免纯信息命令，以及 TUN 自身——`tun` 内部本就用 `sudo` 起内核（`runSudoScript`），
 * 但那是 CLI 自己按需提权，与用户在外面套一层 sudo 不同：后者会把整个 CLI 连同
 * 服务操作、数据目录写入一起变成 root 身份。
 */
const ROOT_ALLOWED_COMMANDS = new Set(['help', 'version']);

function assertNotRoot(commandName: string): void {
  const uid = process.getuid?.();
  if (uid !== 0) return;
  if (ROOT_ALLOWED_COMMANDS.has(commandName)) return;

  throw new CliError('请不要用 sudo 运行 mihomo', {
    label: '身份错误',
    hint: [
      '服务是用户级 LaunchAgent（域 gui/<uid>）。以 root 运行时域变成 gui/0，',
      'launchctl 一律返回 125，而所有服务操作都会把它当成「未装载」静默跳过——',
      'stop 会报「已停止」但内核被 KeepAlive 拉回来，install/start 则装到错误的域。',
      '',
      `请去掉 sudo 重试:  mihomo ${commandName}`,
      '',
      'TUN 模式需要的 root 权限由 CLI 内部按需申请，无需在外层加 sudo。',
    ],
  });
}

/**
 * 平台守卫：本工具的 launchd 服务（LaunchAgent/LaunchDaemon）、目录与 UI 打开（open）、提权（sudo）
 * 全部为 macOS 专有实现，无其他平台后端。缺此守卫时非 macOS 会「部分成功」——
 * status/sub 看着正常，install 才在 launchctl 撞墙，
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
      '服务托管依赖 launchd、目录/UI 打开依赖 open、提权依赖 sudo，均无其他平台实现。',
      'Windows / Linux 适配仍在进行中。',
      '如需在非 macOS 上开发调试，可设 MIHOMO_CLI_ALLOW_ANY_PLATFORM=1（功能不保证可用）。',
    ],
  });
}

async function main(): Promise<void> {
  clearProxyEnv();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    assertSupportedPlatform('status');
    assertNotRoot('status');
    ensureDirs();
    await printStatus();
    printShortHelp();
    return;
  }

  const token = args[0].toLowerCase();
  const command = findCommand(token);

  if (!command) {
    const suggestion = suggestSimilar(token, allCommandTokens());
    throw new CliError(`未知命令: ${token}`, {
      hint: [suggestion.length > 0 ? `是否想输入: ${suggestion.join(' / ')}?` : '使用 "mihomo help" 查看帮助'],
    });
  }

  // 守卫先于 ensureDirs：不支持的平台上不应在用户家目录留下数据目录，
  // root 下更不能——sudo 的 HOME 可能是 /var/root，会在那里建一套用户永远看不到的数据目录
  assertSupportedPlatform(command.name);
  assertNotRoot(command.name);
  ensureDirs();

  // rewrite 把顶层快捷命令(tun/use/on/off/open)映射为子命令形式;其余命令原样透传。
  await command.handler(command.rewrite ? command.rewrite(args) : args);
}

main().catch(e => {
  if (e instanceof CliError) {
    console.error(`${colors.red(`${e.label}:`)} ${e.message}`);
    for (const line of e.hint) console.error(line);
    process.exit(e.exitCode);
  }
  // 未预期错误 = bug：打印堆栈辅助定位（与 uncaughtException 处理器一致）
  const err = e as Error;
  console.error(`${colors.red('错误:')} ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1).join('\n'));
  process.exit(1);
});
