/**
 * 字符串安全工具：把任意字符串安全地送进正则、bash、终端三个消费者。
 */

/** 转义正则特殊字符，把任意字符串当作正则字面量（pgrep/pkill -f 的模式、exclude-filter）。 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 单引号包裹并转义嵌入的单引号，安全地把任意字符串作为 bash 字面量（防御 `"`/`$`/反引号注入）。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 剥除终端控制字符与 ANSI 转义序列：服务器返回的字符串（订阅名、错误信息等）
 * 可能含 \x1b[2J（清屏）、光标上移等序列，伪造 CLI 输出。展示前必须消毒。
 * 保留 \t 和 \n，其余 C0 控制字符与 ESC 序列一律剥除。
 */
export function sanitizeTerminal(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 消毒必须匹配 ESC 序列
  const ansiEscape = /\x1b\[[0-9;]*[a-zA-Z]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 消毒必须匹配 C0 控制字符
  const controlChars = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
  return s.replace(ansiEscape, '').replace(controlChars, '');
}
