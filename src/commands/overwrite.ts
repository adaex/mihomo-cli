import path from 'node:path';
import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { isOverwriteEnabled, listOverwriteFile, setOverwriteEnabled } from '../overwrite.js';
import { suggestSimilar } from '../utils.js';
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
    console.log(`${colors.cyan('覆写文件')} (${info.files.length} 个，按顺序加载):`);
    console.log('');
    info.files.forEach((f, i) => {
      const num = i < 10 ? ` ${i}` : `${i}`;
      console.log(`  ${num}. ${f.name}`);
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
  console.log('');
}

/** 切换覆写开关：已是目标状态则仅提示；否则写入并（运行中）重启生效。 */
async function setOverwrite(enabled: boolean, args: string[]): Promise<void> {
  if (isOverwriteEnabled() === enabled) {
    console.log(`覆写配置已是${enabled ? '启用' : '禁用'}状态`);
    console.log('');
    printOverwriteList();
    return;
  }

  setOverwriteEnabled(enabled);
  console.log(`已${enabled ? '启用' : '禁用'}覆写配置`);

  // 运行中(含保活)才重启使覆写生效
  if (await restartToApply(args)) return;

  console.log('');
  printOverwriteList();
}

const SUBCOMMANDS: SubCommand[] = [
  { name: 'on', aliases: ['enable'], handler: args => setOverwrite(true, args) },
  { name: 'off', aliases: ['disable'], handler: args => setOverwrite(false, args) },
];

export async function cmdOverwrite(args: string[]): Promise<void> {
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无子命令 → 列表；未知子命令 → 报错（与 sub/daemon 同构，避免 `ow onn` 静默当成 list）
    fallback: () => {
      console.log('');
      printOverwriteList();
    },
    onUnknown: action => {
      const names = SUBCOMMANDS.flatMap(c => [c.name, ...(c.aliases ?? [])]);
      const suggestion = suggestSimilar(action, names);
      throw new CliError(`未知的覆写子命令: ${action}`, {
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), '', '可用子命令: on, off'],
      });
    },
  });
}
