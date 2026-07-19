import { getKernelVersion } from '../config.js';
import { USER_DATA_DIR } from '../paths.js';
import { colors, VERSION } from '../utils.js';

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

export function printHelp(): void {
  console.log(
    `\n${colors.cyan(colors.bold(`mihomo-cli v${VERSION}`))}\n` +
      '\n' +
      '命令别名: mihomo, mhm, mh\n' +
      '\n' +
      '用法:\n' +
      '  mihomo <命令> [选项]\n' +
      '\n' +
      `${colors.cyan('控制:')}\n` +
      `  ${colors.bold('start')} [tun|mixed] [-s] [-u ms]     启动/切换代理 (默认 mixed)\n` +
      `        [-r N] [-t ms] [-j N]\n` +
      `  ${colors.bold('stop')}                         停止代理\n` +
      `  ${colors.bold('status')}                       查看状态\n` +
      '\n' +
      `${colors.cyan('界面:')}\n` +
      `  ${colors.bold('ui')} [zash|dash|yacd]          打开 Web UI (默认 zash)\n` +
      `  ${colors.bold('log')} [-o]                     实时日志（-o 打开文件）\n` +
      `  ${colors.bold('logs')} [编号] [-n N] [-o]      日志列表（0=当前，1+=归档）\n` +
      '\n' +
      `${colors.cyan('订阅:')}\n` +
      `  ${colors.bold('subscription')}                 列出所有订阅（别名 sub）\n` +
      `  ${colors.bold('subscription')} use <name>      切换当前订阅\n` +
      `  ${colors.bold('subscription')} add <url> [name]  添加订阅\n` +
      `  ${colors.bold('subscription')} update [name]   更新订阅（无参更新所有）\n` +
      `  ${colors.bold('subscription')} remove <name>   删除订阅\n` +
      `  ${colors.bold('subscription')} web [name]      打开订阅页面\n` +
      `  ${colors.bold('subscription')} test [name]     测试节点连通性\n` +
      `  ${colors.bold('subscription')} clean [name]    测速并清理失败节点\n` +
      `  ${colors.bold('test')} [-t ms] [-j N]           快速测试当前节点连通性\n` +
      `  ${colors.bold('clean')} [-t ms] [-j N] [-r N]   清理失败节点并自动重启\n` +
      '\n' +
      `${colors.cyan('配置:')}\n` +
      `  ${colors.bold('overwrite')}                   查看覆写状态（别名 ow）\n` +
      `  ${colors.bold('overwrite')} on|off            启用/禁用覆写配置\n` +
      `  ${colors.bold('directory')}                   显示数据目录位置（别名 dir）\n` +
      `  ${colors.bold('directory')} open [target]     打开目录: root|subs|logs|runtime|...\n` +
      '\n' +
      `${colors.cyan('系统:')}\n` +
      `  ${colors.bold('kernel')} [--mirror [镜像]]         更新内核（默认直连，--mirror 使用 v6）\n` +
      `  ${colors.bold('daemon')} on|off               开机自启 + 崩溃重启（仅 Mixed，需管理员密码）\n` +
      `  ${colors.bold('daemon')} status               查看保活状态\n` +
      `  ${colors.bold('update')}                       更新 mihomo-cli (npm install -g)\n` +
      `  ${colors.bold('reset')} [目标...] [--full]   重置: 留空保留设置/内核/覆写, 指定目标删对应项, --full 删全部\n` +
      `  ${colors.bold('help')}, -h                     显示帮助\n` +
      `  ${colors.bold('version')}, -v                  显示版本\n` +
      '\n' +
      `${colors.cyan('示例:')}\n` +
      '  mihomo start              # 启动/重启 Mixed 模式\n' +
      '  mihomo start tun          # 切换到 TUN 透明代理模式\n' +
      '  mihomo start -s           # 跳过自动更新订阅\n' +
      '  mihomo start -u 30000     # 自动更新超时 30 秒 (默认 10s)\n' +
      '  mihomo daemon on          # 开启保活（开机自启 + 崩溃重启）\n' +
      '  mihomo sub add <url>      # 添加订阅 (sub 是 subscription 别名)\n' +
      '  mihomo ui                 # 打开 Web UI\n' +
      '\n' +
      `${colors.cyan('模式说明:')}\n` +
      '  mixed  HTTP + SOCKS5 混合端口 (默认)\n' +
      '  tun    透明代理，全局自动路由，需要 sudo\n' +
      '\n' +
      `${colors.cyan('数据目录:')}\n` +
      '  环境变量 MIHOMO_CLI_DIR 可自定义位置\n' +
      `  默认: ${USER_DATA_DIR}\n`,
  );
}

export function printVersion(): void {
  const kv = getKernelVersion() || '未安装';
  console.log(colors.cyan(colors.bold(`mihomo-cli v${VERSION}`)));
  console.log(`${colors.gray('内核: ')}${kv}`);
  console.log(`${colors.gray('数据目录: ')}${USER_DATA_DIR}`);
}
