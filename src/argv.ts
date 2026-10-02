import { DEFAULT_AUTO_UPDATE_TIMEOUT } from './constants.js';
import { CliError } from './errors.js';
import { matchValueFlagToken, START_RESTART_FLAGS, VALUE_FLAGS } from './flags.js';

/**
 * argv 解析：白名单校验、位置参数计数、带值选项取值、start 选项透传。
 * 带值选项的三种形式（exact / attached 短选项 / 等号长选项）统一走 flags.ts 登记表的
 * matchValueFlagToken 判定——白名单、取值、透传三处共用，不允许「白名单放行、
 * 解析器静默丢弃或回退默认」的漂移。
 */

/** 是否出现某布尔选项（短或长形式） */
export function hasFlag(args: string[] | undefined, short: string, long?: string): boolean {
  return !!args && (args.includes(short) || (long !== undefined && args.includes(long)));
}

/**
 * 校验 args 中的 flag 是否都在白名单内。拼错的 flag 被静默跳过会让用户以为选项生效了、
 * 实际行为完全没变，故未知即报错。**裸 `-` 不豁免**：本 CLI 没有「- 表示 stdin」的
 * 约定，静默吞掉它会让 `sub update -` 被当成无参形态去批量更新、`start -` 静默起
 * 默认代理——必须当未知选项报错。
 *
 * 带值选项的 attached 短选项（`-n200`）与等号长选项（`--lines=200`）由 matchValueFlagToken
 * 统一判定，且基础形式必须同时在白名单内（`logs` 认 `-n200` 但不认 `-u30000`）。
 * 布尔选项不接受任何附加形式（`-s x`、`--no-update=1` 一律报错）。
 */
export function assertKnownFlags(args: string[] | undefined, known: readonly string[], command: string): void {
  if (!args) return;
  const knownSet = new Set(known);
  for (const a of args) {
    if (!a.startsWith('-')) continue;
    if (knownSet.has(a)) continue;
    // 带值选项的非 exact 形式（`-n200` / `--lines=200`）：判定收口在 matchValueFlagToken
    const match = matchValueFlagToken(a);
    if (match && match.form !== 'exact' && knownSet.has(match.baseForm)) continue;
    // `--mirror` 故意不登记（见 flags.ts），等号形式仅在其自身白名单内放行
    if (a.startsWith('--mirror=') && knownSet.has('--mirror')) continue;
    // 白名单为空的命令（dir/stop 等不接受任何选项）不打「可用选项: 」——
    // 那会渲染成空列表，看着像是工具自己没填上。改说「该命令不接受任何选项」。
    // `-h`/`--help` 单独点一句：它俩是顶层 help 的别名、命令级并不接受，用户很自然会试
    const isHelpFlag = a === '-h' || a === '--help';
    const helpNote = isHelpFlag ? ['', `${a} 只在顶层可用，命令用法见: mihomo-cli help`] : [];
    // 单横线 + 多字符（`-name`、`-my-sub`）走到这里不是任何本命令选项形态：用户极可能
    // 是在填名称位置写了 `-` 开头（订阅名/文件名 argv 一律当选项拦）。判据取「本命令
    // 不带任何带值选项」——有带值选项时 `-n200`/`-u30000` 这类 attached 误用更可能是
    // 选项写法问题，「可用选项」列表即修正指引；单字符（`-x`）是拼错的短选项同理
    const hasValueFlag = known.some(f => VALUE_FLAGS.has(f));
    const looksLikeName = a.length > 2 && !a.startsWith('--') && !hasValueFlag;
    const nameNote = looksLikeName ? ['', `若这是在填写名称：名称不能以 \`-\` 开头（argv 会把它当选项拦截），请去掉前导 \`-\``] : [];
    throw new CliError(`未知的选项: ${a}`, {
      label: '参数错误',
      hint: [known.length > 0 ? `可用选项: ${known.join(', ')}` : '该命令不接受任何选项', ...helpNote, ...nameNote, '', `用法: mihomo-cli ${command}`],
    });
  }
}

/**
 * 校验非 flag 位置参数的个数不超过命令声明的上限（max），与 assertKnownFlags 配对：
 * flag 侧早已「未知即报错」，位置参数却只认第一个的话，`start mixed garbage` 会忽略
 * garbage 继续执行，不对称。
 *
 * 带值选项的值不算位置参数；跳值只在下一个 token **不是 flag** 时进行——`--mirror` 是
 * 可选值选项，裸写后跟 `--proxy 7897` 时它没有值，无条件跳会吞掉 `--proxy` 本身、
 * 把 7897 误判成多余位置参数。kernel 的 `--mirror` 不在 VALUE_FLAGS 里，调用方需经
 * valueFlags 传入自定义口径。
 */
export function assertPositionalCount(
  args: string[] | undefined,
  max: number,
  startIdx: number,
  usage: string,
  valueFlags: ReadonlySet<string> = VALUE_FLAGS,
): void {
  if (!args) return;
  let count = 0;
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      // 跳过该带值选项的值；值位置上是 flag 说明该选项没有值（可选值选项裸写）
      if (valueFlags.has(a) && i + 1 < args.length && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    count++;
    if (count > max) {
      throw new CliError(`多余的参数: ${a}`, {
        label: '参数错误',
        hint: [`用法: ${usage}`],
      });
    }
  }
}

/**
 * 解析整数选项。全部调用点语义上都是正整数，故 <1、非数字、带尾随垃圾（`5s`）一律
 * 抛错而非静默取值：`-u 5s` 静默取 5（ms）会让自动更新立刻超时。
 * 宁可报错也不给用户一个看似成功的错误结果。三种形式与 assertKnownFlags 同口径。
 * 重复给出（含 exact 与 attached/等号混写）显式报错，不静默取先者——「后写的没生效」
 * 正是 assertKnownFlags 头注释要防的形态，口径与 kernel 的 --mirror/--proxy 一致。
 */
export function parseIntArg(args: string[] | undefined, short: string, long: string, defaultValue: number): number {
  if (!args) return defaultValue;

  const parse = (raw: string, flag: string): number => {
    // 只接受纯十进制整数：parseInt('5s') === 5 会静默吞掉单位
    if (!/^\d+$/.test(raw.trim())) {
      throw new CliError(`选项 ${flag} 需要正整数，收到 "${raw}"`, { hint: [`例如: ${flag} ${defaultValue}`] });
    }
    const val = Number(raw);
    if (!Number.isSafeInteger(val) || val < 1) {
      throw new CliError(`选项 ${flag} 需要 >= 1 的整数，收到 "${raw}"`, { hint: [`例如: ${flag} ${defaultValue}`] });
    }
    return val;
  };

  // 顺序扫描：exact 命中若值缺失或值本身是 flag 形态（`-n -n`，用户漏写了值），
  // 立即按缺值/非法值报错——先记重复会把「漏值」误诊成「选项重复」，指向不存在的
  // 问题。值合法则跳过该值 token 继续找后续命中（重复才报重复）
  let first: { value: string; flag: string } | null = null;
  let count = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === short || args[i] === long) {
      if (first === null && count === 0) {
        // 第一个 exact 命中：值缺失按「缺少值」报（末尾 parse('') 只会报「收到空串」，
        // 不如缺值准）；随后跳过值 token——漏值形态（`-n -n`）的第二个 -n 是第一个
        // 的「值」，不会被数成第二次命中，最终按「需要正整数,收到 "-n"」报错
        if (i + 1 >= args.length) {
          throw new CliError(`选项 ${args[i]} 缺少值`, { hint: [`例如: ${args[i]} ${defaultValue}`] });
        }
        first = { value: args[i + 1], flag: args[i] };
        i++; // 跳过值 token
        count++;
        continue;
      }
      count++;
      continue;
    }
    const match = matchValueFlagToken(args[i]);
    if (match && match.form !== 'exact' && (match.spec.forms.includes(short) || match.spec.forms.includes(long))) {
      if (first === null && count === 0) {
        first = { value: match.inlineValue ?? '', flag: match.baseForm };
      }
      count++;
    }
  }
  if (count > 1) {
    const flag = first?.flag ?? short;
    throw new CliError(`选项 ${flag} 只能指定一次（出现 ${count} 次）`, { hint: [`例如: ${flag} ${defaultValue}`] });
  }
  if (first !== null) {
    return parse(first.value, first.flag);
  }
  return defaultValue;
}

/**
 * 从任意命令的 argv 中抽取 start 支持的启动选项（含其值），供 sub use / ow on|off 触发的
 * 重启透传——`mihomo-cli sub use foo -s` 里的 -s 等选项不透传的话，重启会走默认行为。
 * 选项集合从 flags.ts 的 START_RESTART_FLAGS 派生（单一登记表）。
 */
export function extractStartOptions(args: string[] | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    // 布尔 start 选项（-s / --no-update）：整 token 精确匹配
    if (START_RESTART_FLAGS.some(f => !f.takesValue && f.forms.includes(token))) {
      out.push(token);
      continue;
    }
    const match = matchValueFlagToken(token);
    if (!match?.spec.passthroughToRestart) continue;
    out.push(token);
    // 仅 exact 形式的值在下一个 token；attached / 等号形式自包含，透传整个 token 即可
    if (match.form === 'exact' && i + 1 < args.length) {
      out.push(args[++i]);
    }
  }
  return out;
}

/**
 * 提前校验重启透传选项的值形态。`sub use` / `ow on|off` 的白名单放行 START_RESTART_FLAGS
 * 是为了运行中重启时透传，但未运行、不触发重启时这些选项无人消费——`ow on -u`（缺值）、
 * `sub use foo -u5s`（非法值）必须在这里就报错，不能静默成功。
 * 解析结果不在这里用，cmdStart 重启时自行再取。
 */
export function assertRestartOptionValues(args: string[] | undefined): void {
  if (!args) return;
  parseIntArg(args, '-u', '--update-timeout', DEFAULT_AUTO_UPDATE_TIMEOUT);
}

/** 取第一个非 flag 位置参数（跳过带值选项的值，与 assertPositionalCount 同口径） */
export function getNonFlagArg(args: string[] | undefined, startIdx: number): string | null {
  if (!args) return null;
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++; // 跳过该带值选项的值
      continue;
    }
    return a;
  }
  return null;
}
