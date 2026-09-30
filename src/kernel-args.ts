import { assertKnownFlags } from './argv.js';
import { AVAILABLE_MIRRORS, MIRROR_ALIASES, MIRROR_BARE } from './constants.js';
import { CliError } from './errors.js';
import { matchValueFlagToken } from './flags.js';
import { suggestSimilar } from './suggest.js';
import type { MirrorArg, ProxyArg } from './types.js';

/**
 * kernel 命令的选项解析：`--mirror`（可选值）与 `--proxy`（带值）。
 * 镜像的语义边界（只作用产物下载、不作用 GitHub API、选择不持久化）见 docs/decisions.md D8。
 */

/** kernel 命令的选项白名单：两个解析器（mirror/proxy）共用的唯一清单 */
const KERNEL_FLAG_WHITELIST: readonly string[] = ['--mirror', '--proxy', '-p'];

/**
 * 归一化 `--mirror` 的值为 `https://host/` 形式。
 *
 * 用 `URL` 解析并**白名单 scheme**，不能只看 `startsWith('http')`：后者放行
 * `httpfoo://x`、放行明文 `http://`（镜像会中转内核二进制，该产物随后以 root 运行，
 * 不能走明文），还会把 `ftp://e.test` 拼成畸形串。裸主机名（`gh.example.com`）补 https。
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
 * 解析 `--mirror`。裸 `--mirror`（无值）= 强制走镜像、域用默认裸域；`--mirror direct` =
 * 强制直连。重复指定报错，不静默以第一个为准。空值（`--mirror=` / `--mirror ""`）报错，
 * 与 `--proxy=` 同姿态。
 *
 * hint 里直接列出可用镜像，不说「见 mihomo kernel --help」——`--help` 只是顶层 help 的
 * 别名，`kernel --help` 会撞上白名单报错，把人指向一个必定报错的命令比不给提示更糟。
 */
export function parseMirrorArg(args: string[] | undefined): MirrorArg {
  if (!args || args.length < 2) {
    return { mirror: null, isOverride: false };
  }

  // kernel 的选项校验白名单：--mirror（本函数消费）与 --proxy（parseProxyArg 消费）。
  // 两个解析器先后各跑一次同白名单的 assertKnownFlags（幂等），先跑的负责拦未知选项
  assertKnownFlags(args.slice(1), KERNEL_FLAG_WHITELIST, 'kernel [--mirror [镜像]] [--proxy <端口|地址>]');

  // 重复的 --mirror 报错，不静默以第一个为准
  const mirrorCount = args.filter(a => a === '--mirror' || a.startsWith('--mirror=')).length;
  if (mirrorCount > 1) {
    throw new CliError('--mirror 只能指定一次', {
      label: '参数错误',
      hint: ['用法: mihomo kernel [--mirror [镜像]]', `可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`, '不使用镜像: mihomo kernel --mirror direct'],
    });
  }

  // 同时支持 `--mirror url` 与 `--mirror=url` 两种形式
  const mirrorEq = args.find(a => a.startsWith('--mirror='));
  const mirrorIdx = args.indexOf('--mirror');
  if (mirrorIdx >= 0 || mirrorEq) {
    const inline = mirrorEq?.slice('--mirror='.length);
    if (inline === '' || (mirrorIdx >= 0 && args[mirrorIdx + 1] === '')) {
      throw new CliError('--mirror 的值不能为空（单独的 --mirror 表示使用默认镜像域）', {
        label: '参数错误',
        hint: ['用法: mihomo kernel [--mirror [镜像]]', `可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`, '不使用镜像: mihomo kernel --mirror direct'],
      });
    }
    const nextArg = inline ?? args[mirrorIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      return { mirror: MIRROR_BARE, isOverride: true };
    }
    // `--mirror direct`：normalize 返回 null，按强制直连处理
    const normalized = normalizeMirrorUrl(nextArg);
    return { mirror: normalized, isOverride: true };
  }

  return { mirror: null, isOverride: false };
}

/** 代理地址允许的协议（curl -x 口径）；与镜像的 https-only 不同，代理只做传输层，不限制明文 */
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/**
 * 把 `--proxy` 的值规范化为 curl -x 可用的代理地址（`协议//[userinfo@]host:port`）。
 * 纯数字端口补本机回环（`7897` → `http://127.0.0.1:7897`）；无 scheme 的 host:port 补
 * http://；带 scheme 的校验白名单后原样。
 *
 * 用原始串的 authority（`[user:pass@]host:port`）而非 URL.host 重组：
 * - URL.host 不含 userinfo，带认证的代理会被静默剥掉凭据，curl 拿到无认证地址连代理必 407
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
 * 解析 `--proxy`：显式指定更新内核时版本查询与下载共用的出网代理。显式给出时优先级
 * 高于自动通道与 gh（用户指定了出网路径，不再替他选）。`--mirror` 与 `--proxy` 可同用：
 * 镜像决定下载 URL，代理只做传输层；唯 `--mirror direct` 与 `--proxy` 互斥（该校验在
 * cmdKernel，需要两个解析器的结果）。重复指定报错。
 */
export function parseProxyArg(args: string[] | undefined): ProxyArg {
  if (!args || args.length < 2) {
    return { proxy: null };
  }

  assertKnownFlags(args.slice(1), KERNEL_FLAG_WHITELIST, 'kernel [--mirror [镜像]] [--proxy <端口|地址>]');

  // 三种形式（`--proxy 7897` / `-p7897` / `--proxy=7897`）统一走登记表 matchValueFlagToken
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
