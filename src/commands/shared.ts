import readline from 'node:readline';
import { CliError } from '../errors.js';
import * as runtime from '../runtime.js';
import { extractStartOptions } from '../utils.js';
import { cmdStart } from './start.js';

/**
 * 命令层公共工具：收敛跨命令重复的守卫、分发与重启模式。
 * 依赖方向单向：shared → start/runtime；start 不反向 import shared（cleanupLegacyInstallOrThrow
 * 已移至 service.ts，此前它在 shared.ts 造成 shared ↔ start 循环依赖）。
 */

/** 子命令表条目：主名 + 可选别名 + handler（收到完整 argv，自取 args[2..]）。 */
export interface SubCommand {
  name: string;
  aliases?: string[];
  /** 一句话说明，供 shell 补全派生（completion.ts）；缺省补全只给词不给说明 */
  description?: string;
  handler: (args: string[]) => void | Promise<void>;
}

/** 已通过重复 token 校验的子命令表（按引用记忆，同一张表只在首次分发时校验一次） */
const validatedTables = new WeakSet<SubCommand[]>();

/**
 * 子命令表的重复 token 防护，与 registry 的 COMMAND_INDEX 同款判据：
 * 两个子命令撞主名/别名时，分发用的 `table.find` 静默取先注册者，后者永远不可达
 * 且无任何提示。表都是模块级常量，首次分发校验一次即可（等价于构建时一次），
 * 不在每次调用的热路径上重复扫描。
 *
 * 抛普通 Error 而非 CliError：表写错是代码 bug，不是用户输入错误（与 COMMAND_INDEX 一致）。
 */
function assertUniqueTokens(table: SubCommand[]): void {
  if (validatedTables.has(table)) return;
  const owner = new Map<string, string>();
  for (const cmd of table) {
    for (const token of [cmd.name, ...(cmd.aliases ?? [])]) {
      const prev = owner.get(token);
      if (prev !== undefined) {
        throw new Error(`子命令表存在重复 token: "${token}"（${prev} 与 ${cmd.name}）`);
      }
      owner.set(token, cmd.name);
    }
  }
  validatedTables.add(table);
}

/**
 * 子命令分发：按 args[1] 在表中匹配主名或别名，命中即调其 handler。
 * 无 action 时走 fallback；未知 action 必须交给 onUnknown 报错。
 */
export async function dispatchSubcommand(
  args: string[],
  table: SubCommand[],
  options: { fallback: (args: string[]) => void | Promise<void>; onUnknown: (action: string) => never },
): Promise<void> {
  assertUniqueTokens(table);
  const action = args[1];
  if (action) {
    const cmd = table.find(c => c.name === action || c.aliases?.includes(action));
    if (cmd) return cmd.handler(args);
    return options.onUnknown(action);
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
 * 配置变更（切订阅、覆写开关）后，运行中则按**当前实际在跑的模式**重启使之生效并返回
 * true；否则返回 false。TUN 在跑（即便服务已装）就按 TUN 重启，不静默切回 Mixed；
 * 服务在跑按 Mixed。透传用户显式启动选项（-s/-u 等）。
 */
export async function restartToApply(args: string[]): Promise<boolean> {
  const currentMode = runtime.restartModeOnChange();
  if (!currentMode) return false;
  console.log('');
  await cmdStart(['start', currentMode, ...extractStartOptions(args)]);
  return true;
}
