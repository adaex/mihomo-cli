import { DEFAULT_MIRROR } from './constants.js';
import { CliError } from './errors.js';
import type { MirrorArg } from './types.js';

/**
 * 通用纯函数小工具：sleep、字符串转义、格式化、flag 解析、did-you-mean。
 * 有 I/O 或独立职责的模块已拆出：colors.ts（颜色）、errors.ts（CliError/TimeoutError）、
 * http.ts（HTTP 客户端）、process.ts（进程探测）。
 */

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

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

export function hasFlag(args: string[] | undefined, short: string, long?: string): boolean {
  return !!args && (args.includes(short) || (long !== undefined && args.includes(long)));
}

/**
 * 解析整数选项。全部调用点（-t 超时 / -j 并发 / -r 轮次 / -n 行数 / -u 更新超时）
 * 语义上都是正整数，故 <1、非数字、带尾随垃圾（`5s`）一律抛错而非静默取值：
 * `-j 0` 会让测速起 0 个 worker，结果数组全是空洞，被报成「所有节点失败」（伪造结果）；
 * `-t 5s` 静默取 5（ms）会让全部节点超时。宁可报错也不给用户一个看似成功的错误结果。
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
 * 解析字符串选项（`--host m4` 与 `--host=m4` 两形式）。未提供返回 null。
 * 与 parseIntArg 一样对「有选项名但缺值」抛错，而非静默取 undefined——
 * `tunnel add work --host` 若静默通过，会在后面报一个与真实原因无关的错。
 */
export function parseStringArg(args: string[] | undefined, long: string, short?: string): string | null {
  if (!args) return null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === long || (short !== undefined && args[i] === short)) {
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        return args[i + 1];
      }
      throw new CliError(`选项 ${args[i]} 缺少值`, { hint: [`例如: ${long} <值>`] });
    }
    if (args[i].startsWith(`${long}=`)) {
      const value = args[i].slice(long.length + 1);
      if (!value) throw new CliError(`选项 ${long} 缺少值`, { hint: [`例如: ${long}=<值>`] });
      return value;
    }
  }
  return null;
}

/**
 * 需要「跳过其后一个值」的选项名（空格分隔、带值），与全部 parseIntArg / parseStringArg 调用一一对应。
 * getNonFlagArg 识别位置参数时借此避免把 `-t 3000` 里的 `3000` 误当位置参数。
 * 注意：--mirror/--mirror-all 是可选值选项、只走 parseMirrorArg，故意不收录。
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-t',
  '--timeout',
  '-j',
  '--concurrency',
  '-r',
  '--rounds',
  '-n',
  '--lines',
  '-u',
  '--update-timeout',
  '--host',
  '--port',
]);

/**
 * 从任意命令的 argv 中抽取 start 支持的启动选项（含其值），供 sub use / ow on|off 触发的重启透传。
 * 否则 `mihomo sub use foo -s` 里的 -s 等选项会被丢弃，重启仍走默认行为。
 */
export function extractStartOptions(args: string[] | undefined): string[] {
  if (!args) return [];
  const BOOL_FLAGS = new Set(['-s', '--no-update', '--no-clean', '--no-tunnel']);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      out.push(a);
      if (i + 1 < args.length) out.push(args[++i]);
    } else if (BOOL_FLAGS.has(a) || /^--(timeout|concurrency|rounds|update-timeout)=/.test(a)) {
      out.push(a);
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

function normalizeMirrorUrl(val: string): string | null {
  if (!val) return null;
  if (val === 'direct' || val === 'no' || val === 'none') return null;

  let url = val;
  if (!url.startsWith('http')) {
    url = `https://${url}`;
  }
  if (!url.endsWith('/')) {
    url += '/';
  }
  return url;
}

export function parseMirrorArg(args: string[] | undefined): MirrorArg {
  if (!args || args.length < 2) {
    return { mirror: null, isOverride: false, type: 'download' };
  }

  if (args.includes('--no-mirror') || args.includes('--direct')) {
    return { mirror: null, isOverride: true, type: 'download' };
  }

  // 同时支持 `--mirror url` 与 `--mirror=url` 两种形式
  const mirrorAllEq = args.find(a => a.startsWith('--mirror-all='));
  const mirrorAllIdx = args.indexOf('--mirror-all');
  if (mirrorAllIdx >= 0 || mirrorAllEq) {
    const inline = mirrorAllEq?.slice('--mirror-all='.length);
    const nextArg = inline ?? args[mirrorAllIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      return { mirror: DEFAULT_MIRROR, isOverride: true, type: 'all' };
    }
    return { mirror: normalizeMirrorUrl(nextArg), isOverride: true, type: 'all' };
  }

  const mirrorEq = args.find(a => a.startsWith('--mirror='));
  const mirrorIdx = args.indexOf('--mirror');
  if (mirrorIdx >= 0 || mirrorEq) {
    const inline = mirrorEq?.slice('--mirror='.length);
    const nextArg = inline ?? args[mirrorIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      return { mirror: DEFAULT_MIRROR, isOverride: true, type: 'download' };
    }
    return { mirror: normalizeMirrorUrl(nextArg), isOverride: true, type: 'download' };
  }

  return { mirror: null, isOverride: false, type: 'download' };
}
