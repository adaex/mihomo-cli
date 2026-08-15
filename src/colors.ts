const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

function colorize(code: string, str: unknown): string {
  if (NO_COLOR) return String(str);
  return `${code + String(str)}\x1b[0m`;
}

export const colors = {
  bold: (s: unknown) => colorize('\x1b[1m', s),
  red: (s: unknown) => colorize('\x1b[31m', s),
  green: (s: unknown) => colorize('\x1b[32m', s),
  yellow: (s: unknown) => colorize('\x1b[33m', s),
  cyan: (s: unknown) => colorize('\x1b[36m', s),
  gray: (s: unknown) => colorize('\x1b[90m', s),
};
