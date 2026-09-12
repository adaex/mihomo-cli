/**
 * 设色判定（no-color.org 口径）：NO_COLOR 存在**且非空**才关色。
 * 此前用 `!== undefined` 判定，空串 `NO_COLOR=` 也会关色，与规范相悖。
 * isTTY 缺省（管道 / 重定向 / 非 tty 流）按无色处理。
 */
export function colorEnabled(noColor: string | undefined, isTTY: boolean | undefined): boolean {
  return !(noColor !== undefined && noColor !== '') && isTTY === true;
}

export interface Colorizer {
  bold: (s: unknown) => string;
  red: (s: unknown) => string;
  green: (s: unknown) => string;
  yellow: (s: unknown) => string;
  cyan: (s: unknown) => string;
  gray: (s: unknown) => string;
}

function createColors(enabled: boolean): Colorizer {
  const colorize = (code: string, str: unknown): string => (enabled ? `${code + String(str)}\x1b[0m` : String(str));
  return {
    bold: s => colorize('\x1b[1m', s),
    red: s => colorize('\x1b[31m', s),
    green: s => colorize('\x1b[32m', s),
    yellow: s => colorize('\x1b[33m', s),
    cyan: s => colorize('\x1b[36m', s),
    gray: s => colorize('\x1b[90m', s),
  };
}

/** 常规输出（stdout）的设色：按 stdout 是否终端判定。 */
export const colors = createColors(colorEnabled(process.env.NO_COLOR, process.stdout.isTTY));

/**
 * 错误渲染（stderr）的设色：按 **stderr** 是否终端判定，与 colors 分开。
 * `mihomo status | grep x` 时 stdout 是管道而 stderr 仍是终端——共用 colors 会跟着
 * stdout 把错误输出一并剥色。NO_COLOR 对两路同时生效。
 */
export const stderrColors = createColors(colorEnabled(process.env.NO_COLOR, process.stderr.isTTY));
