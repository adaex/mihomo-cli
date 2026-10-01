import fs from 'node:fs';
import { compareVersions } from 'compare-versions';
import { assertKnownFlags, assertPositionalCount } from './argv.js';
import { stderrColors } from './colors.js';
import { printCommandHelp, printShortHelp } from './commands/help.js';
import { allCommandTokens, findCommand } from './commands/registry.js';
import { printStatus } from './commands/status.js';
import { DEFAULT_MIXED_PORT, MIN_NODE_VERSION } from './constants.js';
import { CliError, errorMessage } from './errors.js';
import { isSilentSigint } from './lifecycle.js';
import { cleanupStaleTmpFiles, ensureDirs, PATHS } from './paths.js';
import { captureStopEpochBaseline } from './service.js';
import { suggestSimilar } from './suggest.js';
import { proxyEnvPointsAtSelf } from './system-proxy.js';

process.on('SIGINT', () => {
  // 走 stderr：status --json / config --json 探测期间按 Ctrl+C 时，stdout 必须保持
  // 可被 JSON 消费者整体解析，提示行不能混进正文
  if (!isSilentSigint()) {
    console.error('\n正在退出...');
  }
  process.exit(130);
});

process.on('SIGTERM', () => {
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

const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const;

/**
 * 在守卫与 ensureDirs **之前**取本机 Mixed 端口：不能建目录、不能因 settings 损坏抛错，
 * 故直接读 settings.json 原始 JSON，任何异常都回退默认端口。
 * 它只服务一个判断：env 代理是否恰好指向自己（见 clearProxyEnv）。
 */
function readSelfMixedPortEarly(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.settingsFile, 'utf8')) as { ports?: { mixed?: unknown } } | null;
    const mixed = raw?.ports?.mixed;
    if (typeof mixed === 'number' && Number.isInteger(mixed) && mixed >= 1 && mixed <= 65535) return mixed;
  } catch {
    // 文件不存在/损坏/非对象：用默认端口，不影响守卫之前不抛错的约束
  }
  return DEFAULT_MIXED_PORT;
}

/**
 * 只清除指向**本机 Mixed 端口**的代理环境变量，其余保留。
 *
 * 无差别清除会误伤：企业网络或国内环境里，npm/gh/curl 出网本身就依赖用户 shell 里
 * export 的 https_proxy（指向公司代理或别的工具）；清掉后 `mihomo-cli update`/`kernel`
 * 必然直连失败，而报错里没有任何代理线索。唯一必须清除的是「代理恰好是本工具自己」
 * 的死锁形态——下载经自己的端口，而重启会先停掉那个内核。
 */
function clearProxyEnv(): void {
  const selfPort = readSelfMixedPortEarly();
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key];
    if (value && proxyEnvPointsAtSelf(value, selfPort)) {
      delete process.env[key];
    }
  }
}

/**
 * root 守卫：以 `sudo mihomo-cli …` 运行会让所有服务操作静默失效，必须挡在最前面。
 *
 * 服务是**用户级 LaunchAgent**，域为 `gui/<uid>`。sudo 下 `process.getuid()` 是 0，
 * 域变成 `gui/0`——一个不存在的域，实测 launchctl 一律返回 **125**（`Bad request`），
 * 而不是「未找到」。后果全线静默：查询把 125 当「未装载」→ loaded/running 恒 false；
 * stop 的脚本吞掉 125 退 0 → CLI 报「已停止」而 KeepAlive 约 10s 后把内核拉回；
 * install 装到错误的域；disable 同样失败，自启也关不掉。
 *
 * 不做「读 SUDO_UID 回落到真实用户域」的自动降级：sudo 下 `HOME` 等环境变量是否保留
 * 取决于 sudoers 配置，静默改域只会让「数据目录用 root 的、服务装用户的」这类错位更难查。
 * 明确报错、让用户去掉 sudo 才是唯一不会出错的路径。
 *
 * TUN 自身豁免：`tun` 内部本就用 `sudo` 起内核（runSudoScript），但那是 CLI 自己按需
 * 提权，与用户在外面套一层 sudo 不同：后者会把整个 CLI 连同服务操作、数据目录写入
 * 一起变成 root 身份。
 */
/**
 * 守卫豁免命令：纯信息命令不碰服务、目录与提权，root 与非 macOS 下都安全。
 * （root 守卫与平台守卫共用同一份豁免名单——两者的豁免语义完全一致，没必要维护两张表）
 *
 * 名单同时决定 main() 是否跳过 ensureDirs：豁免免掉的是**副作用面**而不只是「拒绝」，
 * 否则 sudo mihomo-cli version 会在 /var/root、非 macOS 上的 mihomo-cli help 会在用户家目录
 * 建出一套用户永远看不到的数据目录。
 */
const GUARD_EXEMPT_COMMANDS = new Set(['help', 'version']);

function assertNotRoot(commandName: string): void {
  const uid = process.getuid?.();
  if (uid !== 0) return;
  if (GUARD_EXEMPT_COMMANDS.has(commandName)) return;

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
 * Node 版本守卫。`package.json` 的 `engines` 只让 npm 打一行 warn 就装上了——
 * 之后炸在某个语法或 API 上，报错跟真实原因（Node 太旧）毫无表面关联。
 *
 * 与平台守卫同族：明确失败优于「部分成功」。豁免名单共用——`version` 必须能跑，
 * 否则用户连「我装的是哪个版本」都问不出来；`help` 同理。
 *
 * `MIN_NODE_VERSION` 为 null（engines 写法不是 `>=x.y.z`）时跳过：不能因为声明格式变了
 * 就把所有命令挡死。比较用已有的 compare-versions，不自己写版本比较。
 */
function assertSupportedNodeVersion(commandName: string): void {
  if (!MIN_NODE_VERSION) return;
  if (GUARD_EXEMPT_COMMANDS.has(commandName)) return;
  const current = process.versions.node;
  if (compareVersions(current, MIN_NODE_VERSION) >= 0) return;
  throw new CliError(`Node 版本过低（当前 ${current}，需要 >= ${MIN_NODE_VERSION}）`, {
    label: 'Node 版本不支持',
    hint: ['升级 Node 后重试，例如:', '  brew upgrade node', '  或用 nvm: nvm install --lts && nvm use --lts', '', `当前解释器: ${process.execPath}`],
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
function assertSupportedPlatform(commandName: string): void {
  if (process.platform === 'darwin') return;
  if (GUARD_EXEMPT_COMMANDS.has(commandName)) return;
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
    assertSupportedNodeVersion('status');
    assertSupportedPlatform('status');
    assertNotRoot('status');
    ensureDirs();
    cleanupStaleTmpFiles();
    await printStatus();
    printShortHelp();
    return;
  }

  const token = args[0].toLowerCase();
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
  assertSupportedNodeVersion(command.name);
  assertSupportedPlatform(command.name);
  assertNotRoot(command.name);

  // 豁免命令连 ensureDirs 一起跳过：help/version 的读写都不经过数据目录
  //（printHelp 只读注册表与路径字符串，printVersion 只探测内核二进制），按名匹配
  // 已覆盖别名 token 与改写命令（改写只动 argv，不动豁免判定）
  if (!GUARD_EXEMPT_COMMANDS.has(command.name)) {
    ensureDirs();
    // 崩溃遗留的原子写临时文件（*.tmp）顺带清扫：幂等容错，只动超过 1 小时的旧残留。
    // 放守卫与豁免判定之后——豁免免掉的是副作用面（不建目录、不碰数据目录），
    // 清扫是删除动作，同样不该在守卫拒绝（旧平台/root）或 help/version 时执行
    cleanupStaleTmpFiles();
    // 捕获并发判定基线（stopEpochBaseline）：必须早于命令的一切慢速阶段与状态观察，
    // 命令入口是满足该约束的最早且唯一的公共点（D4）。纯读 epoch 文件，无副作用
    captureStopEpochBaseline();
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
