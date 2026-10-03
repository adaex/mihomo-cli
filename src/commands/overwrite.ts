import path from 'node:path';
import { assertKnownFlags, assertPositionalCount, assertRestartOptionValues } from '../argv.js';
import { colors } from '../colors.js';
import { START_RESTART_FLAGS } from '../flags.js';
import { isOverwriteEnabled, listOverwriteFile, setOverwriteEnabled } from '../overwrite.js';
import { dispatchSubcommand, restartToApply, type SubCommand, unknownSubcommandError } from './shared.js';

function printOverwriteList(): void {
  const info = listOverwriteFile();
  const statusText = info.enabled ? colors.green('已启用') : colors.yellow('已禁用');
  console.log(`${colors.gray('状态: ')}${statusText}`);
  console.log(`${colors.gray('位置: ')}${info.dir}`);
  console.log('');
  if (info.files.length === 0 && info.broken.length === 0) {
    console.log('暂无覆写文件');
    console.log('');
    console.log(`用法示例: 创建文件 ${path.join(info.dir, 'overwrite.yaml')}`);
    console.log(`         或        ${path.join(info.dir, 'overwrite.dns.yaml')}`);
    console.log('');
  } else {
    // 计数说「未禁用」而非「生效」：本列表看不到当前活跃订阅，无从判断 match 是否命中，
    // 真·生效清单在内核拒绝提示里（已按 match 过滤）。两处用不同措辞免得对不上。
    // 加载失败的文件不计入「N 个文件」，单独红字段落，避免与停用/不适用混淆
    const disabledCount = info.files.filter(f => !f.enabled).length;
    const countText =
      disabledCount > 0 ? `${info.files.length} 个，${info.files.length - disabledCount} 个未禁用，按顺序加载` : `${info.files.length} 个，按顺序加载`;
    console.log(`${colors.cyan('覆写文件')} (${countText}):`);
    console.log('');
    info.files.forEach((f, i) => {
      // 1 基编号两位对齐，与 sub 列表、logs 归档同口径（logs 的 0=当前是特有语义，不在此列）
      const seq = i + 1;
      const num = String(seq).padStart(2);
      const mark = f.enabled ? '' : ` ${colors.yellow('[已禁用]')}`;
      console.log(`  ${num}. ${f.name}${mark}`);
      if (f.scope) {
        console.log(`    ${colors.gray('作用域: ')}${f.scope}`);
      }
      if (f.kind === 'script') {
        console.log(`    ${colors.gray('类型: ')}JS 脚本（在全部 YAML 覆写之前执行；适用于当前订阅时末尾 return true，status 据此区分生效与不适用）`);
      } else if (f.keys.length > 0) {
        console.log(`    ${colors.gray('字段: ')}${f.keys.join(', ')}`);
      }
    });
    if (info.broken.length > 0) {
      console.log(colors.red(`加载失败 (${info.broken.length} 个，未参与合并；start/doctor 会报错):`));
      info.broken.forEach((b, i) => {
        const seq = info.files.length + i + 1;
        const num = String(seq).padStart(2);
        console.log(`  ${num}. ${colors.red(b.name)} ${colors.red('[加载失败]')}`);
        console.log(colors.red(`    ${b.message}`));
        // hint 是可执行的修复/迁移指引（改 JS 脚本、match 示例、加引号等），
        // 与 message 一起在诊断界面出齐，不留到启动硬失败才可见
        for (const line of b.hint) console.log(colors.gray(`    ${line}`));
      });
      console.log('');
    }
  }
  console.log('启用覆写: mihomo-cli ow on');
  console.log('禁用覆写: mihomo-cli ow off');
  // 看到 [已禁用] 标记却不知道怎么改回来，是这个功能最直接的死路
  console.log('停用单个文件: 在该文件顶部写 enabled: false');
  console.log('');
}

/** 切换覆写开关：已是目标状态则仅提示；否则写入并（运行中）重启生效。 */
async function setOverwrite(enabled: boolean, args: string[]): Promise<void> {
  // on/off 是唯一的位置 token：`ow on garbage` 此前静默忽略 garbage
  assertPositionalCount(args, 0, 2, 'mihomo-cli ow [on|off]');
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

const SUBCOMMANDS: SubCommand[] = [
  { name: 'on', aliases: ['enable'], handler: args => setOverwrite(true, args) },
  { name: 'off', aliases: ['disable'], handler: args => setOverwrite(false, args) },
];

/** ow on|off 放行的选项 = 重启透传集合（restartToApply → extractStartOptions 只认这些），从 flags.ts 单表派生，不手写第二份清单 */
const OW_ON_OFF_FLAGS: readonly string[] = START_RESTART_FLAGS.flatMap(f => f.forms);

export async function cmdOverwrite(args: string[]): Promise<void> {
  assertKnownFlags(args, OW_ON_OFF_FLAGS, 'ow [on|off]');
  await dispatchSubcommand(args, SUBCOMMANDS, {
    // 无子命令 → 列表；未知子命令 → 报错（守卫与 did-you-mean 拼装收口在 shared）
    fallback: () => {
      console.log('');
      printOverwriteList();
    },
    onUnknown: action =>
      unknownSubcommandError(action, SUBCOMMANDS, {
        what: '覆写子命令',
        // 重启透传选项必须跟在 on/off 后，裸 ow 不消费任何选项
        optionHint: ['裸 ow 只查看覆写状态，不接受选项', '', '用法: mihomo-cli ow on|off [-s] [-u ms]'],
        unknownHint: ['', '可用子命令: on, off'],
      }),
  });
}
