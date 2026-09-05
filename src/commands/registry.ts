import { cmdCompletion } from './completion.js';
import { cmdDirectory } from './directory.js';
import { cmdDoctor } from './doctor.js';
import { printHelp, printVersion } from './help.js';
import { cmdKernel } from './kernel.js';
import { cmdLogs } from './log.js';
import { cmdOverwrite } from './overwrite.js';
import { removedCommand } from './removed.js';
import { cmdReset } from './reset.js';
import { cmdInstall, cmdUninstall } from './service.js';
import { cmdStart } from './start.js';
import { printStatus } from './status.js';
import { cmdStop } from './stop.js';
import { cmdSubscription } from './subscription.js';
import { cmdUI } from './ui.js';
import { cmdUpdate } from './update.js';

type Handler = (args: string[]) => void | Promise<void>;

export type CommandGroup = 'control' | 'interface' | 'subscription' | 'config' | 'system' | 'meta';

/**
 * 一条帮助用法行：命令签名与说明分开存放。
 *
 * **不要合成一个字符串**：合成后对齐只能靠手写空格，加命令或改签名长度就会错位
 * （历史上「控制」组与其余组的说明列曾分别落在第 34 与第 30 列，
 * `subscription add <url> [name]` 更是直接溢出）。分开后由 printHelp
 * 按当前最长签名统一 padEnd，对齐永远自洽。
 */
export interface UsageLine {
  signature: string;
  description: string;
}

export interface Command {
  /** 主名(全称单数),用于展示与去重 */
  name: string;
  /** 除主名外接受的其他 token(简写、复数、快捷别名、flag 形式) */
  aliases: string[];
  handler: Handler;
  /**
   * argv 改写:把顶层快捷命令映射为子命令形式再交给 handler。
   * 如 `tun` → `['start','tun',...rest]`。默认恒等(handler 直接收原始 argv)。
   */
  rewrite?: (args: string[]) => string[];
  /** 帮助分组;meta(help/version)不在分组清单中展示 */
  group: CommandGroup;
  /** 该命令在帮助中的用法行(单一真相源);空数组表示不单独列出(如纯别名 open/on/off) */
  usage: UsageLine[];
  /**
   * 隐藏命令：不参与 shell 补全词表（墓碑命令、纯过渡别名）。
   * 帮助是否展示由 usage 是否为空决定，与此标记正交。
   */
  hidden?: boolean;
}

/**
 * 命令注册表:index.ts 的唯一分发来源,help 的命令清单也由此生成。
 * 新增命令只需在此加一条(name + aliases + handler + usage),路由与帮助自动生效。
 */
export const COMMANDS: Command[] = [
  // === 控制 ===
  {
    name: 'install',
    aliases: [],
    handler: cmdInstall,
    group: 'control',
    usage: [{ signature: 'install', description: '安装服务（Mixed 模式的前置，只需一次）' }],
  },
  {
    name: 'start',
    aliases: ['restart'],
    handler: cmdStart,
    group: 'control',
    usage: [{ signature: 'start [tun|mixed] [-s] [-u ms]', description: '启动代理并开启登录自启（默认 mixed；= 重启）' }],
  },
  {
    name: 'tun',
    aliases: [],
    handler: cmdStart,
    rewrite: args => ['start', 'tun', ...args.slice(1)],
    group: 'control',
    usage: [],
  },
  {
    name: 'stop',
    aliases: [],
    handler: cmdStop,
    group: 'control',
    usage: [{ signature: 'stop', description: '停止代理并关闭登录自启' }],
  },
  {
    name: 'uninstall',
    aliases: [],
    handler: cmdUninstall,
    group: 'control',
    usage: [{ signature: 'uninstall', description: '卸载服务' }],
  },
  {
    name: 'status',
    aliases: [],
    handler: printStatus,
    group: 'control',
    usage: [{ signature: 'status [-j|--json] [--no-probe]', description: '查看状态' }],
  },
  // === 已移除（墓碑：显式报错指引迁移，不在帮助中列出） ===
  {
    name: 'daemon',
    aliases: [],
    handler: removedCommand('daemon', 'v4.1.0', [
      '保活已成为 Mixed 模式的唯一运行方式，改用服务命令族：',
      '  mihomo daemon on   →  mihomo install（一次）+ mihomo start',
      '  mihomo daemon off  →  mihomo stop（停止并关闭自启）',
      '  mihomo daemon      →  mihomo status',
      '',
      '彻底移除服务: mihomo uninstall',
    ]),
    group: 'meta',
    usage: [],
    hidden: true,
  },
  {
    name: 'up',
    aliases: [],
    handler: removedCommand('up', 'v4.1.0', ['请用: mihomo start']),
    group: 'meta',
    usage: [],
    hidden: true,
  },
  {
    name: 'down',
    aliases: [],
    handler: removedCommand('down', 'v4.1.0', ['请用: mihomo stop']),
    group: 'meta',
    usage: [],
    hidden: true,
  },
  // === 界面 ===
  {
    name: 'ui',
    aliases: [],
    handler: cmdUI,
    group: 'interface',
    usage: [{ signature: 'ui [zash|dash|yacd]', description: '打开 Web UI（默认 zash）' }],
  },
  {
    // 已并入 `logs -f`；保留为隐藏别名过渡，不在帮助中列出（usage 留空），也不进补全词表
    name: 'log',
    aliases: [],
    handler: cmdLogs,
    // 隐藏别名：log = logs 0 -f。用户传了编号时尊重编号（log 1 = logs 1 -f），
    // 而非恒为 0——此前编号被 '0' 顶掉，log 1 跟随的是当前日志而非归档 1
    rewrite: args => {
      const hasNum = args[1] !== undefined && /^\d+$/.test(args[1]);
      const num = hasNum ? args[1] : '0';
      const rest = hasNum ? args.slice(2) : args.slice(1);
      return ['logs', num, '-f', ...rest];
    },
    group: 'interface',
    usage: [],
    hidden: true,
  },
  {
    name: 'logs',
    aliases: [],
    handler: cmdLogs,
    group: 'interface',
    usage: [{ signature: 'logs [-f] [-n N] [编号] [-o]', description: '日志列表/查看（0=当前，1+=归档，-f 跟随；省略编号即当前）' }],
  },
  // === 订阅 ===
  {
    // 顶层快捷方式：`mihomo use <name>` = `mihomo subscription use <name>`（与 tun 同范式）
    name: 'use',
    aliases: [],
    handler: cmdSubscription,
    rewrite: args => ['subscription', 'use', ...args.slice(1)],
    group: 'subscription',
    usage: [{ signature: 'use <name>', description: '切换订阅（subscription use 快捷方式，自动重启）' }],
  },
  {
    name: 'subscription',
    aliases: ['sub', 'subs', 'subscriptions'],
    handler: cmdSubscription,
    group: 'subscription',
    usage: [
      { signature: 'subscription', description: '列出所有订阅（别名 sub/subs）' },
      { signature: 'subscription use <name>', description: '切换当前订阅' },
      { signature: 'subscription add <url> [name]', description: '添加订阅' },
      { signature: 'subscription update [name]', description: '更新订阅（无参更新所有）' },
      { signature: 'subscription remove <name>', description: '删除订阅（模糊匹配需确认，-y 跳过）' },
    ],
  },
  // === 配置 ===
  {
    name: 'overwrite',
    aliases: ['ow'],
    handler: cmdOverwrite,
    group: 'config',
    usage: [
      { signature: 'overwrite', description: '查看覆写状态（别名 ow）' },
      { signature: 'overwrite on|off', description: '启用/禁用覆写配置' },
    ],
  },
  {
    name: 'directory',
    aliases: ['dir', 'dirs', 'directories'],
    handler: cmdDirectory,
    group: 'config',
    usage: [
      { signature: 'directory', description: '显示数据目录位置（别名 dir）' },
      { signature: 'directory open [target]', description: '打开目录: root|subs|logs|data|runtime|kernel' },
    ],
  },
  // === 系统 ===
  {
    name: 'kernel',
    aliases: [],
    handler: cmdKernel,
    group: 'system',
    usage: [{ signature: 'kernel [--mirror [镜像]]', description: '更新内核（自动选择通道：gh > 本机代理 > 镜像 > 直连）' }],
  },
  {
    name: 'update',
    aliases: [],
    handler: cmdUpdate,
    group: 'system',
    usage: [{ signature: 'update', description: '更新 mihomo-cli（npm install -g）' }],
  },
  {
    name: 'reset',
    aliases: [],
    handler: cmdReset,
    group: 'system',
    usage: [{ signature: 'reset [目标...] [--full] [-y]', description: '重置: 留空保留设置/内核/覆写，指定目标删对应项，--full 删全部，-y 跳过确认' }],
  },
  {
    name: 'doctor',
    aliases: [],
    handler: cmdDoctor,
    group: 'system',
    usage: [{ signature: 'doctor', description: '体检诊断（内核/服务/端口/订阅/配置/连通性/CLI 版本，有异常退出码 1）' }],
  },
  {
    name: 'completion',
    aliases: [],
    handler: args => cmdCompletion(args, COMMANDS),
    group: 'system',
    usage: [
      { signature: 'completion install <zsh|bash|fish>', description: '安装补全到对应 shell 的默认位置' },
      { signature: 'completion <zsh|bash|fish>', description: '输出补全脚本（重定向或 eval 使用）' },
    ],
  },
  // === meta(不在分组清单展示,help 末尾单列) ===
  {
    name: 'help',
    aliases: ['-h', '--help'],
    handler: () => printHelp(COMMANDS),
    group: 'meta',
    usage: [{ signature: 'help, -h', description: '显示帮助' }],
  },
  {
    name: 'version',
    aliases: ['-v', '--version'],
    handler: printVersion,
    group: 'meta',
    usage: [{ signature: 'version, -v', description: '显示版本' }],
  },
];

const COMMAND_INDEX: Map<string, Command> = (() => {
  const index = new Map<string, Command>();
  for (const cmd of COMMANDS) {
    for (const token of [cmd.name, ...cmd.aliases]) {
      if (index.has(token)) {
        throw new Error(`命令注册表存在重复 token: "${token}"（${index.get(token)?.name} 与 ${cmd.name}）`);
      }
      index.set(token, cmd);
    }
  }
  return index;
})();

/** 按 token(命令名或别名)查找命令;未命中返回 undefined。 */
export function findCommand(token: string): Command | undefined {
  return COMMAND_INDEX.get(token);
}

/** 全部可识别 token(主名+别名)，供 did-you-mean 纠错候选。 */
export function allCommandTokens(): string[] {
  return [...COMMAND_INDEX.keys()];
}
