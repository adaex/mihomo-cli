import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { getSshTunnels } from '../settings.js';
import * as ssh from '../ssh.js';
import { ensureSshConfigFile, getSshConfigPath } from '../ssh-config.js';
import type { SshConfig, SshStatus } from '../types.js';
import { getNonFlagArg, hasFlag, parseStringArg, suggestSimilar } from '../utils.js';
import { confirmOrThrow, dispatchSubcommand, restartToApply, type SubCommand } from './shared.js';

/** 状态的展示文本：三态各自着色，「假活」必须与「运行中」区分开——那正是最误导的形态 */
function formatState(status: SshStatus): string {
  switch (status.state) {
    case 'running':
      return colors.green(`运行中 (PID ${status.pid})`);
    case 'dead-port':
      return colors.yellow(`假活 (PID ${status.pid}，端口 ${status.config.port} 不通)`);
    default:
      return colors.yellow('未运行');
  }
}

/** 取隧道名位置参数。允许 flag 前置（`ssh rm -y foo`），故不能直接读 args[2]。 */
function getSshNameArg(args: string[]): string | null {
  return getNonFlagArg(args, 2);
}

function requireSshNameArg(args: string[], usage: string): string {
  const name = getSshNameArg(args);
  if (!name) {
    const tunnels = getSshTunnels();
    throw new CliError('请指定隧道名称', {
      hint: [usage, ...(tunnels.length > 0 ? ['', '可用隧道:', ...tunnels.map(t => `  ${t.name}`)] : [])],
    });
  }
  return name;
}

async function printSshList(): Promise<void> {
  const tunnels = getSshTunnels();
  console.log('');
  if (tunnels.length === 0) {
    console.log('没有配置隧道');
    console.log('');
    console.log('添加隧道: mihomo ssh add <名字> --host <ssh主机> --port <端口>');
    console.log(colors.gray('  例如: mihomo ssh add work --host m4 --port 1080'));
    console.log(colors.gray('  隧道把内网出口暴露为本地 SOCKS5，配合 ssh.<名字>.yaml 分流内网域名'));
    console.log('');
    return;
  }

  const statuses = await ssh.getAllSshStatus();
  console.log(colors.cyan('隧道列表:'));
  console.log('');
  for (const status of statuses) {
    const { config } = status;
    const autoLabel = config.auto ? colors.gray(' [auto]') : '';
    console.log(`  ${colors.bold(config.name)}${autoLabel}`);
    console.log(`    ${colors.gray('出口: ')}${config.host} → 127.0.0.1:${config.port}`);
    console.log(`    ${colors.gray('状态: ')}${formatState(status)}`);
    console.log(`    ${colors.gray('配置: ')}${getSshConfigPath(config.name)}`);
    if (status.started_by) {
      console.log(`    ${colors.gray('来源: ')}${status.started_by === 'auto' ? '随 start 拉起' : '手动启动'}`);
    }
  }
  console.log('');
  console.log('启动: mihomo ssh up [名字]      停止: mihomo ssh down [名字]');
  console.log('状态: mihomo ssh status         删除: mihomo ssh rm <名字>');
  console.log('');
}

async function sshAdd(args: string[]): Promise<void> {
  const name = requireSshNameArg(args, '用法: mihomo ssh add <名字> --host <ssh主机> --port <端口> [--no-auto]');

  const host = parseStringArg(args, '--host');
  if (!host) {
    throw new CliError('缺少 --host', {
      hint: ['用法: mihomo ssh add <名字> --host <ssh主机> --port <端口>', '', '主机可用 ~/.ssh/config 里的别名，例如 --host m4'],
    });
  }
  const portRaw = parseStringArg(args, '--port');
  if (!portRaw) {
    throw new CliError('缺少 --port', { hint: ['用法: mihomo ssh add <名字> --host <ssh主机> --port <端口>'] });
  }
  // 只接受纯十进制整数：Number('1080abc') 是 NaN，但 parseInt 会静默吞掉尾巴取 1080
  if (!/^\d+$/.test(portRaw.trim())) {
    throw new CliError(`端口无效: "${portRaw}"，需为 1-65535 的整数`);
  }
  const port = Number(portRaw.trim());
  // --no-auto 时不随 start 拉起；默认 auto，因为「一个动作同时拉起两者」正是本功能的诉求
  const auto = !hasFlag(args, '--no-auto');

  const config: SshConfig = { name, host, port, auto };
  ssh.addSshTunnel(config);

  const created = ensureSshConfigFile(config);
  const configPath = getSshConfigPath(name);

  console.log(`${colors.green('已添加隧道')} ${name} · ${host} → 127.0.0.1:${port}${auto ? ' · auto' : ''}`);
  console.log('');
  if (created) {
    console.log(`已生成配置模板: ${configPath}`);
    console.log(colors.gray('  socks5 节点由 CLI 自动注入，模板只建好分组，分流规则需你填写（CLI 无从知道你的内网域名）'));
    console.log(colors.gray('  编辑后执行 mihomo start 生效'));
  } else {
    console.log(`配置文件已存在，未改动: ${configPath}`);
  }
  console.log('');
  console.log(`启动隧道: mihomo ssh up ${name}`);

  // 节点由 CLI 依据 settings 注入，故端口/主机变更本身就需重启生效——
  // 不能像此前那样只在「新建了模板」时重启（改端口时文件已存在，会漏掉重启）
  await restartToApply(args);
}

async function sshUp(args: string[]): Promise<void> {
  const name = getSshNameArg(args);
  const targets = name ? [resolveSshTunnel(name)] : getSshTunnels();

  if (targets.length === 0) {
    throw new CliError('没有配置隧道', { hint: ['添加隧道: mihomo ssh add <名字> --host <ssh主机> --port <端口>'] });
  }

  for (const config of targets) {
    // 自愈：配置文件被 reset ssh 之类删掉后，这里补建回来
    if (ensureSshConfigFile(config)) {
      console.log(colors.gray(`已补建配置模板: ${getSshConfigPath(config.name)}`));
    }
    // 手动启动记 manual：`mihomo stop` 只带走 auto 的，用户显式起的不该被连带停掉
    const result = await ssh.startSshTunnel(config.name, { startedBy: 'manual' });
    if (result.alreadyRunning) {
      console.log(`${colors.gray('已在运行')} ${config.name} (PID ${result.pid})`);
    } else {
      console.log(`${colors.green('已启动隧道')} ${config.name} · ${config.host} → 127.0.0.1:${config.port} (PID ${result.pid})`);
    }
  }
}

function sshDown(args: string[]): void {
  const name = getSshNameArg(args);
  const targets = name ? [resolveSshTunnel(name)] : getSshTunnels();

  if (targets.length === 0) {
    throw new CliError('没有配置隧道');
  }

  let stopped = 0;
  for (const config of targets) {
    const result = ssh.stopSshTunnel(config.name);
    if (result.notRunning) {
      console.log(`${colors.yellow('不在运行')} ${config.name}`);
    } else {
      console.log(`${colors.green('已停止隧道')} ${config.name} (PID ${result.pid})`);
      stopped++;
    }
  }

  if (stopped > 0) {
    console.log('');
    console.log(colors.gray('注意: 配置里的隧道节点仍在，现在指向未监听的端口'));
  }
}

async function sshStatus(args: string[]): Promise<void> {
  const name = getSshNameArg(args);
  if (!name) {
    await printSshList();
    return;
  }

  const config = resolveSshTunnel(name);
  const status = await ssh.getSshStatus(config);

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
    console.log(`重启隧道: mihomo ssh down ${config.name} && mihomo ssh up ${config.name}`);
    console.log(colors.gray(`  日志: ${ssh.getSshLogPath(config.name)}`));
    console.log('');
  } else if (status.state === 'stopped') {
    console.log(`启动隧道: mihomo ssh up ${config.name}`);
    console.log('');
  }
}

async function sshRemove(args: string[]): Promise<void> {
  const name = requireSshNameArg(args, '用法: mihomo ssh rm <名字> [-y]');
  const config = resolveSshTunnel(name);
  const skipConfirm = hasFlag(args, '-y', '--yes');

  if (!skipConfirm) {
    if (
      !(await confirmOrThrow(`确认删除隧道 "${config.name}"?`, {
        nonTtyMessage: '删除隧道需要确认',
        hint: [`跳过确认: mihomo ssh rm ${config.name} -y`],
      }))
    ) {
      console.log('已取消');
      return;
    }
  }

  ssh.stopSshTunnel(config.name);
  ssh.removeSshTunnel(config.name);

  console.log(`${colors.green('已删除隧道')} ${config.name}`);
  console.log('');
  // 不代删用户维护的配置文件：那可能含用户手写的分流规则，删掉不可恢复
  console.log(`配置文件未删除: ${getSshConfigPath(config.name)}`);
  // 节点随 settings 条目一起消失（由 CLI 注入），文件里的分组因此引用不到节点，
  // 会被 validateConfig 连同相关规则一并移除并告警——不会生成非法配置，但会有噪音
  console.log(colors.gray('  其中的分组已引用不到节点，下次 start 会被自动移除，如不再需要请自行删除该文件'));
}

/** 按名精确解析隧道；未找到时列出可用名称。隧道通常只有一两条，不引入模糊匹配。 */
function resolveSshTunnel(name: string): SshConfig {
  const config = ssh.findSshTunnel(name);
  if (!config) {
    const tunnels = getSshTunnels();
    const suggestion = suggestSimilar(
      name,
      tunnels.map(t => t.name),
    );
    throw new CliError(`未找到隧道 "${name}"`, {
      hint: [
        ...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []),
        ...(tunnels.length > 0
          ? ['', '可用隧道:', ...tunnels.map(t => `  ${t.name}`)]
          : ['', '添加隧道: mihomo ssh add <名字> --host <ssh主机> --port <端口>']),
      ],
    });
  }
  return config;
}

const SUBCOMMANDS: SubCommand[] = [
  { name: 'list', handler: printSshList },
  { name: 'add', handler: sshAdd },
  { name: 'up', aliases: ['start'], handler: sshUp },
  { name: 'down', aliases: ['stop'], handler: sshDown },
  { name: 'status', handler: sshStatus },
  { name: 'remove', aliases: ['rm', 'delete'], handler: sshRemove },
];

export async function cmdSsh(args: string[]): Promise<void> {
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无 action → 列表；未知 action → 报错（不静默回落，否则 `ssh upp` 会看似成功）
    fallback: printSshList,
    onUnknown: action => {
      const names = SUBCOMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
      const suggestion = suggestSimilar(action, names);
      throw new CliError(`未知的 ssh 子命令: ${action}`, {
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), '', '可用子命令: list, add, up, down, status, rm'],
      });
    },
  });
}
