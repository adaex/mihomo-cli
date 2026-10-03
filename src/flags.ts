/**
 * 命令行选项的单一登记表。
 *
 * 新增选项只需在此加一条——`VALUE_FLAGS`（`getNonFlagArg` 跳过带值选项的值）、
 * start 的重启透传集合（`extractStartOptions`）与带值选项三种形式的判定
 * （`matchValueFlagToken`，`assertKnownFlags` / `parseIntArg` / `extractStartOptions` 共用）都从这里派生。
 *
 * 此前这几张表分别硬编码在 utils.ts 里，新增选项要记得多处同步登记，
 * 漏登记不报错但行为静默不对（`sub use foo -s` 丢选项、`logs -n 200` 的 200 被当位置参数）。
 * 单表派生后这类漂移在结构上不可能发生。
 *
 * 只登记**带值**选项与 **start 的选项**：
 * - 布尔选项（`-f`/`-y` 等）以 `-` 开头，`getNonFlagArg` 本就跳过，无需登记
 * - `'optional'` 的可选值选项（`--mirror`）同样登记：消费值时以下一 token 不是
 *   flag 为界，裸写（含末尾裸写、后跟其他选项）即「无值」
 */

export interface FlagSpec {
  /** 该选项的所有出现形式（如 `-s` 与 `--no-update`） */
  forms: readonly string[];
  /**
   * 取值方式：`'required'` = 值必填（空格分隔，如 `-n 200`）；
   * `'optional'` = 值可选（裸写合法，仅下一 token 非 flag 时消费它）；
   * `false` = 布尔选项。`--opt=value` 等号形式对前两者都成立，无需额外声明
   */
  takesValue: false | 'required' | 'optional';
  /** start 的选项：配置变更触发重启（`sub use` / `ow on|off`）时是否透传给重启 */
  passthroughToRestart?: boolean;
}

/** 登记表本体。测试遍历它锁定「白名单接受 ⟹ 下游解析器可消费」的不变量 */
export const FLAGS: readonly FlagSpec[] = [
  // === start 的选项（重启透传） ===
  { forms: ['-s', '--no-update'], takesValue: false, passthroughToRestart: true },
  { forms: ['-u', '--update-timeout'], takesValue: 'required', passthroughToRestart: true },
  // === logs 的选项 ===
  { forms: ['-n', '--lines'], takesValue: 'required' },
  // === kernel 的选项 ===
  { forms: ['-p', '--proxy'], takesValue: 'required' },
  // `--mirror`（kernel）是可选值选项：裸 `--mirror` = 默认镜像域，`--mirror direct`
  // 与 `--mirror=url` 同样合法。词法（三种形式/跳值边界）随登记表走，与 --proxy
  // 同一套白名单与位置参数口径；值的归一化（别名/https/direct）仍由 parseMirrorArg 负责
  { forms: ['--mirror'], takesValue: 'optional' },
];

/**
 * 带值选项集合（含可选值）：`getNonFlagArg` / `assertPositionalCount` 借此跳过选项
 * 的值。可选值选项只在下一 token 非 flag 时跳值（消费点各自判），裸写不吞后续选项
 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set(FLAGS.filter(f => f.takesValue !== false).flatMap(f => f.forms));

/** start 的选项：配置变更触发重启时透传（`extractStartOptions` 用） */
export const START_RESTART_FLAGS: readonly FlagSpec[] = FLAGS.filter(f => f.passthroughToRestart);

/** 上述选项的全部出现形式：start / sub use / ow on|off 的 `assertKnownFlags` 白名单三处共用，
 * 与重启透传集合同源（配置变更触发的重启走 restartToApply → extractStartOptions，只认这些选项） */
export const START_RESTART_FLAG_FORMS: readonly string[] = START_RESTART_FLAGS.flatMap(f => f.forms);

/** 带值选项在 argv 中出现的三种形式 */
export type ValueFlagForm = 'exact' | 'attached-short' | 'long-eq';

/** `matchValueFlagToken` 的命中结果 */
export interface ValueFlagTokenMatch {
  /** 命中的登记条目 */
  spec: FlagSpec;
  /** 匹配到的基础形式：exact 即 token 本身；attached-short 为前缀短选项；long-eq 为等号前部分 */
  baseForm: string;
  form: ValueFlagForm;
  /** token 内联携带的值（attached-short 与 long-eq 有，可能为空串；exact 的值在下一个 token） */
  inlineValue: string | null;
}

/**
 * 判定一个 argv token 是否是某个**带值**选项的可消费形式：
 * - exact：`-n` / `--lines`（值在下一个 token）
 * - attached-short：`-n200`（短选项紧贴值，自包含 token，仅单字符短选项）
 * - long-eq：`--lines=200`（自包含 token）
 *
 * 这是三套解析（`assertKnownFlags` 白名单、`parseIntArg` 取值、`extractStartOptions`
 * 透传）的单一真相源：三种形式要么都认、要么都不认，不允许「白名单放行、解析器
 * 静默丢弃或回退默认」的漂移（`-u5s` 白名单放行却回退默认、`-u30000` 透传丢选项
 * 都曾是这个形态）。
 *
 * 布尔选项（takesValue: false）与未登记选项不匹配任何非 exact 形式——
 * attached / 等号形式只对带值选项合法，`-s x` / `--no-update=1` 一律按未知选项报错。
 */
export function matchValueFlagToken(token: string): ValueFlagTokenMatch | null {
  const byForm = (form: string): FlagSpec | undefined => FLAGS.find(f => f.takesValue !== false && f.forms.includes(form));

  const exact = byForm(token);
  if (exact) return { spec: exact, baseForm: token, form: 'exact', inlineValue: null };

  if (token.startsWith('--')) {
    // --opt=value：等号前部分须是已登记的长选项（eqIdx > 2 排除 `--=x` 这类畸形）
    const eqIdx = token.indexOf('=');
    if (eqIdx > 2) {
      const base = token.slice(0, eqIdx);
      const spec = byForm(base);
      if (spec) return { spec, baseForm: base, form: 'long-eq', inlineValue: token.slice(eqIdx + 1) };
    }
    return null;
  }

  // attached 短选项：`-n200`。长选项不接受紧贴值（`--lines200` 不是合法形式）
  if (token.length > 2 && token.startsWith('-')) {
    const base = token.slice(0, 2);
    const spec = byForm(base);
    if (spec) return { spec, baseForm: base, form: 'attached-short', inlineValue: token.slice(2) };
  }
  return null;
}
