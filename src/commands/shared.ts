import * as runtime from '../runtime.js';
import { CliError, extractStartOptions } from '../utils.js';
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

/** 要求 mihomo 处于运行中（保活看 launchd，普通看 pidFile），否则抛 CliError 并按模式给启动提示。 */
export function requireRunning(): void {
  const state = runtime.getRunningState();
  if (!state.running) {
    const hint = state.daemon ? 'mihomo daemon on' : 'mihomo start';
    throw new CliError(`mihomo 未运行，请先启动 (${hint})`);
  }
}

/**
 * 配置变更（切订阅、覆写开关）后，运行中则重启使之生效并返回 true；否则返回 false。
 * 保活恒 Mixed；普通保留当前模式（避免订阅残留 tun 字段误判）。透传用户显式启动选项（-s/-t 等）。
 */
export async function restartToApply(args: string[]): Promise<boolean> {
  if (!runtime.isRestartNeededOnChange()) return false;
  const currentMode = runtime.getRuntimeMode();
  console.log('');
  await cmdStart(['start', currentMode, ...extractStartOptions(args)]);
  return true;
}
