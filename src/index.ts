import fs from 'node:fs';
import { satisfies } from 'compare-versions';
import { assertKnownFlags, assertPositionalCount } from './argv.js';
import { stderrColors } from './colors.js';
import { printCommandHelp, printShortHelp } from './commands/help.js';
import { allCommandTokens, findCommand } from './commands/registry.js';
import { DEFAULT_MIXED_PORT, isValidPortNumber, NODE_ENGINES } from './constants.js';
import { CliError, errorMessage } from './errors.js';
import { isSilentSigint, terminateActiveChildren } from './lifecycle.js';
import { cleanupStaleTmpFiles, ensureDirs, PATHS } from './paths.js';
import { clearSelfProxyEnv, recordClearedProxyEnv } from './proxy-env.js';
import { captureStopEpochBaseline } from './stop-epoch.js';
import { suggestSimilar } from './suggest.js';

process.on('SIGINT', () => {
  terminateActiveChildren('SIGINT');
  // 走 stderr：status --json / config --json 探测期间按 Ctrl+C 时，stdout 必须保持
  // 可被 JSON 消费者整体解析，提示行不能混进正文
  if (!isSilentSigint()) {
    console.error('\n正在退出...');
  }
  process.exit(130);
});

process.on('SIGTERM', () => {
  terminateActiveChildren('SIGTERM');
  process.exit(143);
});

process.on('uncaughtException', (e: unknown) => {
  // 非 Error 抛出（throw 'str' 等）也要渲染出可用信息，与 unhandledRejection 的兜底口径对齐
  console.error(`\n未捕获的异常: ${errorMessage(e)}`);
  if (e instanceof Error && e.stack) {
    console.error(e.stack.split('\n').slice(1).join('\n'));
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error(`\n未处理的 Promise 拒绝: ${errorMessage(reason)}`);
  process.exit(1);
});

/** 在守卫与建目录前纯读 Mixed 端口；文件缺失、损坏或端口非法时回退默认值。 */
function readSelfMixedPortEarly(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.settingsFile, 'utf8')) as { ports?: { mixed?: unknown } } | null;
    const mixed = raw?.ports?.mixed;
    if (isValidPortNumber(mixed)) return mixed;
  } catch {
    // 这里只服务自指代理判断，不能让设置问题提前阻断命令
  }
  return DEFAULT_MIXED_PORT;
}

/** 只清指向本机 Mixed 的代理；进程内 fetch 与所有子进程因此看到同一份安全 env。 */
function clearProxyEnv(): void {
  const cleared = clearSelfProxyEnv(process.env, readSelfMixedPortEarly());
  if (Object.keys(cleared).length > 0) recordClearedProxyEnv(cleared);
}

/** 这两个顶层命令跳过入口检查、目录初始化和临时文件清扫；version 仍会探测已安装的内核 */
const GUARD_EXEMPT_COMMANDS = new Set(['help', 'version']);

function assertNotRoot(commandName: string): void {
  const uid = process.getuid?.();
  if (uid !== 0) return;

  throw new CliError('请不要用 sudo 运行 mihomo-cli', {
    label: '身份错误',
    hint: [
      '服务是用户级 LaunchAgent（域 gui/<uid>）。以 root 运行时域变成 gui/0，',
      'launchctl 一律返回 125，而所有服务操作都会把它当成「未装载」静默跳过——',
      'stop 会报「已停止」但内核被 KeepAlive 拉回来，install/start 则装到错误的域。',
      '',
      `请去掉 sudo 重试:  mihomo-cli ${commandName}`,
      '',
      'TUN 模式需要的 root 权限由 CLI 内部按需申请，无需在外层加 sudo。',
    ],
  });
}

/**
 * Node 版本守卫：`engines` 只让 npm 打一行 warn，之后炸在语法/API 上、报错与真实原因无关。
 * 判定与 pretest（scripts/check-node.mjs）同一写法：satisfies(当前, engines.node)。
 */
function assertSupportedNodeVersion(): void {
  if (!NODE_ENGINES) return;
  const current = process.versions.node;
  if (satisfies(current, NODE_ENGINES)) return;
  throw new CliError(`Node 版本过低（当前 ${current}，需要 ${NODE_ENGINES}）`, {
    label: 'Node 版本不支持',
    hint: ['升级 Node 后重试，例如:', '  brew upgrade node', '  或用 nvm: nvm install --lts && nvm use --lts', '', `当前解释器: ${process.execPath}`],
  });
}

/**
 * 平台守卫：本工具的 launchd 服务（LaunchAgent）、目录与 UI 打开（open）、提权（sudo）
 * 全部为 macOS 专有实现，无其他平台后端。缺此守卫时非 macOS 会「部分成功」——
 * status/sub 看着正常，install 才在 launchctl 撞墙，
 * ui 报成功却什么都没打开（Linux 的 open 多指向 run-mailcap，会把 URL 当附件处理）。
 * 快速失败优于这种静默误行为。help/version 为纯信息命令，不受限。
 * MIHOMO_CLI_ALLOW_ANY_PLATFORM=1 可绕过，仅供在非 macOS 上开发调试。
 */
function assertSupportedPlatform(): void {
  if (process.platform === 'darwin') return;
  if (process.env.MIHOMO_CLI_ALLOW_ANY_PLATFORM === '1') return;
  throw new CliError(`mihomo-cli 目前仅支持 macOS（当前平台: ${process.platform}）`, {
    label: '平台不支持',
    hint: [
      '服务托管依赖 launchd、目录/UI 打开依赖 open、提权依赖 sudo，均无其他平台实现。',
      'Windows / Linux 适配尚无时间表。',
      '如需在非 macOS 上开发调试，可设 MIHOMO_CLI_ALLOW_ANY_PLATFORM=1（功能不保证可用）。',
    ],
  });
}

async function main(): Promise<void> {
  clearProxyEnv();

  const args = process.argv.slice(2);

  const token = (args[0] ?? 'status').toLowerCase();
  const command = findCommand(token);

  if (!command) {
    const suggestion = suggestSimilar(token, allCommandTokens());
    throw new CliError(`未知命令: ${token}`, {
      hint: [suggestion.length > 0 ? `是否想输入: ${suggestion.join(' / ')}?` : '使用 "mihomo-cli help" 查看帮助'],
    });
  }

  // 守卫先于 ensureDirs：不支持的平台上不应在用户家目录留下数据目录，
  // root 下更不能——sudo 的 HOME 可能是 /var/root，会在那里建一套用户永远看不到的数据目录。
  // Node 版本排在最前：版本太旧时后面两个守卫自己都可能因语法/API 报出无关的错
  if (!GUARD_EXEMPT_COMMANDS.has(command.name)) {
    assertSupportedNodeVersion();
    assertSupportedPlatform();
    assertNotRoot(command.name);
    ensureDirs();
    cleanupStaleTmpFiles();
    // 捕获并发判定基线（stopEpochBaseline）：必须早于命令的一切慢速阶段与状态观察，
    // 命令入口是满足该约束的最早且唯一的公共点（D4）。纯读 epoch 文件，无副作用
    if (args.length > 0) captureStopEpochBaseline();
  }

  // meta 不接受选项；help 可带一个命令名（help <命令>），version 不带任何位置参数
  if (command.group === 'meta') {
    assertKnownFlags(args.slice(1), [], command.name);
    assertPositionalCount(args, command.name === 'help' ? 1 : 0, 1, `mihomo-cli ${command.name}`);
  }

  // 命令级帮助：`<命令> -h|--help|help` 是最自然的试法。在分发前统一拦截、
  // 渲染该命令自己的用法
  if (command.group !== 'meta' && (args[1] === '-h' || args[1] === '--help' || args[1] === 'help')) {
    printCommandHelp(command);
    return;
  }

  // rewrite 把顶层快捷命令(tun/use)映射为子命令形式;其余命令原样透传。
  await command.handler(command.rewrite ? command.rewrite(args) : args);
  if (args.length === 0) printShortHelp();
}

main().catch(e => {
  // 错误渲染走 stderr：设色按 stderr.isTTY 判定（`mihomo-cli status | grep x` 时
  // stdout 是管道而 stderr 仍是终端，共用 colors 会把错误输出一并剥色）
  if (e instanceof CliError) {
    console.error(`${stderrColors.red(`${e.label}:`)} ${e.message}`);
    for (const line of e.hint) console.error(line);
    process.exit(e.exitCode);
  }
  // 未预期错误 = bug：打印堆栈辅助定位（与 uncaughtException 处理器一致）
  console.error(`${stderrColors.red('错误:')} ${errorMessage(e)}`);
  if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(1).join('\n'));
  process.exit(1);
});
