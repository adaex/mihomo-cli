/**
 * 命令行选项的单一登记表。
 *
 * 新增选项只需在此加一条——`VALUE_FLAGS`（`getNonFlagArg` 跳过带值选项的值）
 * 与 start 的重启透传集合（`extractStartOptions`）都从这里派生。
 *
 * 此前这两张表分别硬编码在 utils.ts 里，新增选项要记得两处同步登记，
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

const FLAGS: FlagSpec[] = [
  // === start 的选项（重启透传） ===
  { forms: ['-s', '--no-update'], takesValue: false, passthroughToRestart: true },
  { forms: ['-u', '--update-timeout'], takesValue: true, passthroughToRestart: true },
  // === logs 的选项 ===
  { forms: ['-n', '--lines'], takesValue: true },
  // 注意：`--mirror`（kernel）是可选值选项——`--mirror`、`--mirror=url`、`--mirror url`
  // 三种形式都合法，只走 parseMirrorArg。故意不在此登记：登记了 getNonFlagArg 反而会
  // 把它的值吞掉。它的移除/校验由 parseMirrorArg 自己负责。
];

/** 带值选项集合：`getNonFlagArg` 借此跳过选项的值，不把它误当位置参数 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set(FLAGS.filter(f => f.takesValue).flatMap(f => f.forms));

/** start 的选项：配置变更触发重启时透传（`extractStartOptions` 用） */
export const START_RESTART_FLAGS: readonly FlagSpec[] = FLAGS.filter(f => f.passthroughToRestart);
