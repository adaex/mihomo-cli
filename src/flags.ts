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
 * - `--mirror` 是可选值选项，只走 `parseMirrorArg`，故意不登记（见下方注释）
 */

export interface FlagSpec {
  /** 该选项的所有出现形式（如 `-s` 与 `--no-update`） */
  forms: readonly string[];
  /** 是否带值（空格分隔，如 `-n 200`）；`--opt=value` 等号形式无需在此声明 */
  takesValue: boolean;
  /** start 的选项：配置变更触发重启（`sub use` / `ow on|off`）时是否透传给重启 */
  passthroughToRestart?: boolean;
}

/** 登记表本体。测试遍历它锁定「白名单接受 ⟹ 下游解析器可消费」的不变量 */
export const FLAGS: readonly FlagSpec[] = [
  // === start 的选项（重启透传） ===
  { forms: ['-s', '--no-update'], takesValue: false, passthroughToRestart: true },
  { forms: ['-u', '--update-timeout'], takesValue: true, passthroughToRestart: true },
  // === logs 的选项 ===
  { forms: ['-n', '--lines'], takesValue: true },
  // 注意：`--mirror`（kernel）是可选值选项——`--mirror`、`--mirror=url`、`--mirror url`
  // 三种形式都合法，只走 parseMirrorArg。故意不在此登记：登记了 getNonFlagArg 反而会
  // 把它的值吞掉。它的解析与校验由 parseMirrorArg 自己负责。
];

/** 带值选项集合：`getNonFlagArg` 借此跳过选项的值，不把它误当位置参数 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set(FLAGS.filter(f => f.takesValue).flatMap(f => f.forms));

/** start 的选项：配置变更触发重启时透传（`extractStartOptions` 用） */
export const START_RESTART_FLAGS: readonly FlagSpec[] = FLAGS.filter(f => f.passthroughToRestart);

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
 * `--mirror` 不在登记表内，同样不匹配（由 parseMirrorArg 自管）。
 */
export function matchValueFlagToken(token: string): ValueFlagTokenMatch | null {
  const byForm = (form: string): FlagSpec | undefined => FLAGS.find(f => f.takesValue && f.forms.includes(form));

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
