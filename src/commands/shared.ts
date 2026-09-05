import readline from 'node:readline';
import { CliError } from '../errors.js';
import { PATHS } from '../paths.js';
import * as runtime from '../runtime.js';
import { cleanupLegacySystemInstall } from '../service.js';
import { extractStartOptions } from '../utils.js';
import { cmdStart } from './start.js';

/**
 * 命令层公共工具：收敛跨命令重复的守卫、分发与重启模式。
 * 依赖方向单向：shared → start/runtime；start 不反向 import shared，无循环。
 */

/** 子命令表条目：主名 + 可选别名 + handler（收到完整 argv，自取 args[2..]）。 */
export interface SubCommand {
  name: string;
  aliases?: string[];
  handler: (args: string[]) => void | Promise<void>;
}

/**
 * 子命令分发：按 args[1] 在表中匹配主名或别名，命中即调其 handler。
 * 未命中时：无 action → 走 fallback；action 非空且提供 onUnknown → 交其处理（通常抛 CliError），
 * 未提供 onUnknown → 未知 action 也回落 fallback（如 ow/dir 的"任意参数都显示列表"语义）。
 */
export async function dispatchSubcommand(
  args: string[],
  table: SubCommand[],
  options: { fallback: (args: string[]) => void | Promise<void>; onUnknown?: (action: string) => void },
): Promise<void> {
  const action = args[1];
  if (action) {
    const cmd = table.find(c => c.name === action || c.aliases?.includes(action));
    if (cmd) return cmd.handler(args);
    if (options.onUnknown) return options.onUnknown(action);
  }
  return options.fallback(args);
}

/**
 * 交互确认（破坏性操作前的 y/N 询问）。非 TTY（管道/CI）下 stdin 无人应答，
 * 视为未确认（返回 false），由调用方给出「加 -y」的提示，避免脚本里静默挂住。
 */
export async function confirmPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question(`${question} (y/N) `, a => {
      rl.close();
      resolve(a);
    });
  });
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/**
 * 破坏性操作的确认入口，收敛 sub remove / reset 两处重复的
 * 「TTY 检查 → confirm → 非 TTY 抛错」样板。
 *
 * 非 TTY（管道/CI）下 stdin 无人应答：直接抛 CliError（退出码 1），
 * 而非「打印已取消却 exit 0」——后者会让脚本把「什么都没做」误判成执行成功。
 * TTY 下委托 confirmPrompt；返回 false 表示用户选了 No，由调用方打印
 * 「已取消」并 return（控制流留在调用方，helper 不替它做退出决策）。
 */
export async function confirmOrThrow(question: string, opts: { nonTtyMessage: string; hint?: string[] }): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CliError(opts.nonTtyMessage, { label: '已取消', hint: opts.hint });
  }
  return confirmPrompt(question);
}

/**
 * 配置变更（切订阅、覆写开关）后，运行中则重启使之生效并返回 true；否则返回 false。
 * 装了服务恒 Mixed；否则保留当前模式（避免订阅残留 tun 字段误判）。透传用户显式启动选项（-s/-u 等）。
 */
export async function restartToApply(args: string[]): Promise<boolean> {
  if (!runtime.isRestartNeededOnChange()) return false;
  const currentMode = runtime.getRuntimeMode();
  console.log('');
  await cmdStart(['start', currentMode, ...extractStartOptions(args)]);
  return true;
}

/**
 * 清理遗留 root LaunchDaemon（v3.0–v4.0 的 `daemon on` 装的），把 runSudoScript 的
 * 普通 Error（sudo 取消密码 / 非 TTY）包成 CliError——否则这类常规操作会带完整堆栈
 * 按「未预期错误」渲染。install / uninstall / stop / start(tun) / reset 共用。
 */
export function cleanupLegacyInstallOrThrow(): void {
  try {
    cleanupLegacySystemInstall();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, {
      label: '清理遗留服务失败',
      hint: ['也可手动清理:', `  sudo launchctl bootout system/$(basename ${PATHS.systemDaemonPlist} .plist)`, `  sudo rm -f ${PATHS.systemDaemonPlist}`],
    });
  }
}
