/**
 * 字符串安全工具：把任意字符串安全地送进正则、bash、终端三个消费者，
 * 以及把 URL 里的凭据遮蔽后再展示（maskUrl）。
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
 * 可能含 \x1b[2J（清屏）、光标上移、\r 回行首覆盖等序列，伪造 CLI 输出。
 * 展示前必须消毒。\r 必须剥：它与 \n 不同，不换行而是回行首覆盖已输出内容
 * （把 `✗ 校验失败` 覆盖成 `✓ 校验通过`）。
 * 保留 \t 和 \n，其余 C0 控制字符与 ESC 序列一律剥除。
 */
export function sanitizeTerminal(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 消毒必须匹配 ESC 序列
  const ansiEscape = /\x1b\[[0-9;]*[a-zA-Z]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 消毒必须匹配 C0 控制字符
  const controlChars = /[\x00-\x08\x0b\x0c\x0d\x0e-\x1f]/g;
  return s.replace(ansiEscape, '').replace(controlChars, '');
}

/**
 * 取 curl stderr 的末行并剥掉 `curl: (N)` 前缀，得到一行可读原因；无内容返回 undefined。
 * 内核版本查询与代理连通性探测两处的 curl 失败同口径，别各写一份（格式漂移则诊断说法不一）。
 */
export function lastCurlErrorLine(stderr: unknown): string | undefined {
  const text = typeof stderr === 'string' || Buffer.isBuffer(stderr) ? stderr.toString().trim() : '';
  const lastLine = text ? text.split('\n').pop() : undefined;
  return lastLine ? lastLine.replace(/^curl: \(\d+\)\s*/, '') : undefined;
}

/** maskUrl 的 token 参数名黑名单（值可能很短，如 ?token=abc）。键唯一由 text.spec 断言锁定 */
export const TOKEN_KEY_NAMES = [
  'token',
  'key',
  'secret',
  'pass',
  'password',
  'auth',
  'access_token',
  'api_key',
  'uuid',
  'sid',
  'id',
  'sub',
  'user',
  'email',
  'passwd',
  'apikey',
  'access',
];
const TOKEN_KEYS = new Set(TOKEN_KEY_NAMES);

/**
 * 遮蔽 URL 中的敏感信息（query token / userinfo / 路径型令牌）。
 * 不对逗号做任何切分：逗号在 query/path 中合法（`?nodes=us,hk&token=xxx`），
 * 切开后两段都不含可识别的 token 参数，反而会让密钥明文输出。
 *
 * 住在 text.ts 而非 settings.ts：纯字符串变换、与设置零耦合——底层 http.ts 也要用，
 * 放数据模块会让传输层反向依赖整个 settings。
 */
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // 启发式：值长度 ≥16 的 query 参数一律遮蔽（token 几乎都是长串，误伤率低）。
    // 黑名单永远枚举不完（uuid/sid/id 等都曾漏网），启发式更耐久。
    for (const [key, value] of parsed.searchParams) {
      if (TOKEN_KEYS.has(key.toLowerCase()) || value.length >= 16) {
        parsed.searchParams.set(key, '***');
      }
    }
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    // 路径型 token（如 /api/v1/client/subscribe/<长串>）：对疑似令牌的长路径段做遮蔽，
    // 保留结构可读。阈值 16，保留首尾 4 位便于用户辨认是哪条订阅。
    parsed.pathname = parsed.pathname
      .split('/')
      .map(seg => (seg.length >= 16 ? `${seg.slice(0, 4)}***${seg.slice(-4)}` : seg))
      .join('/');
    return parsed.toString();
  } catch {
    // 无法解析的畸形输入（复制不全的订阅 URL、误把整条 token 当 URL 粘入等）：
    // 只保留前缀——token 位于 query（尾部）或整条就是凭据，保头舍尾既留排错线索
    // （scheme/host 在头部）又不把凭据带进错误消息（fuzz 抓出旧「前15...后10」
    // 会展示尾部 10 字符）。截断阈值与前缀等宽：≤15 原样（泄漏上限与截断保留量
    // 等量），>15 一律截断——「短就安全」不成立，短串可能整条就是凭据
    if (url.length > 15) {
      return `${url.slice(0, 15)}...`;
    }
    return url;
  }
}
