import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { DEFAULT_MIRROR } from './constants.js';
import type { HttpClient, HttpClientOptions, HttpResponse, MirrorArg } from './types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const VERSION: string = pkg.version;

/** HTTP 响应体大小上限（50MB）：订阅/内核产物远小于此，超限视为异常（劫持/故障）并中止，防 OOM。 */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

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

export class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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

export function parseIntArg(args: string[] | undefined, short: string, long: string, defaultValue: number): number {
  if (!args) return defaultValue;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === short || args[i] === long) {
      if (i + 1 < args.length) {
        const val = parseInt(args[i + 1], 10);
        return Number.isNaN(val) ? defaultValue : val;
      }
    } else if (args[i].startsWith(`${long}=`)) {
      const val = parseInt(args[i].slice(long.length + 1), 10);
      if (!Number.isNaN(val)) return val;
    }
  }
  return defaultValue;
}

/**
 * 需要「跳过其后一个值」的选项名（空格分隔、带整数值），与全部 parseIntArg 调用一一对应。
 * getNonFlagArg 识别位置参数时借此避免把 `-t 3000` 里的 `3000` 误当位置参数。
 * 注意：--mirror/--mirror-all 是可选值选项、只走 parseMirrorArg，故意不收录。
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['-t', '--timeout', '-j', '--concurrency', '-r', '--rounds', '-n', '--lines', '-u', '--update-timeout']);

/**
 * 从任意命令的 argv 中抽取 start 支持的启动选项（含其值），供 sub use / ow on|off 触发的重启透传。
 * 否则 `mihomo sub use foo -s` 里的 -s 等选项会被丢弃，重启仍走默认行为。
 */
export function extractStartOptions(args: string[] | undefined): string[] {
  if (!args) return [];
  const BOOL_FLAGS = new Set(['-s', '--no-update', '--no-clean']);
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

export function isProcessRunning(pid: number): boolean {
  if (!pid) return false;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8', timeout: 5000 });
    return (result.stdout || '').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * 校验 pid 对应进程的命令行是否包含指定子串（防 PID 复用误杀：pid 文件残留后该 pid 可能已被
 * 系统分配给无关进程）。读不到命令行时保守返回 false。
 */
export function isProcessCommandMatching(pid: number, needle: string): boolean {
  if (!pid) return false;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 });
    return (result.stdout || '').includes(needle);
  } catch {
    return false;
  }
}

export function isProcessRoot(pid: number): boolean {
  if (!pid) return false;
  try {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'uid='], { encoding: 'utf8', timeout: 5000 });
    return (result.stdout || '').trim() === '0';
  } catch {
    return false;
  }
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const { timeout = 60_000, secret } = options;
  // 访问带鉴权的 external-controller 时附带 Bearer token；secret 为空则退化为无鉴权（订阅下载等外部 HTTP 不受影响）
  const authHeaders: Record<string, string> = secret ? { Authorization: `Bearer ${secret}` } : {};

  return {
    async get<T = string>(url: string, config?: { responseType?: 'text' | 'json'; signal?: AbortSignal }): Promise<HttpResponse<T>> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const signal = config?.signal ? AbortSignal.any([controller.signal, config.signal]) : controller.signal;
      try {
        const response = await fetch(url, {
          signal,
          headers: { 'User-Agent': `mihomo-cli/${VERSION}`, ...authHeaders },
        });
        if (!response.ok) {
          const error: Error & { response?: { status: number; data?: Record<string, unknown> } } = new Error(`HTTP ${response.status}`);
          error.response = { status: response.status };
          try {
            error.response.data = (await response.json()) as Record<string, unknown>;
          } catch {
            // ignore json parse errors
          }
          throw error;
        }
        // 提前拒绝声明超大的响应，避免把 GB 级 body 读进内存（订阅/内核下载被劫持或故障时的 OOM 防护）
        const declaredLen = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLen) && declaredLen > MAX_RESPONSE_BYTES) {
          throw new Error(`响应体过大（${formatBytes(declaredLen)}，上限 ${formatBytes(MAX_RESPONSE_BYTES)}）`);
        }
        const text = await readBodyWithLimit(response, controller);
        const data = config?.responseType === 'json' ? JSON.parse(text) : text;
        return { data: data as T, headers: response.headers, status: response.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * 流式读取响应体并强制大小上限：即使服务端不声明 Content-Length（分块传输），
 * 累计超过 MAX_RESPONSE_BYTES 也立即 abort 中止，避免边读边膨胀撑爆内存。
 */
async function readBodyWithLimit(response: Response, controller: AbortController): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new Error(`响应体超过大小上限（${formatBytes(MAX_RESPONSE_BYTES)}）`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
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

export function isProxyValid(proxy: { name: string; [k: string]: unknown }): boolean {
  if (!proxy.name || !proxy.server || !proxy.port) return false;
  if (!proxy.type) return false;
  if (proxy.type === 'ss' && typeof proxy.cipher === 'string' && proxy.cipher.startsWith('2022-blake3')) {
    const pw = String(proxy.password || '');
    // 兼容 base64 与 base64url（- _ 替代 + /）编码的 SS2022 密钥
    if (!/^[A-Za-z0-9+/\-_]+=*$/.test(pw) || pw.length < 20) return false;
  }
  return true;
}
