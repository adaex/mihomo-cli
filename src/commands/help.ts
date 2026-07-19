import { getKernelVersion } from '../config.js';
import { USER_DATA_DIR } from '../paths.js';
import { colors, VERSION } from '../utils.js';
import type { Command, CommandGroup } from './registry.js';

export function printShortHelp(): void {
  console.log(`\n${colors.cyan(colors.bold(`mihomo-cli v${VERSION}`))}  (mihomo help 查看完整帮助)\n`);
  console.log(
    '常用命令:\n' +
      `  ${colors.bold('start')} [tun|mixed]    启动/切换代理\n` +
      `  ${colors.bold('sub')} [use|update]     订阅管理\n` +
      `  ${colors.bold('ow')} [on|off]          覆写配置\n` +
      `  ${colors.bold('ui')} [zash|dash|yacd]  打开 Web UI\n`,
  );
}

/** 分组展示顺序与标题(meta 组不在此,单列于末尾)。 */
const GROUP_TITLES: [CommandGroup, string][] = [
  ['control', '控制:'],
  ['interface', '界面:'],
  ['subscription', '订阅:'],
  ['config', '配置:'],
  ['system', '系统:'],
];

/**
 * 从命令注册表生成帮助。命令清单(各分组的用法行)来自每条 Command 的 usage,
 * 单一真相源——新增命令即自动出现在帮助中,不会再出现手写 help 与实际脱节。
 * 用法行之后的示例/模式/数据目录为静态散文,手写附加。
 */
export function printHelp(commands: Command[]): void {
  const lines: string[] = [`\n${colors.cyan(colors.bold(`mihomo-cli v${VERSION}`))}`, '', '命令别名: mihomo, mhm, mh', '', '用法:', '  mihomo <命令> [选项]'];

  for (const [group, title] of GROUP_TITLES) {
    const usageLines = commands.filter(c => c.group === group).flatMap(c => c.usage);
    if (usageLines.length === 0) continue;
    lines.push('', colors.cyan(title));
    for (const u of usageLines) {
      // 第一段(命令名)加粗:遇到首个空格前的 token 加粗,续行(以空格开头)原样缩进
      lines.push(u.startsWith(' ') ? `  ${u}` : `  ${boldFirstToken(u)}`);
    }
  }

  const meta = commands.filter(c => c.group === 'meta').flatMap(c => c.usage);
  if (meta.length > 0) {
    lines.push('', colors.cyan('元:'));
    for (const u of meta) lines.push(`  ${boldFirstToken(u)}`);
  }

  lines.push(
    '',
    `${colors.cyan('示例:')}`,
    '  mihomo start              # 启动/重启 Mixed 模式',
    '  mihomo start tun          # 切换到 TUN 透明代理模式',
    '  mihomo start -s           # 跳过自动更新订阅',
    '  mihomo start -u 30000     # 自动更新超时 30 秒 (默认 10s)',
    '  mihomo daemon on          # 开启保活（开机自启 + 崩溃重启）',
    '  mihomo sub add <url>      # 添加订阅 (sub 是 subscription 别名)',
    '  mihomo ui                 # 打开 Web UI',
    '',
    `${colors.cyan('快捷命令:')}`,
    '  tun = start tun   use = sub use   on/off = ow on/off   open = dir open',
    '  up = start   down = stop   upd/upgrade = update',
    '',
    `${colors.cyan('模式说明:')}`,
    '  mixed  HTTP + SOCKS5 混合端口 (默认)',
    '  tun    透明代理，全局自动路由，需要 sudo',
    '',
    `${colors.cyan('数据目录:')}`,
    '  环境变量 MIHOMO_CLI_DIR 可自定义位置',
    `  默认: ${USER_DATA_DIR}`,
  );

  console.log(lines.join('\n'));
}

/** 把用法行首个 token(命令名)加粗,其余不变。 */
function boldFirstToken(usage: string): string {
  const spaceIdx = usage.indexOf(' ');
  if (spaceIdx < 0) return colors.bold(usage) as string;
  return `${colors.bold(usage.slice(0, spaceIdx))}${usage.slice(spaceIdx)}`;
}

export function printVersion(): void {
  const kv = getKernelVersion() || '未安装';
  console.log(colors.cyan(colors.bold(`mihomo-cli v${VERSION}`)));
  console.log(`${colors.gray('内核: ')}${kv}`);
  console.log(`${colors.gray('数据目录: ')}${USER_DATA_DIR}`);
}
