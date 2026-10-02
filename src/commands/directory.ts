import { assertKnownFlags, assertPositionalCount } from '../argv.js';
import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { openUrl } from '../open.js';
import { DIRECTORY_TARGETS, USER_DATA_DIR } from '../paths.js';
import { dispatchSubcommand, type SubCommand, unknownSubcommandError } from './shared.js';

function openDirectory(args: string[]): void {
  // 目标至多一个：`dir open logs extra` 此前静默忽略 extra
  assertPositionalCount(args, 1, 2, 'mihomo-cli dir open [root|subs|logs|data|runtime|kernel]');
  const target = args[2];

  // 路径无条件打印：openUrl 是 detached spawn，检不出失败（见 open.ts），
  // 打出来用户即便没弹出 Finder 也能自己点开。
  // 只有未传参才默认 root：空串（`dir open ""`，变量展开为空的笔误）此前也打开根目录
  if (target === undefined || target === 'root') {
    console.log(`正在打开: 根目录 (${USER_DATA_DIR})`);
    openUrl(USER_DATA_DIR);
    return;
  }

  const key = target.toLowerCase();
  const targetInfo = Object.hasOwn(DIRECTORY_TARGETS, key) ? DIRECTORY_TARGETS[key] : undefined;
  if (targetInfo) {
    const targetPath = targetInfo.path || USER_DATA_DIR;
    console.log(`正在打开: ${targetInfo.label} (${targetPath})`);
    openUrl(targetPath);
    return;
  }

  const hint = ['', '可用目标:', '  root (默认)   根目录'];
  for (const [k, val] of Object.entries(DIRECTORY_TARGETS)) {
    if (k !== 'root') {
      hint.push(`  ${k.padEnd(14)}${val.label}`);
    }
  }
  throw new CliError(`未知的目录目标 "${target}"`, { hint });
}

/** 目录一览：路径从 DIRECTORY_TARGETS 生成，不再硬编码目录树说明（与 README 重复且易失同步）。 */
function printDirectoryInfo(): void {
  const entries = Object.entries(DIRECTORY_TARGETS).filter(([key]) => key !== 'root');
  // 路径列按最长项对齐；padEnd 作用在无颜色的原串上，避免 ANSI 码算进宽度
  const pathWidth = Math.max(...entries.map(([, val]) => (val.path as string).replace(USER_DATA_DIR, '.').length));

  console.log('');
  console.log(`数据目录: ${USER_DATA_DIR}`);
  console.log('');
  for (const [key, val] of entries) {
    const rel = (val.path as string).replace(USER_DATA_DIR, '.');
    console.log(`  ${key.padEnd(9)}${rel.padEnd(pathWidth + 2)}${colors.gray(val.label)}`);
  }
  console.log('');
  console.log(`打开目录: mihomo-cli dir open [${Object.keys(DIRECTORY_TARGETS).join('|')}]`);
  console.log(colors.gray('  自定义根目录: 环境变量 MIHOMO_CLI_DIR'));
  console.log('');
}

const SUBCOMMANDS: SubCommand[] = [{ name: 'open', handler: openDirectory }];

export async function cmdDirectory(args: string[]): Promise<void> {
  assertKnownFlags(args.slice(1), [], 'dir');
  // 无子命令 → 目录信息；未知子命令 → 报错（与 sub/ow 同构，避免 `dir opn` 静默当成 list）
  // 必须 await/返回 Promise：dispatchSubcommand 是 async，若用 void 丢弃，onUnknown 抛的
  // CliError 会变成未处理的 Promise 拒绝，绕过 main().catch 的统一渲染（丢 label/hint）
  await dispatchSubcommand(args, SUBCOMMANDS, {
    fallback: printDirectoryInfo,
    // 裸 dir 只展示目录信息（选项由分发前的白名单统一拦）；守卫收口在 shared
    onUnknown: action =>
      unknownSubcommandError(action, SUBCOMMANDS, {
        what: '目录子命令',
        optionHint: ['裸 dir 只展示目录信息，不接受选项', '', '用法: mihomo-cli dir open [root|subs|logs|data|runtime|kernel]'],
        unknownHint: ['', '可用子命令: open', '打开指定目录: mihomo-cli dir open <target>'],
      }),
  });
}
