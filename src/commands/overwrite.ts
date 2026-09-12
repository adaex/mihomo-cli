import path from 'node:path';
import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { isOverwriteEnabled, listOverwriteFile, setOverwriteEnabled } from '../overwrite.js';
import { assertKnownFlags, assertPositionalCount, assertRestartOptionValues, suggestSimilar } from '../utils.js';
import { dispatchSubcommand, restartToApply, type SubCommand } from './shared.js';

function printOverwriteList(): void {
  const info = listOverwriteFile();
  const statusText = info.enabled ? colors.green('已启用') : colors.yellow('已禁用');
  console.log(`${colors.gray('状态: ')}${statusText}`);
  console.log(`${colors.gray('位置: ')}${info.dir}`);
  console.log('');
  if (info.files.length === 0) {
    console.log('暂无覆写文件');
    console.log('');
    console.log(`用法示例: 创建文件 ${path.join(info.dir, 'overwrite.yaml')}`);
    console.log(`         或        ${path.join(info.dir, 'overwrite.dns.yaml')}`);
    console.log('');
  } else {
    // 计数说「未禁用」而非「生效」：本列表看不到当前活跃订阅，无从判断 match 是否命中，
    // 真·生效清单在内核拒绝提示里（已按 match 过滤）。两处用不同措辞免得对不上
    const disabledCount = info.files.filter(f => !f.enabled).length;
    const countText =
      disabledCount > 0 ? `${info.files.length} 个，${info.files.length - disabledCount} 个未禁用，按顺序加载` : `${info.files.length} 个，按顺序加载`;
    console.log(`${colors.cyan('覆写文件')} (${countText}):`);
    console.log('');
    info.files.forEach((f, i) => {
      const num = i < 10 ? ` ${i}` : `${i}`;
      const mark = f.enabled ? '' : ` ${colors.yellow('[已禁用]')}`;
      console.log(`  ${num}. ${f.name}${mark}`);
      if (f.scope) {
        console.log(`    ${colors.gray('作用域: ')}${f.scope}`);
      }
      if (f.keys.length > 0) {
        console.log(`    ${colors.gray('字段: ')}${f.keys.join(', ')}`);
      }
    });
    console.log('');
  }
  console.log('启用覆写: mihomo ow on');
  console.log('禁用覆写: mihomo ow off');
  // 看到 [已禁用] 标记却不知道怎么改回来，是这个功能最直接的死路
  console.log('停用单个文件: 在该文件顶部写 enabled: false');
  console.log('');
}

/** 切换覆写开关：已是目标状态则仅提示；否则写入并（运行中）重启生效。 */
async function setOverwrite(enabled: boolean, args: string[]): Promise<void> {
  // on/off 是唯一的位置 token：`ow on garbage` 此前静默忽略 garbage
  assertPositionalCount(args, 0, 2, 'mihomo ow [on|off]');
  // 即使未在运行、不触发重启，-u 缺值/非法值也在此刻报错，不静默吞掉
  assertRestartOptionValues(args);
  if (isOverwriteEnabled() === enabled) {
    console.log(`覆写配置已是${enabled ? '启用' : '禁用'}状态`);
    console.log('');
    printOverwriteList();
    return;
  }

  setOverwriteEnabled(enabled);
  console.log(`已${enabled ? '启用' : '禁用'}覆写配置`);

  // 运行中(服务或 TUN)才重启使覆写生效
  if (await restartToApply(args)) return;

  console.log('');
  printOverwriteList();
}

export const SUBCOMMANDS: SubCommand[] = [
  { name: 'on', aliases: ['enable'], description: '启用覆写', handler: args => setOverwrite(true, args) },
  { name: 'off', aliases: ['disable'], description: '禁用覆写', handler: args => setOverwrite(false, args) },
];

export async function cmdOverwrite(args: string[]): Promise<void> {
  assertKnownFlags(args, ['-s', '--no-update', '-u', '--update-timeout'], 'ow [on|off]');
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无子命令 → 列表；未知子命令 → 报错（与 sub/dir 同构，避免 `ow onn` 静默当成 list）
    fallback: () => {
      console.log('');
      printOverwriteList();
    },
    onUnknown: action => {
      // 选项出现在子命令位置：裸 ow 只展示状态，重启透传选项必须跟在 on/off 后
      if (action.startsWith('-')) {
        throw new CliError(`未知的选项: ${action}`, {
          label: '参数错误',
          hint: ['裸 ow 只查看覆写状态，不接受选项', '', '用法: mihomo ow on|off [-s] [-u ms]'],
        });
      }
      const names = SUBCOMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
      const suggestion = suggestSimilar(action, names);
      throw new CliError(`未知的覆写子命令: ${action}`, {
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), '', '可用子命令: on, off'],
      });
    },
  });
}
