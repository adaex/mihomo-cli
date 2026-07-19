import { cmdDaemon } from './daemon.js';
import { cmdDirectory } from './directory.js';
import { printHelp, printVersion } from './help.js';
import { cmdKernel } from './kernel.js';
import { cmdLog, cmdLogs } from './log.js';
import { cmdOverwrite } from './overwrite.js';
import { cmdReset } from './reset.js';
import { cmdStart } from './start.js';
import { printStatus } from './status.js';
import { cmdStop } from './stop.js';
import { cmdSubscription } from './subscription.js';
import { cmdClean, cmdTest } from './test.js';
import { cmdUI } from './ui.js';
import { cmdUpdate } from './update.js';

type Handler = (args: string[]) => void | Promise<void>;

export type CommandGroup = 'control' | 'interface' | 'subscription' | 'config' | 'system' | 'meta';

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
  usage: string[];
}

/**
 * 命令注册表:index.ts 的唯一分发来源,help 的命令清单也由此生成。
 * 新增命令只需在此加一条(name + aliases + handler + usage),路由与帮助自动生效。
 */
export const COMMANDS: Command[] = [
  // === 控制 ===
  {
    name: 'start',
    aliases: ['up'],
    handler: cmdStart,
    group: 'control',
    usage: ['start [tun|mixed] [-s] [-u ms]     启动/切换代理 (默认 mixed)', '      [-r N] [-t ms] [-j N]'],
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
    aliases: ['down'],
    handler: cmdStop,
    group: 'control',
    usage: ['stop                         停止代理'],
  },
  {
    name: 'status',
    aliases: [],
    handler: printStatus,
    group: 'control',
    usage: ['status                       查看状态'],
  },
  // === 界面 ===
  {
    name: 'ui',
    aliases: [],
    handler: cmdUI,
    group: 'interface',
    usage: ['ui [zash|dash|yacd]          打开 Web UI (默认 zash)'],
  },
  {
    name: 'log',
    aliases: [],
    handler: cmdLog,
    group: 'interface',
    usage: ['log [-o]                     实时日志（-o 打开文件）'],
  },
  {
    name: 'logs',
    aliases: [],
    handler: cmdLogs,
    group: 'interface',
    usage: ['logs [编号] [-n N] [-o]      日志列表（0=当前，1+=归档）'],
  },
  // === 订阅 ===
  {
    name: 'subscription',
    aliases: ['sub', 'subscriptions'],
    handler: cmdSubscription,
    group: 'subscription',
    usage: [
      'subscription                 列出所有订阅（别名 sub）',
      'subscription use <name>      切换当前订阅',
      'subscription add <url> [name]  添加订阅',
      'subscription update [name]   更新订阅（无参更新所有）',
      'subscription remove <name>   删除订阅',
      'subscription web [name]      打开订阅页面',
      'subscription test [name]     测试节点连通性',
      'subscription clean [name]    测速并清理失败节点',
    ],
  },
  {
    name: 'use',
    aliases: [],
    handler: cmdSubscription,
    rewrite: args => ['sub', 'use', ...args.slice(1)],
    group: 'subscription',
    usage: [],
  },
  {
    name: 'test',
    aliases: [],
    handler: cmdTest,
    group: 'subscription',
    usage: ['test [-t ms] [-j N]           快速测试当前节点连通性'],
  },
  {
    name: 'clean',
    aliases: [],
    handler: cmdClean,
    group: 'subscription',
    usage: ['clean [-t ms] [-j N] [-r N]   清理失败节点并自动重启'],
  },
  // === 配置 ===
  {
    name: 'overwrite',
    aliases: ['ow'],
    handler: cmdOverwrite,
    group: 'config',
    usage: ['overwrite                   查看覆写状态（别名 ow）', 'overwrite on|off            启用/禁用覆写配置'],
  },
  {
    name: 'on',
    aliases: [],
    handler: cmdOverwrite,
    rewrite: () => ['ow', 'on'],
    group: 'config',
    usage: [],
  },
  {
    name: 'off',
    aliases: [],
    handler: cmdOverwrite,
    rewrite: () => ['ow', 'off'],
    group: 'config',
    usage: [],
  },
  {
    name: 'directory',
    aliases: ['dir', 'dirs', 'directories'],
    handler: cmdDirectory,
    group: 'config',
    usage: ['directory                   显示数据目录位置（别名 dir）', 'directory open [target]     打开目录: root|subs|logs|runtime|...'],
  },
  {
    name: 'open',
    aliases: [],
    handler: cmdDirectory,
    rewrite: args => ['dir', 'open', ...args.slice(1)],
    group: 'config',
    usage: [],
  },
  // === 系统 ===
  {
    name: 'kernel',
    aliases: [],
    handler: cmdKernel,
    group: 'system',
    usage: ['kernel [--mirror [镜像]]         更新内核（默认直连，--mirror 使用 v6）'],
  },
  {
    name: 'daemon',
    aliases: [],
    handler: cmdDaemon,
    group: 'system',
    usage: ['daemon on|off               开机自启 + 崩溃重启（仅 Mixed，需管理员密码）', 'daemon status               查看保活状态'],
  },
  {
    name: 'update',
    aliases: ['upd', 'upgrade'],
    handler: cmdUpdate,
    group: 'system',
    usage: ['update                       更新 mihomo-cli (npm install -g)'],
  },
  {
    name: 'reset',
    aliases: [],
    handler: cmdReset,
    group: 'system',
    usage: ['reset [目标...] [--full]   重置: 留空保留设置/内核/覆写, 指定目标删对应项, --full 删全部'],
  },
  // === meta(不在分组清单展示,help 末尾单列) ===
  {
    name: 'help',
    aliases: ['-h', '--help'],
    handler: () => printHelp(COMMANDS),
    group: 'meta',
    usage: ['help, -h                     显示帮助'],
  },
  {
    name: 'version',
    aliases: ['-v', '--version'],
    handler: printVersion,
    group: 'meta',
    usage: ['version, -v                  显示版本'],
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
