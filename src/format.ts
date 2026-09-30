/**
 * 终端显示宽度与数值/时间格式化。纯函数，展示侧共用同一口径
 * （status 与 sub 列表的流量、到期、相对时间都从这里出）。
 */

/**
 * 终端显示宽度：CJK 字符（含全角标点）占两列，其余按一列算。
 * 不能用 `.length` 代替：帮助里的签名含中文占位符（`logs [编号]`），按码点数 padEnd
 * 会让说明列错位。只覆盖本仓实际出现的区间，不追求完整的 East Asian Width 实现。
 */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1100 && code <= 0x115f) || // 韩文字母
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首 … 注音、统一表意文字
      (code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意文字
      (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) || // 全角字母数字与标点
      (code >= 0xffe0 && code <= 0xffe6);
    width += isWide ? 2 : 1;
  }
  return width;
}

/** 按显示宽度右侧补空格（padEnd 的 CJK 安全版本）。 */
export function padEndDisplay(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

export function formatBytes(bytes: unknown): string {
  if (bytes === undefined || bytes === null) return '未知';
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 0) return '未知';
  if (num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((num / k ** i).toFixed(2))} ${sizes[i]}`;
}

/**
 * 格式化订阅流量「已用 / 总量 (百分比)」。status 与 sub 列表两处共用同一口径。
 * download 与 total 都缺失时返回 null（调用方据此跳过整行）；只缺 total 时仍展示已用。
 */
export function formatTraffic(upload: number | undefined, download: number | undefined, total: number | undefined): string | null {
  if (download === undefined && total === undefined) return null;
  const used = (upload || 0) + (download || 0);
  let line = `${formatBytes(used)} / ${formatBytes(total)}`;
  if (total && total > 0) {
    line += ` (${Math.min((used / total) * 100, 100).toFixed(1)}%)`;
  }
  return line;
}

export function formatTimestamp(ts: unknown): string {
  if (ts === undefined || ts === null) return '未知';
  // 机场以 expire=0（或缺省）表示永久/无限期，不能显示成 1970-01-01
  if (ts === 0) return '永久';
  try {
    return new Date((ts as number) * 1000).toLocaleString('zh-CN');
  } catch {
    return '未知';
  }
}

/** 本地时间戳，用于归档文件名（yyyy-MM-dd_HH-mm-ss）；与列表展示的本地 mtime 时区一致。 */
export function formatLocalTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export function formatDate(dateOrIso: unknown): string {
  if (dateOrIso === undefined || dateOrIso === null) return '未知';
  try {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso as string);
    if (Number.isNaN(d.getTime())) return '未知';
    return d.toLocaleString('zh-CN');
  } catch {
    return '未知';
  }
}

/**
 * 相对时间（「3 小时前」）。未来时间（时钟偏移、缓存被手改）或非法值返回 null，
 * 由调用方回退绝对时间——未来时间显示成「N 分钟后」对「该不该更新」毫无意义，
 * 还会掩盖时钟问题。
 */
export function formatRelativeTime(dateOrIso: unknown, nowMs: number = Date.now()): string | null {
  if (dateOrIso === undefined || dateOrIso === null) return null;
  let t: number;
  try {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso as string);
    t = d.getTime();
  } catch {
    return null;
  }
  if (Number.isNaN(t) || t > nowMs) return null;
  const sec = Math.floor((nowMs - t) / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}
