import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import * as tunnel from '../tunnel.js';
import type { TunnelConfig, TunnelStatus } from '../types.js';
import { getNonFlagArg, hasFlag, parseStringArg, suggestSimilar } from '../utils.js';
import { confirmPrompt, dispatchSubcommand, restartToApply, type SubCommand } from './shared.js';

/** 状态的展示文本：三态各自着色，「假活」必须与「运行中」区分开——那正是最误导的形态 */
function formatState(status: TunnelStatus): string {
  switch (status.state) {
    case 'running':
      return colors.green(`运行中 (PID ${status.pid})`);
    case 'dead-port':
      return colors.yellow(`假活 (PID ${status.pid}，端口 ${status.config.port} 不通)`);
    default:
      return colors.yellow('未运行');
  }
}

/** 取隧道名位置参数。允许 flag 前置（`tunnel rm -y foo`），故不能直接读 args[2]。 */
function getTunnelNameArg(args: string[]): string | null {
  return getNonFlagArg(args, 2);
}

function requireTunnelNameArg(args: string[], usage: string): string {
  const name = getTunnelNameArg(args);
  if (!name) {
    const tunnels = tunnel.getTunnels();
    throw new CliError('请指定隧道名称', {
      hint: [usage, ...(tunnels.length > 0 ? ['', '可用隧道:', ...tunnels.map(t => `  ${t.name}`)] : [])],
    });
  }
  return name;
}

async function printTunnelList(): Promise<void> {
  const tunnels = tunnel.getTunnels();
  console.log('');
  if (tunnels.length === 0) {
    console.log('没有配置隧道');
    console.log('');
    console.log('添加隧道: mihomo tunnel add <名字> --host <ssh主机> --port <端口>');
    console.log(colors.gray('  例如: mihomo tunnel add work --host m4 --port 1080'));
    console.log(colors.gray('  隧道把内网出口暴露为本地 SOCKS5，配合覆写文件分流内网域名'));
    console.log('');
    return;
  }

  const statuses = await tunnel.getAllTunnelStatus();
  console.log(colors.cyan('隧道列表:'));
  console.log('');
  for (const status of statuses) {
    const { config } = status;
    const autoLabel = config.auto ? colors.gray(' [auto]') : '';
    console.log(`  ${colors.bold(config.name)}${autoLabel}`);
    console.log(`    ${colors.gray('出口: ')}${config.host} → 127.0.0.1:${config.port}`);
    console.log(`    ${colors.gray('状态: ')}${formatState(status)}`);
    if (status.started_by) {
      console.log(`    ${colors.gray('来源: ')}${status.started_by === 'auto' ? '随 start 拉起' : '手动启动'}`);
    }
  }
  console.log('');
  console.log('启动: mihomo tunnel up [名字]      停止: mihomo tunnel down [名字]');
  console.log('状态: mihomo tunnel status         删除: mihomo tunnel rm <名字>');
  console.log('');
}

async function tunnelAdd(args: string[]): Promise<void> {
  const name = requireTunnelNameArg(args, '用法: mihomo tunnel add <名字> --host <ssh主机> --port <端口> [--no-auto]');

  const host = parseStringArg(args, '--host');
  if (!host) {
    throw new CliError('缺少 --host', {
      hint: ['用法: mihomo tunnel add <名字> --host <ssh主机> --port <端口>', '', '主机可用 ~/.ssh/config 里的别名，例如 --host m4'],
    });
  }
  const portRaw = parseStringArg(args, '--port');
  if (!portRaw) {
    throw new CliError('缺少 --port', { hint: ['用法: mihomo tunnel add <名字> --host <ssh主机> --port <端口>'] });
  }
  // 只接受纯十进制整数：Number('1080abc') 是 NaN，但 parseInt 会静默吞掉尾巴取 1080
  if (!/^\d+$/.test(portRaw.trim())) {
    throw new CliError(`端口无效: "${portRaw}"，需为 1-65535 的整数`);
  }
  const port = Number(portRaw.trim());
  // --no-auto 时不随 start 拉起；默认 auto，因为「一个动作同时拉起两者」正是本功能的诉求
  const auto = !hasFlag(args, '--no-auto');

  const config: TunnelConfig = { name, host, port, auto };
  tunnel.addTunnel(config);

  const created = tunnel.ensureTunnelOverwriteFile(config);
  const overwritePath = tunnel.getTunnelOverwritePath(name);

  console.log(`${colors.green('已添加隧道')} ${name} · ${host} → 127.0.0.1:${port}${auto ? ' · auto' : ''}`);
  console.log('');
  if (created) {
    console.log(`已生成覆写模板: ${overwritePath}`);
    console.log(colors.gray('  模板只建好 socks5 节点与分组，分流规则需你填写（CLI 无从知道你的内网域名）'));
    console.log(colors.gray('  编辑后执行 mihomo start 生效'));
  } else {
    console.log(`覆写文件已存在，未改动: ${overwritePath}`);
  }
  console.log('');
  console.log(`启动隧道: mihomo tunnel up ${name}`);

  // 新建了模板 = 配置变了，运行中需重启使新节点进入配置；文件已存在则什么都没变，不打扰
  if (created) {
    await restartToApply(args);
  }
}

async function tunnelUp(args: string[]): Promise<void> {
  const name = getTunnelNameArg(args);
  const targets = name ? [resolveTunnel(name)] : tunnel.getTunnels();

  if (targets.length === 0) {
    throw new CliError('没有配置隧道', { hint: ['添加隧道: mihomo tunnel add <名字> --host <ssh主机> --port <端口>'] });
  }

  for (const config of targets) {
    // 自愈：覆写文件被 reset ow 之类删掉后，这里补建回来
    if (tunnel.ensureTunnelOverwriteFile(config)) {
      console.log(colors.gray(`已补建覆写模板: ${tunnel.getTunnelOverwritePath(config.name)}`));
    }
    // 手动启动记 manual：`mihomo stop` 只带走 auto 的，用户显式起的不该被连带停掉
    const result = await tunnel.startTunnel(config.name, { startedBy: 'manual' });
    if (result.alreadyRunning) {
      console.log(`${colors.gray('已在运行')} ${config.name} (PID ${result.pid})`);
    } else {
      console.log(`${colors.green('已启动隧道')} ${config.name} · ${config.host} → 127.0.0.1:${config.port} (PID ${result.pid})`);
    }
  }
}

function tunnelDown(args: string[]): void {
  const name = getTunnelNameArg(args);
  const targets = name ? [resolveTunnel(name)] : tunnel.getTunnels();

  if (targets.length === 0) {
    throw new CliError('没有配置隧道');
  }

  let stopped = 0;
  for (const config of targets) {
    const result = tunnel.stopTunnel(config.name);
    if (result.notRunning) {
      console.log(`${colors.yellow('不在运行')} ${config.name}`);
    } else {
      console.log(`${colors.green('已停止隧道')} ${config.name} (PID ${result.pid})`);
      stopped++;
    }
  }

  if (stopped > 0) {
    console.log('');
    console.log(colors.gray('注意: 覆写文件仍在，配置里的隧道节点现在指向未监听的端口'));
  }
}

async function tunnelStatus(args: string[]): Promise<void> {
  const name = getTunnelNameArg(args);
  if (!name) {
    await printTunnelList();
    return;
  }

  const config = resolveTunnel(name);
  const status = await tunnel.getTunnelStatus(config);

  console.log('');
  console.log(`${colors.gray('隧道: ')}${config.name}${config.auto ? colors.gray(' [auto]') : ''}`);
  console.log(`${colors.gray('出口: ')}${config.host} → 127.0.0.1:${config.port}`);
  console.log(`${colors.gray('状态: ')}${formatState(status)}`);
  if (status.started_by) {
    console.log(`${colors.gray('来源: ')}${status.started_by === 'auto' ? '随 start 拉起' : '手动启动'}`);
  }
  console.log('');

  if (status.state === 'dead-port') {
    // 这是最需要引导的状态：进程在、端口不通，mihomo 仍在往死端口送流量
    console.log(colors.yellow('ssh 进程还在，但端口没有监听——内网分流当前不可用'));
    console.log(`重启隧道: mihomo tunnel down ${config.name} && mihomo tunnel up ${config.name}`);
    console.log(colors.gray(`  日志: ${tunnel.getTunnelLogPath(config.name)}`));
    console.log('');
  } else if (status.state === 'stopped') {
    console.log(`启动隧道: mihomo tunnel up ${config.name}`);
    console.log('');
  }
}

async function tunnelRemove(args: string[]): Promise<void> {
  const name = requireTunnelNameArg(args, '用法: mihomo tunnel rm <名字> [-y]');
  const config = resolveTunnel(name);
  const skipConfirm = hasFlag(args, '-y', '--yes');

  if (!skipConfirm) {
    if (!process.stdin.isTTY) {
      // 非交互下打印「已取消」再 return 会以退出码 0 结束，脚本会把「什么都没做」当成功
      throw new CliError('删除隧道需要确认', {
        label: '已取消',
        hint: [`跳过确认: mihomo tunnel rm ${config.name} -y`],
      });
    }
    const confirmed = await confirmPrompt(`确认删除隧道 "${config.name}"?`);
    if (!confirmed) {
      console.log('已取消');
      return;
    }
  }

  tunnel.stopTunnel(config.name);
  tunnel.removeTunnel(config.name);

  console.log(`${colors.green('已删除隧道')} ${config.name}`);
  console.log('');
  // 不代删用户维护的覆写文件：那可能含用户手写的分流规则，删掉不可恢复
  console.log(`覆写文件未删除: ${tunnel.getTunnelOverwritePath(config.name)}`);
  console.log(colors.gray('  它仍会向配置注入指向该端口的节点，如不再需要请自行删除'));
}

/** 按名精确解析隧道；未找到时列出可用名称。隧道通常只有一两条，不引入模糊匹配。 */
function resolveTunnel(name: string): TunnelConfig {
  const config = tunnel.findTunnel(name);
  if (!config) {
    const tunnels = tunnel.getTunnels();
    const suggestion = suggestSimilar(
      name,
      tunnels.map(t => t.name),
    );
    throw new CliError(`未找到隧道 "${name}"`, {
      hint: [
        ...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []),
        ...(tunnels.length > 0
          ? ['', '可用隧道:', ...tunnels.map(t => `  ${t.name}`)]
          : ['', '添加隧道: mihomo tunnel add <名字> --host <ssh主机> --port <端口>']),
      ],
    });
  }
  return config;
}

const SUBCOMMANDS: SubCommand[] = [
  { name: 'list', handler: printTunnelList },
  { name: 'add', handler: tunnelAdd },
  { name: 'up', aliases: ['start'], handler: tunnelUp },
  { name: 'down', aliases: ['stop'], handler: tunnelDown },
  { name: 'status', handler: tunnelStatus },
  { name: 'remove', aliases: ['rm', 'delete'], handler: tunnelRemove },
];

export async function cmdTunnel(args: string[]): Promise<void> {
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无 action → 列表；未知 action → 报错（不静默回落，否则 `tunnel upp` 会看似成功）
    fallback: printTunnelList,
    onUnknown: action => {
      const names = SUBCOMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
      const suggestion = suggestSimilar(action, names);
      throw new CliError(`未知的 tunnel 子命令: ${action}`, {
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), '', '可用子命令: list, add, up, down, status, rm'],
      });
    },
  });
}
