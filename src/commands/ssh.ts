import fs from 'node:fs';

import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { USER_DATA_DIR } from '../paths.js';
import { getSshTunnels } from '../settings.js';
import * as ssh from '../ssh.js';
import type { SshConfig, SshStatus } from '../types.js';
import { getNonFlagArg, hasFlag, parseStringArg, suggestSimilar } from '../utils.js';
import { confirmOrThrow, dispatchSubcommand, type SubCommand } from './shared.js';

/**
 * 提醒残留的 `ssh.*.yaml`：v3.12.0 起这些文件不再被加载，里面的分组和规则**已经失效**。
 * 不自动删也不自动迁移（用户手写的分流规则不可恢复，且合并进 overwrite.yaml 需要人判断），
 * 但必须说出来——否则就是「配置还在、看着没变、实际不生效」这种最难查的静默失效。
 */
function warnLegacySshConfigFiles(): void {
  if (!fs.existsSync(USER_DATA_DIR)) return;
  const legacy = fs.readdirSync(USER_DATA_DIR).filter(f => /^ssh\..+\.ya?ml$/.test(f));
  if (legacy.length === 0) return;

  console.log(colors.yellow(`警告: 发现 ${legacy.length} 个已失效的 ssh 配置文件`));
  for (const f of legacy) {
    console.log(colors.gray(`  ${f}`));
  }
  console.log(colors.gray('  v3.12.0 起 CLI 不再加载它们，其中的分组与规则已不生效'));
  console.log(colors.gray('  需要的话把内容并入 overwrite.yaml（含 socks5 节点定义），然后自行删除'));
  console.log('');
}

/**
 * 打印「怎么把这条隧道接进配置」的示例片段。
 *
 * CLI 只管端口，不再生成也不再合并任何 ssh 配置文件（v3.12.0）：节点与分流规则
 * 一律由用户自己写进 overwrite.yaml。此前 CLI 依据 settings 合成节点并独立于
 * `ow off` 合并，多出一整条只服务一个功能的配置管线，也让「配置从哪来」有两个答案。
 * 现在只在这里把片段打出来，复制即可用——端口以本命令显示的为准。
 */
function printOverwriteSnippet(config: SshConfig): void {
  console.log(colors.gray('把隧道接入分流：在 overwrite.yaml 里加上（改成你的内网域名）'));
  console.log(colors.gray(`  ~proxies:`));
  console.log(colors.gray(`    - {name: SSH-${config.name}, type: socks5, server: 127.0.0.1, port: ${config.port}}`));
  console.log(colors.gray(`  +rules:`));
  console.log(colors.gray(`    - DOMAIN-SUFFIX,example.internal,SSH-${config.name}`));
}

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
  warnLegacySshConfigFiles();
  if (tunnels.length === 0) {
    console.log('没有配置隧道');
    console.log('');
    console.log('添加隧道: mihomo ssh add <名字> --host <ssh主机> --port <端口>');
    console.log(colors.gray('  例如: mihomo ssh add work --host m4 --port 1080'));
    console.log(colors.gray('  隧道把内网出口暴露为本地 SOCKS5，节点与分流规则写进 overwrite.yaml'));
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
    if (status.started_by) {
      console.log(`    ${colors.gray('来源: ')}${status.started_by === 'auto' ? '随 start 拉起' : '手动启动'}`);
    }
  }
  console.log('');
  console.log('启动: mihomo ssh up [名字]      停止: mihomo ssh down [名字]');
  console.log('状态: mihomo ssh status         删除: mihomo ssh rm <名字>');
  console.log('');
}

function sshAdd(args: string[]): void {
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

  console.log(`${colors.green('已添加隧道')} ${name} · ${host} → 127.0.0.1:${port}${auto ? ' · auto' : ''}`);
  console.log('');
  printOverwriteSnippet(config);
  console.log('');
  console.log(`启动隧道: mihomo ssh up ${name}`);
}

async function sshUp(args: string[]): Promise<void> {
  const name = getSshNameArg(args);
  const targets = name ? [resolveSshTunnel(name)] : getSshTunnels();

  if (targets.length === 0) {
    throw new CliError('没有配置隧道', { hint: ['添加隧道: mihomo ssh add <名字> --host <ssh主机> --port <端口>'] });
  }

  for (const config of targets) {
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
    console.log(colors.gray('注意: overwrite.yaml 里指向该端口的节点现在连不通'));
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
  // CLI 不碰 overwrite.yaml：那是用户维护的资产，代改会动到手写的分流规则。
  // 端口没了之后节点连不通，但配置本身仍合法，不影响其余流量
  console.log(colors.gray(`如 overwrite.yaml 里写过指向 127.0.0.1:${config.port} 的节点，请自行移除`));
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

// list 刻意不注册：裸 `ssh` 就是列表（fallback），与 `sub` / `dir` / `ow` 同口径
const SUBCOMMANDS: SubCommand[] = [
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
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), '', '可用子命令: add, up, down, status, rm（裸 ssh 即列表）'],
      });
    },
  });
}
