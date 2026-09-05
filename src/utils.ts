import { DEFAULT_MIRROR } from './constants.js';
import { CliError } from './errors.js';
import { START_RESTART_FLAGS, VALUE_FLAGS } from './flags.js';
import type { MirrorArg, SubscriptionUrgency } from './types.js';

/**
 * 通用纯函数小工具：sleep、字符串转义、格式化、flag 解析、did-you-mean。
 * 有 I/O 或独立职责的模块已拆出：colors.ts（颜色）、errors.ts（CliError/TimeoutError）、
 * http.ts（HTTP 客户端）、process-probe.ts（进程探测）。
 */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 转义正则特殊字符,把任意字符串当作正则字面量。
 * 用于 pgrep/pkill -f 的模式(否则路径中的 `.` 会被当通配符误匹配),以及构造 exclude-filter。
 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 单引号包裹并转义嵌入的单引号,安全地把任意字符串作为 bash 字面量(防御路径中的 `"`/`$`/反引号注入)。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 终端显示宽度：CJK 字符（含全角标点）占两列，其余按一列算。
 *
 * 不能用 `.length` 代替：帮助里的签名含中文占位符（`logs [编号]`、`--mirror [镜像]`），
 * 按码点数 padEnd 会让这些行的说明列少缩进几格，正是要修的错位本身。
 * 只覆盖本仓实际会出现的区间（CJK 统一表意文字、全角标点、中日韩符号），
 * 不追求完整的 East Asian Width 实现。
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
 * 与展示侧约定一致：download 与 total 都缺失时返回 null（调用方据此跳过整行），
 * 只缺 total 时仍展示已用（formatBytes(undefined) 兜底为「未知」）。
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
 * 相对时间（「3 小时前」），供订阅列表的更新时间等「距今多久」场景。
 * 未来时间（时钟偏移、缓存被手改）或非法值返回 null，由调用方回退绝对时间——
 * 未来时间显示成「N 分钟后」对「该不该更新」毫无意义，还会掩盖时钟问题。
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

/**
 * 订阅缓存的紧急度判定，status 着色与「代理不通」归因共用同一口径。
 * expire 为 unix 秒，0/缺省 = 永久；total 缺省 = 不限量。
 * 优先级：已过期 > 流量用尽 > 7 天内到期。
 */
export function subscriptionUrgency(
  entry: { expire?: number; upload?: number; download?: number; total?: number },
  nowMs: number = Date.now(),
): SubscriptionUrgency {
  if (entry.expire !== undefined && entry.expire > 0 && entry.expire * 1000 < nowMs) return 'expired';
  const used = (entry.upload || 0) + (entry.download || 0);
  if (entry.total !== undefined && entry.total > 0 && used >= entry.total) return 'traffic-exhausted';
  if (entry.expire !== undefined && entry.expire > 0 && entry.expire * 1000 - nowMs < 7 * 86_400_000) return 'expiring';
  return null;
}

export function hasFlag(args: string[] | undefined, short: string, long?: string): boolean {
  return !!args && (args.includes(short) || (long !== undefined && args.includes(long)));
}

/**
 * 解析整数选项。全部调用点（-n 行数 / -u 更新超时）语义上都是正整数，
 * 故 <1、非数字、带尾随垃圾（`5s`）一律抛错而非静默取值：
 * `-u 5s` 静默取 5（ms）会让自动更新立刻超时。
 * 宁可报错也不给用户一个看似成功的错误结果。
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === short || args[i] === long) {
      if (i + 1 < args.length) {
        return parse(args[i + 1], args[i]);
      }
      throw new CliError(`选项 ${args[i]} 缺少值`, { hint: [`例如: ${args[i]} ${defaultValue}`] });
    }
    if (args[i].startsWith(`${long}=`)) {
      return parse(args[i].slice(long.length + 1), long);
    }
  }
  return defaultValue;
}

/**
 * 拒绝已移除的 `--no-ssh`（v4.0.0 删掉 ssh 隧道功能）。
 *
 * 不能静默忽略：脚本里 `mihomo stop --no-ssh` 的原意是「停代理但保留隧道」，
 * 静默通过会让它变成「停代理」而用户不知道语义已变——同 `--mirror-all` 的口径，
 * 已移除的选项要显式报错并说清替代做法。
 *
 * 住在 utils 而非 commands/shared：后者 import 了 cmdStart，start 反向 import 会成环
 * （shared.ts 头部的「依赖方向单向」不变量）。
 */
export function assertNoRemovedSshFlag(args: string[] | undefined): void {
  if (!args?.some(a => a === '--no-ssh' || a.startsWith('--no-ssh='))) return;
  throw new CliError('--no-ssh 已移除（v4.0.0）', {
    label: '参数错误',
    hint: [
      'ssh 隧道功能已整体移除，该选项不再有对应行为。',
      '如仍需内网出口：自行运行 ssh -D 127.0.0.1:<端口> -N <主机>，',
      '节点与分流规则写在 overwrite.yaml 里（写法见 CHANGELOG 的 4.0.0 升级须知）。',
    ],
  });
}

/**
 * 从任意命令的 argv 中抽取 start 支持的启动选项（含其值），供 sub use / ow on|off 触发的重启透传。
 * 否则 `mihomo sub use foo -s` 里的 -s 等选项会被丢弃，重启仍走默认行为。
 *
 * 选项集合从 flags.ts 的 START_RESTART_FLAGS 派生（单一登记表），不再维护本地 BOOL_FLAGS。
 * `--opt=value` 等号形式按前缀匹配（仅长选项），整体作为一个 token 透传。
 */
export function extractStartOptions(args: string[] | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const spec = START_RESTART_FLAGS.find(f => f.forms.includes(a) || f.forms.some(form => form.startsWith('--') && a.startsWith(`${form}=`)));
    if (!spec) continue;
    out.push(a);
    // 带值选项且不是 --opt=value 形式：值是下一个 token，一并透传
    if (spec.takesValue && !a.includes('=')) {
      if (i + 1 < args.length) out.push(args[++i]);
    }
  }
  return out;
}

export function getNonFlagArg(args: string[] | undefined, startIdx: number, valueFlags: ReadonlySet<string> = VALUE_FLAGS): string | null {
  if (!args) return null;
  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (valueFlags.has(a)) i++; // 跳过该带值选项的值
      continue;
    }
    return a;
  }
  return null;
}

/** Levenshtein 编辑距离（两行滚动数组，O(min(m,n)) 空间；输入为命令 token，长度很短） */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * did-you-mean：从候选词中挑出与输入相近的词，按相似度升序返回（至多 3 个）。
 * 命中规则（大小写不敏感）：前缀匹配，或编辑距离 <= 2。无相近词返回空数组。
 */
export function suggestSimilar(input: string, candidates: readonly string[]): string[] {
  const lower = input.toLowerCase();
  const scored: { name: string; score: number; lenDiff: number }[] = [];
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    // 输入与候选完全一致（区分大小写）时不建议；仅大小写不同的仍建议（token 大小写易敲错）
    if (cand === input) continue;
    if (c.startsWith(lower)) {
      scored.push({ name: cand, score: 0, lenDiff: Math.abs(cand.length - input.length) });
    } else if (lower.length >= 3) {
      // 编辑距离只对 >= 3 字符的输入生效：两字符输入（如 su）与任意候选的距离都 <= 2，全是噪音
      const d = levenshtein(lower, c);
      if (d <= 2) scored.push({ name: cand, score: d, lenDiff: Math.abs(cand.length - input.length) });
    }
  }
  // 同分时优先长度接近的候选（su -> sub 优先于 subscription）
  scored.sort((a, b) => a.score - b.score || a.lenDiff - b.lenDiff);
  return scored.slice(0, 3).map(s => s.name);
}

/**
 * 归一化 `--mirror` 的值为 `https://host/` 形式。
 *
 * 用 `URL` 解析并**白名单 scheme**，不能只看 `startsWith('http')`：后者放行
 * `httpfoo://x`（原样留下非法 scheme）、放行明文 `http://`（镜像会中转内核二进制，
 * 该产物随后以 root 运行，不能走明文），还会把 `ftp://e.test` 拼成
 * `https://ftp://e.test/` 这种畸形串。裸主机名（`gh.example.com`）补 https。
 */
function normalizeMirrorUrl(val: string): string | null {
  if (!val) return null;
  if (val === 'direct' || val === 'no' || val === 'none') return null;

  // 无 scheme 的裸主机名补 https；有 scheme 的必须是 https
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val) ? val : `https://${val}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CliError(`镜像地址无效: "${val}"`, {
      label: '参数错误',
      hint: ['格式如: --mirror https://gh-proxy.org/ 或 --mirror gh-proxy.org', '不使用镜像: --no-mirror'],
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new CliError(`镜像地址必须使用 https: "${val}"`, {
      label: '参数错误',
      hint: ['镜像会中转内核二进制，该产物随后以 root 运行，不允许明文传输。'],
    });
  }

  const url = parsed.toString();
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * 解析 `--mirror`。镜像**只作用于产物下载**，GitHub API 恒直连：
 * API 若也走镜像，`browser_download_url` 就完全由镜像说了算，而内核产物随后
 * `chmod 755` 并在 TUN / 系统级服务下以 root 运行——上游不提供 checksums，
 * 把来源钉死（assertTrustedAssetUrl）是主要防线，不能让镜像自己指定下载地址。
 *
 * `savedMirror`（settings.kernel_mirror）是无显式选项时的回退：
 * 国内用户不必每次更新都带 `--mirror`。显式 `--mirror` 会记住偏好，
 * `--no-mirror`/`--direct` 本次直连并清除偏好。
 */
export function parseMirrorArg(args: string[] | undefined, savedMirror?: string | null): MirrorArg {
  if (!args || args.length < 2) {
    return savedMirror ? { mirror: savedMirror, isOverride: false } : { mirror: null, isOverride: false };
  }

  // 已移除的选项要显式报错，不能静默按直连继续：用户敲了 --mirror-all 却拿到直连行为，
  // 正是「不报错但行为不对」的失效方式（同 reset 的 KNOWN_FLAGS 口径）
  if (args.some(a => a === '--mirror-all' || a.startsWith('--mirror-all='))) {
    throw new CliError('--mirror-all 已移除（v3.10.0）', {
      label: '参数错误',
      hint: [
        '版本查询（GitHub API）现在恒直连，镜像只作用于内核产物下载。',
        'API 若走镜像，下载地址就由镜像说了算，而内核随后以 root 运行。',
        '',
        '改用: mihomo kernel --mirror [镜像]',
      ],
    });
  }

  if (args.includes('--no-mirror') || args.includes('--direct')) {
    return { mirror: null, isOverride: true, clearSaved: true };
  }

  // 同时支持 `--mirror url` 与 `--mirror=url` 两种形式
  const mirrorEq = args.find(a => a.startsWith('--mirror='));
  const mirrorIdx = args.indexOf('--mirror');
  if (mirrorIdx >= 0 || mirrorEq) {
    const inline = mirrorEq?.slice('--mirror='.length);
    const nextArg = inline ?? args[mirrorIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      // 显式表达「我要用镜像」：记住偏好，免得下次还要带
      return { mirror: DEFAULT_MIRROR, isOverride: true, remember: true };
    }
    // `--mirror direct` 等显式直连值：normalize 返回 null，按「直连并清除偏好」处理
    const normalized = normalizeMirrorUrl(nextArg);
    return normalized ? { mirror: normalized, isOverride: true, remember: true } : { mirror: null, isOverride: true, clearSaved: true };
  }

  // 无显式选项：回退已记住的偏好
  return savedMirror ? { mirror: savedMirror, isOverride: false } : { mirror: null, isOverride: false };
}
