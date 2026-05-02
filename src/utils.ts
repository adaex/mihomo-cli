import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

import type { HttpClient, HttpClientOptions, HttpResponse, MirrorArg } from './types.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const VERSION: string = pkg.version;

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

export function formatBytes(bytes: unknown): string {
  if (bytes === undefined || bytes === null) return '未知';
  const num = Number(bytes);
  if (Number.isNaN(num) || num < 0) return '未知';
  if (num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(num) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((num / k ** i).toFixed(2))} ${sizes[i]}`;
}

export function formatTimestamp(ts: unknown): string {
  if (ts === undefined || ts === null) return '未知';
  try {
    return new Date((ts as number) * 1000).toLocaleString('zh-CN');
  } catch {
    return '未知';
  }
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

export function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) as number;
    if (
      code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe6f) ||
        (code >= 0xff01 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x20000 && code <= 0x2fffd) ||
        (code >= 0x30000 && code <= 0x3fffd))
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export function hasFlag(args: string[] | undefined, short: string, long: string): boolean {
  return !!args && (args.includes(short) || args.includes(long));
}

export function parseIntArg(args: string[] | undefined, short: string, long: string, defaultValue: number): number {
  if (!args) return defaultValue;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === short || args[i] === long) {
      if (i + 1 < args.length) {
        const val = parseInt(args[i + 1], 10);
        return Number.isNaN(val) ? defaultValue : val;
      }
    }
  }
  return defaultValue;
}

export function getNonFlagArg(args: string[] | undefined, startIdx: number): string | null {
  if (!args) return null;
  for (let i = startIdx; i < args.length; i++) {
    if (!args[i].startsWith('-')) {
      return args[i];
    }
  }
  return null;
}

export function isProcessRunning(pid: number): boolean {
  if (!pid) return false;
  try {
    const output = execSync(`ps -p ${pid} -o pid= 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

export function isProcessRoot(pid: number): boolean {
  if (!pid) return false;
  try {
    const uidOutput = execSync(`ps -p ${pid} -o uid= 2>/dev/null || true`, { encoding: 'utf8' }).trim();
    return uidOutput === '0';
  } catch {
    return false;
  }
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const { timeout = 60_000 } = options;

  return {
    async get(url: string, config?: { responseType?: 'text' | 'json' }): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': `mihomo-cli/${VERSION}` },
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
        const data = config?.responseType === 'json' ? await response.json() : await response.text();
        return { data: data as string, headers: response.headers, status: response.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function normalizeMirrorUrl(val: string): string | null {
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

  const mirrorAllIdx = args.indexOf('--mirror-all');
  if (mirrorAllIdx >= 0) {
    const nextArg = args[mirrorAllIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      return { mirror: 'https://v6.gh-proxy.org/', isOverride: true, type: 'all' };
    }
    return { mirror: normalizeMirrorUrl(nextArg), isOverride: true, type: 'all' };
  }

  const mirrorIdx = args.indexOf('--mirror');
  if (mirrorIdx >= 0) {
    const nextArg = args[mirrorIdx + 1];
    if (!nextArg || nextArg.startsWith('-')) {
      return { mirror: 'https://v6.gh-proxy.org/', isOverride: true, type: 'download' };
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
    if (!/^[A-Za-z0-9+/]+=*$/.test(pw) || pw.length < 20) return false;
  }
  return true;
}
