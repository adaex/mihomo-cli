import { AVAILABLE_MIRRORS, DEFAULT_AUTO_UPDATE_TIMEOUT, MIRROR_ALIASES, MIRROR_BARE } from './constants.js';
import { CliError } from './errors.js';
import { matchValueFlagToken, START_RESTART_FLAGS, VALUE_FLAGS } from './flags.js';
import type { MirrorArg, ProxyArg, SubscriptionUrgency } from './types.js';

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

/**
 * 剥除终端控制字符与 ANSI 转义序列：服务器返回的字符串（订阅名、错误信息等）
 * 可能含 \x1b[2J（清屏）、光标上移等序列，伪造 CLI 输出。展示前必须消毒。
 * 保留 \t（制表）和 \n（换行），其余 C0 控制字符与 ESC 序列一律剥除。
 */
export function sanitizeTerminal(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 消毒必须匹配 ESC 序列
  const ansiEscape = /\x1b\[[0-9;]*[a-zA-Z]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 消毒必须匹配 C0 控制字符
  const controlChars = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
  return s.replace(ansiEscape, '').replace(controlChars, '');
}

/** 单引号包裹并转义嵌入的单引号,安全地把任意字符串作为 bash 字面量(防御路径中的 `"`/`$`/反引号注入)。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 回环主机名判定（127.0.0.1 / localhost / ::1），忽略大小写。
 * env 自代理判定（proxyEnvPointsAtSelf）与系统代理指向判定（system-proxy）共用，
 * 不各自维护清单——任何一边扩集都会让两个判定悄悄漂移。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * 判定一个代理环境变量的值（http_proxy/https_proxy/all_proxy，大小写两种形式）
 * 是否指向**本机自己的 Mixed 端口**——这是唯一必须清除的形态：下载订阅/内核时
 * 流量经自己的代理，而重启过程中旧内核会先被停掉，形成下载死锁。
 *
 * 指向其他任何地址（企业网络的 env 代理、别的代理工具）都必须保留：无差别清除会让
 * 只能靠 env 代理出网的用户在 update/kernel 时全部直连失败，且报错与代理无关。
 *
 * 接受的形态：`http://127.0.0.1:7890`、`socks5://localhost:7890`、
 * 以及无协议的裸 `127.0.0.1:789`（all_proxy 的常见写法，补协议再解析）。
 * 纯函数，host 比较去方括号、忽略大小写；无端口或解析失败一律不判为自代理。
 */
export function proxyEnvPointsAtSelf(value: string, selfPort: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    try {
      parsed = new URL(`http://${value}`);
    } catch {
      return false;
    }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!isLoopbackHost(host)) return false;
  return Number.parseInt(parsed.port, 10) === selfPort;
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
 * 校验 args 中的 flag 是否都在白名单内。拼错的 flag（如 `logs -F`）此前被静默跳过，
 * 用户以为选项生效了，实际行为完全没变。仅 `kernel`/`reset` 有此校验，其余命令靠这里补齐。
 *
 * 白名单同时接受短/长形式（`-n` 与 `--lines`）。带值选项的 attached 短选项（`-n200`）与
 * 等号长选项（`--lines=200`）由登记表的 `matchValueFlagToken` 统一判定，且基础形式必须
 * 同时在该命令的白名单内（`logs` 认 `-n200` 但不认 `-u30000`）。布尔选项不接受任何
 * 附加形式（`-s x`、`--no-update=1` 一律报错）。`--mirror` 是可选值选项，不在登记表，
 * 其等号形式由 parseMirrorArg 调用时的白名单单独放行。
 */
export function assertKnownFlags(args: string[] | undefined, known: readonly string[], command: string): void {
  if (!args) return;
  const knownSet = new Set(known);
  for (const a of args) {
    if (!a.startsWith('-') || a === '-') continue;
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
    const helpNote = isHelpFlag ? ['', `${a} 只在顶层可用，命令用法见: mihomo help`] : [];
    throw new CliError(`未知的选项: ${a}`, {
      label: '参数错误',
      hint: [known.length > 0 ? `可用选项: ${known.join(', ')}` : '该命令不接受任何选项', ...helpNote, '', `用法: mihomo ${command}`],
    });
  }
}

/**
 * 校验非 flag 位置参数的个数不超过命令声明的上限（max）。
 *
 * 与 assertKnownFlags 配对：flag 侧早已「未知即报错」，位置参数却只认第一个——
 * `start mixed garbage` 会忽略 garbage 继续执行，与「未知命令、子命令和选项统一报错」
 * 的产品边界不对称。带值选项的值不算位置参数（与 getNonFlagArg 同一跳值口径），
 * `sub use name -u 5000`、`logs 3 -f` 这类合法形态不受影响。
 *
 * 跳值只在下一个 token **不是 flag** 时进行：`--mirror` 是可选值选项，裸写后跟
 * `--proxy 7897` 时它没有值，无条件跳会吞掉 `--proxy` 本身、把 7897 误判成多余位置
 * 参数（四种等价组合写法里 exact 形式被拒、等号形式却通过）。必带值选项的值以 `-`
 * 开头时本就是各解析器的报错形态，不跳不影响最终报错。
 *
 * kernel 的 `--mirror` 是可选值选项、不在 VALUE_FLAGS 里（见 flags.ts 注释），
 * 调用方需经 valueFlags 传入，否则 `kernel --mirror cdn` 的镜像地址会被误计为位置参数。
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
 * 解析整数选项。全部调用点（-n 行数 / -u 更新超时）语义上都是正整数，
 * 故 <1、非数字、带尾随垃圾（`5s`）一律抛错而非静默取值：
 * `-u 5s` 静默取 5（ms）会让自动更新立刻超时。
 * 宁可报错也不给用户一个看似成功的错误结果。
 *
 * 三种形式与 assertKnownFlags / extractStartOptions 共用 matchValueFlagToken 的判定：
 * exact（`-u 30000`）、attached 短选项（`-u30000`）、等号长选项（`--update-timeout=30000`）。
 * attached 后缀非纯数字（`-u5s`）与短选项带等号（`-u=3000`，后缀 `=3000`）走同一条
 * 报错路径——此前 attached 不匹配 `/^\d+$/` 时静默返回默认值，与函数自己的注释矛盾。
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
    // attached 短选项 / 等号长选项：形式判定统一走登记表，只有属于本选项的 token 才消费
    const match = matchValueFlagToken(args[i]);
    if (match && match.form !== 'exact' && (match.spec.forms.includes(short) || match.spec.forms.includes(long))) {
      return parse(match.inlineValue ?? '', match.baseForm);
    }
  }
  return defaultValue;
}

/**
 * 从任意命令的 argv 中抽取 start 支持的启动选项（含其值），供 sub use / ow on|off 触发的重启透传。
 * 否则 `mihomo sub use foo -s` 里的 -s 等选项会被丢弃，重启仍走默认行为。
 *
 * 选项集合从 flags.ts 的 START_RESTART_FLAGS 派生（单一登记表）。布尔选项按整 token
 * 精确匹配；带值选项的三种形式（exact / attached 短选项 / 等号长选项）由 matchValueFlagToken
 * 统一判定——attached 与等号形式自包含，整个 token 原样透传，不得吞下一个 token 当值。
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
    // 带值 start 选项：三种形式统一判定，attached（-u30000）不再被静默丢弃
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
 * 提前校验重启透传选项的值形态（`-u/--update-timeout` 的三种形式）。
 *
 * `sub use` / `ow on|off` 的白名单放行 START_RESTART_FLAGS 是为了运行中重启时透传，
 * 但未运行、不触发重启时这些选项此前无人消费：`ow on -u`（缺值）、`sub use foo -u5s`
 * （非法值）静默成功，正是「用户以为选项生效了，实际行为完全没变」的形态。
 * 故与白名单同一步提前校验；解析结果不在这里用，cmdStart 重启时自行再取。
 * `-s/--no-update` 是布尔选项，无需校验。
 */
export function assertRestartOptionValues(args: string[] | undefined): void {
  if (!args) return;
  parseIntArg(args, '-u', '--update-timeout', DEFAULT_AUTO_UPDATE_TIMEOUT);
}

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
  if (val === 'direct') return null;

  // 短别名：cdn/v4/v6/axisnow → https://<别名>.gh-proxy.org/
  const alias = MIRROR_ALIASES[val.toLowerCase()];
  if (alias) return alias;

  // 无 scheme、无点无冒号的短 token 既不是别名也不是主机名/URL——主机名必含点。
  // 放行会被当裸主机名补 https，经 punycode 转换后展示成一串认不出的主机名，
  // 下载注定失败；按「拼错的别名」报错并给 did-you-mean（口径同命令层纠错）。
  // 纯数字（把 --mirror 当 --proxy 用、只给了个端口）单独点一句正确用法
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val) && !val.includes('.') && !val.includes(':')) {
    const suggestions = suggestSimilar(val, [...Object.keys(MIRROR_ALIASES), 'direct']);
    throw new CliError(`未知的镜像别名: "${val}"`, {
      label: '参数错误',
      hint: [
        ...(suggestions.length > 0 ? [`是否想输入: ${suggestions.join(' / ')}?`] : []),
        ...(/^\d+$/.test(val) ? ['指定代理端口请用: --proxy <端口>'] : []),
        `可用别名: ${Object.keys(MIRROR_ALIASES).join(', ')}`,
        '自定义镜像请用主机名或完整 URL: --mirror gh-proxy.org / --mirror https://gh-proxy.org/',
      ],
    });
  }

  // 无 scheme 的裸主机名补 https；有 scheme 的必须是 https
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val) ? val : `https://${val}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CliError(`镜像地址无效: "${val}"`, {
      label: '参数错误',
      hint: ['格式如: --mirror cdn（短别名）或 --mirror gh-proxy.org 或 --mirror https://gh-proxy.org/', '不使用镜像: --mirror direct'],
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
 * 解析 `--mirror`。镜像**只作用于产物下载**，GitHub API 绝不经过镜像：
 * API 若也走镜像，`browser_download_url` 就完全由镜像说了算，而内核产物随后
 * `chmod 755` 并在 TUN / 系统级服务下以 root 运行——上游不提供 checksums，
 * 把来源钉死（assertTrustedAssetUrl）是主要防线，不能让镜像自己指定下载地址。
 *
 * 镜像选择**不持久化**：每次调用按当前环境独立决策（gh/代理是否可用），
 * 记住偏好反而会在换环境后用到错误的镜像。
 */
export function parseMirrorArg(args: string[] | undefined): MirrorArg {
  if (!args || args.length < 2) {
    return { mirror: null, isOverride: false };
  }

  // kernel 的选项校验白名单：--mirror（本函数消费）与 --proxy（parseProxyArg 消费）。
  // 两个解析器先后各跑一次同白名单的 assertKnownFlags（幂等），先跑的负责拦未知选项
  assertKnownFlags(args.slice(1), KERNEL_FLAG_WHITELIST, 'kernel [--mirror [镜像]] [--proxy <端口|地址>]');

  // 重复的 --mirror 此前静默以第一个为准，显式报错而非让用户以为后者生效
  const mirrorCount = args.filter(a => a === '--mirror' || a.startsWith('--mirror=')).length;
  if (mirrorCount > 1) {
    throw new CliError('--mirror 只能指定一次', {
      label: '参数错误',
      // 直接列出镜像，不说「见 mihomo kernel --help」：命令级 `--help` 并不存在
      // （`--help` 只是顶层 help 的别名，`kernel --help` 会撞 assertKnownFlags 报
      // 「未知的选项」），把用户指向一个必定报错的命令比不给提示更糟
      hint: ['用法: mihomo kernel [--mirror [镜像]]', `可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`, '不使用镜像: mihomo kernel --mirror direct'],
    });
  }

  // 同时支持 `--mirror url` 与 `--mirror=url` 两种形式
  const mirrorEq = args.find(a => a.startsWith('--mirror='));
  const mirrorIdx = args.indexOf('--mirror');
  if (mirrorIdx >= 0 || mirrorEq) {
    const inline = mirrorEq?.slice('--mirror='.length);
    const nextArg = inline ?? args[mirrorIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      // 显式表达「我要用镜像」：默认走裸域；需要 v4/v6/cdn 子域时显式写别名
      return { mirror: MIRROR_BARE, isOverride: true };
    }
    // `--mirror direct`：normalize 返回 null，按强制直连处理
    const normalized = normalizeMirrorUrl(nextArg);
    return { mirror: normalized, isOverride: true };
  }

  return { mirror: null, isOverride: false };
}

/** kernel 命令的选项白名单：两个解析器（mirror/proxy）共用的唯一清单 */
const KERNEL_FLAG_WHITELIST: readonly string[] = ['--mirror', '--proxy', '-p'];

/** 代理地址允许的协议（curl -x 口径）；与镜像的 https-only 不同，代理只做传输层，不限制明文 */
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/**
 * 把 `--proxy` 的值规范化为 curl -x 可用的代理地址（`协议//[userinfo@]host:port`）。
 * 纯数字端口补本机回环（`7897` → `http://127.0.0.1:7897`）；
 * 无 scheme 的 host:port 补 http://；带 scheme 的校验白名单后原样。
 *
 * 用原始串的 authority（`[user:pass@]host:port`）而非 URL.host 重组：
 * - URL.host 不含 userinfo，带认证的代理（`http://user:pass@proxy:8080`）会被静默剥掉
 *   凭据，curl 拿到无认证地址连代理必 407，错误里却没有任何「凭据被丢」的线索
 * - WHATWG URL 会剥掉与协议默认值相同的显式端口（`http://x:80` 的 port 为空），
 *   「需要端口」的校验若只看 parsed.port 会把用户亲眼写了的端口误报成缺失
 */
function normalizeProxyUrl(val: string): string {
  if (/^\d+$/.test(val)) {
    const port = Number(val);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new CliError(`代理端口无效: "${val}"`, { label: '参数错误', hint: ['端口范围 1-65535，例如: --proxy 7897'] });
    }
    return `http://127.0.0.1:${port}`;
  }
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(val) ? val : `http://${val}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new CliError(`代理地址无效: "${val}"`, {
      label: '参数错误',
      hint: ['格式如: --proxy 7897（视为 127.0.0.1:7897）', '      --proxy 127.0.0.1:7897', '      --proxy socks5://127.0.0.1:7897'],
    });
  }
  if (!PROXY_SCHEMES.has(parsed.protocol)) {
    throw new CliError(`代理协议不支持: "${val}"`, { label: '参数错误', hint: [`支持的协议: ${[...PROXY_SCHEMES].map(s => s.replace(':', '')).join(', ')}`] });
  }
  if (!parsed.hostname) {
    throw new CliError(`代理地址无效: "${val}"（缺少主机名）`, { label: '参数错误', hint: ['例如: --proxy 127.0.0.1:7897'] });
  }
  // authority = scheme 后到首个 /?# 之前的整段（含 userinfo 与端口）。
  // 显式默认端口（:80/:443）保留原样；无端口的代理地址对本地代理工具几乎必是笔误，
  // 要求显式端口，避免「以为配了代理、实际连到默认端口」的静默错路
  const authority = withScheme.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').split(/[/?#]/)[0];
  if (!/:\d+$/.test(authority)) {
    throw new CliError(`代理地址需要端口: "${val}"`, { label: '参数错误', hint: ['例如: --proxy 127.0.0.1:7897'] });
  }
  return `${parsed.protocol}//${authority}`;
}

/**
 * 解析 `--proxy`：显式指定更新内核时版本查询与下载共用的出网代理。
 * 它是「本机代理」自动通道的手动版——mihomo 自己没在跑、但本机有别的代理工具时使用；
 * 显式给出时优先级高于自动通道与 gh（用户指定了出网路径，不再替他选）。
 *
 * `--mirror` 与 `--proxy` 可同用：镜像决定下载 URL，代理只做传输层（TLS 端到端），
 * 与「代理开着时经本机代理」的既有语义一致；唯 `--mirror direct` 与 `--proxy` 互斥
 * （direct 的语义是绕过一切代理），该校验在 cmdKernel 里（需要两个解析器的结果）。
 */
export function parseProxyArg(args: string[] | undefined): ProxyArg {
  if (!args || args.length < 2) {
    return { proxy: null };
  }

  assertKnownFlags(args.slice(1), KERNEL_FLAG_WHITELIST, 'kernel [--mirror [镜像]] [--proxy <端口|地址>]');

  // 三种形式（`--proxy 7897` / `-p7897` / `--proxy=7897`）统一走登记表的
  // matchValueFlagToken 判定，不手写 indexOf/find——后者会漏「同形态重复」的计数
  const hits: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const match = matchValueFlagToken(args[i]);
    if (!match?.spec.forms.includes('--proxy')) continue;
    if (match.form === 'exact') {
      hits.push(args[i + 1] ?? '');
      i++;
    } else {
      hits.push(match.inlineValue ?? '');
    }
  }
  if (hits.length === 0) {
    return { proxy: null };
  }
  // 重复的 --proxy 与 --mirror 同判：静默取第一个会让用户以为后者生效
  if (hits.length > 1) {
    throw new CliError('--proxy 只能指定一次', {
      label: '参数错误',
      hint: ['用法: mihomo kernel --proxy <端口|地址>', '例如: mihomo kernel --proxy 7897'],
    });
  }

  const raw = hits[0].trim();
  if (!raw || raw.startsWith('-')) {
    throw new CliError('--proxy 需要一个端口或代理地址', {
      label: '参数错误',
      hint: ['例如: --proxy 7897（视为 127.0.0.1:7897）', '      --proxy 127.0.0.1:7897 或 --proxy socks5://127.0.0.1:7897'],
    });
  }
  return { proxy: normalizeProxyUrl(raw) };
}
