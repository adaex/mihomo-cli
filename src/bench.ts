import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { parseYamlOrJson } from './config.js';
import { BENCH_CONFIG } from './constants.js';
import { PATHS, USER_DATA_DIR } from './paths.js';
import type { BenchSourceResult, ProxyTestResult } from './types.js';
import { createHttpClient, isProcessRunning, sleep, sleepSync } from './utils.js';

const BENCH_DIR = path.join(USER_DATA_DIR, 'bench');
const BENCH_DIRS = {
  data: path.join(BENCH_DIR, 'data'),
  runtime: path.join(BENCH_DIR, 'runtime'),
};
const BENCH_PATHS = {
  configFile: path.join(BENCH_DIRS.runtime, 'config.yaml'),
  pidFile: path.join(BENCH_DIRS.runtime, 'pid'),
  logFile: path.join(BENCH_DIR, 'bench.log'),
};

const BENCH_API = `http://${BENCH_CONFIG['external-controller']}`;
const BENCH_TEST_URL = 'http://www.gstatic.com/generate_204';

function ensureBenchDirs(): void {
  for (const dir of Object.values(BENCH_DIRS)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

export function cleanupBenchDir(): void {
  if (fs.existsSync(BENCH_DIR)) {
    fs.rmSync(BENCH_DIR, { recursive: true, force: true });
  }
}

interface DownloadedSource {
  name: string;
  url: string;
  proxies: Array<{ name: string; [k: string]: unknown }>;
  proxyGroups: number;
  error?: string;
}

function tryDecodeBase64Content(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('proxies') || trimmed.includes('proxy-groups')) return null;
  try {
    const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
    if (decoded.includes('://')) return decoded;
  } catch {
    /* not base64 */
  }
  return null;
}

function parseVmessUri(uri: string): Record<string, unknown> | null {
  try {
    const b64 = uri.slice('vmess://'.length);
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return {
      name: json.ps || json.add || 'vmess',
      type: 'vmess',
      server: json.add,
      port: Number(json.port),
      uuid: json.id,
      alterId: Number(json.aid) || 0,
      cipher: json.security || 'auto',
      tls: json.tls === 'tls',
      network: json.net || 'tcp',
      ...(json.net === 'ws' && { 'ws-opts': { path: json.path || '/', headers: json.host ? { Host: json.host } : undefined } }),
    };
  } catch {
    return null;
  }
}

function parseSsUri(uri: string): Record<string, unknown> | null {
  try {
    const hashIdx = uri.indexOf('#');
    const name = hashIdx >= 0 ? decodeURIComponent(uri.slice(hashIdx + 1)) : 'ss';
    const main = uri.slice('ss://'.length, hashIdx >= 0 ? hashIdx : undefined);

    let decoded: string;
    const atIdx = main.indexOf('@');
    if (atIdx >= 0) {
      const methodPassword = Buffer.from(main.slice(0, atIdx), 'base64').toString('utf8');
      decoded = `${methodPassword}@${main.slice(atIdx + 1)}`;
    } else {
      decoded = Buffer.from(main, 'base64').toString('utf8');
    }

    const [methodPassword, serverPort] = decoded.split('@');
    if (!methodPassword || !serverPort) return null;
    const colonIdx = methodPassword.indexOf(':');
    const method = methodPassword.slice(0, colonIdx);
    const password = methodPassword.slice(colonIdx + 1);
    const lastColon = serverPort.lastIndexOf(':');
    const server = serverPort.slice(0, lastColon);
    const port = Number(serverPort.slice(lastColon + 1));

    return { name, type: 'ss', server, port, cipher: method, password };
  } catch {
    return null;
  }
}

function parseTrojanUri(uri: string): Record<string, unknown> | null {
  try {
    const hashIdx = uri.indexOf('#');
    const name = hashIdx >= 0 ? decodeURIComponent(uri.slice(hashIdx + 1)) : 'trojan';
    const main = uri.slice('trojan://'.length, hashIdx >= 0 ? hashIdx : undefined);
    const atIdx = main.indexOf('@');
    if (atIdx < 0) return null;
    const password = main.slice(0, atIdx);
    const rest = main.slice(atIdx + 1).split('?')[0];
    const lastColon = rest.lastIndexOf(':');
    const server = rest.slice(0, lastColon);
    const port = Number(rest.slice(lastColon + 1));
    return { name, type: 'trojan', server, port, password, sni: server };
  } catch {
    return null;
  }
}

function parseProxyUris(content: string): Array<{ name: string; [k: string]: unknown }> {
  const lines = content
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  const proxies: Array<{ name: string; [k: string]: unknown }> = [];

  for (const line of lines) {
    let proxy: Record<string, unknown> | null = null;
    if (line.startsWith('vmess://')) proxy = parseVmessUri(line);
    else if (line.startsWith('ss://')) proxy = parseSsUri(line);
    else if (line.startsWith('trojan://')) proxy = parseTrojanUri(line);
    if (proxy?.name && proxy?.server) proxies.push(proxy as { name: string; [k: string]: unknown });
  }

  return proxies;
}

export async function downloadAllSources(
  sources: Array<{ name: string; url: string }>,
  onProgress?: (name: string, ok: boolean, count: number, groups: number, error?: string) => void,
): Promise<DownloadedSource[]> {
  const savedProxy = { http: process.env.http_proxy, https: process.env.https_proxy, HTTP: process.env.HTTP_PROXY, HTTPS: process.env.HTTPS_PROXY };
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;

  try {
    const client = createHttpClient({ timeout: 30_000 });

    const tasks = sources.map(async (source): Promise<DownloadedSource> => {
      const entry: DownloadedSource = { name: source.name, url: source.url, proxies: [], proxyGroups: 0 };
      try {
        const response = await client.get(source.url, { responseType: 'text' });
        const content = response.data;
        if (!content?.trim()) throw new Error('内容为空');

        let proxies: Array<{ name: string; [k: string]: unknown }>;

        try {
          const parsed = parseYamlOrJson(content, '订阅内容') as Record<string, unknown>;
          proxies = (parsed.proxies || []) as Array<{ name: string; [k: string]: unknown }>;
          const groups = parsed['proxy-groups'] as unknown[] | undefined;
          if (groups) entry.proxyGroups = groups.length;
        } catch {
          const decoded = tryDecodeBase64Content(content);
          if (decoded) {
            proxies = parseProxyUris(decoded);
          } else {
            proxies = parseProxyUris(content);
          }
          if (proxies.length === 0) throw new Error('无法解析订阅内容（非 YAML/JSON/Base64）');
        }

        entry.proxies = proxies.map(p => ({ ...p, name: `[${source.name}] ${p.name}` }));
        onProgress?.(source.name, true, proxies.length, entry.proxyGroups);
      } catch (e) {
        entry.error = (e as Error).message;
        onProgress?.(source.name, false, 0, 0, entry.error);
      }
      return entry;
    });

    return await Promise.all(tasks);
  } finally {
    for (const [key, val] of Object.entries(savedProxy)) {
      if (val !== undefined) process.env[key] = val;
    }
  }
}

function isProxyValid(proxy: { name: string; [k: string]: unknown }): boolean {
  if (!proxy.name || !proxy.server || !proxy.port) return false;
  if (!proxy.type) return false;
  // 2022-blake3 ciphers 需要严格的 key 格式，容易出错
  if (proxy.type === 'ss' && typeof proxy.cipher === 'string' && proxy.cipher.startsWith('2022-blake3')) {
    const pw = String(proxy.password || '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(pw) || pw.length < 20) return false;
  }
  return true;
}

export function buildMergedBenchConfig(allProxies: Array<{ name: string; [k: string]: unknown }>): number {
  ensureBenchDirs();

  const validProxies = allProxies.filter(isProxyValid);
  const removed = allProxies.length - validProxies.length;

  const nameCount = new Map<string, number>();
  for (const proxy of validProxies) {
    const originalName = proxy.name;
    const count = (nameCount.get(originalName) || 0) + 1;
    nameCount.set(originalName, count);
    if (count > 1) {
      proxy.name = `${originalName} #${count}`;
    }
  }

  const config: Record<string, unknown> = {
    ...BENCH_CONFIG,
    proxies: validProxies,
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        proxies: validProxies.map(p => p.name),
      },
    ],
    rules: ['MATCH,PROXY'],
  };

  const content = yaml.dump(config, { indent: 2, lineWidth: -1, noCompatMode: true });
  fs.writeFileSync(BENCH_PATHS.configFile, content, { mode: 0o600 });

  // 更新 allProxies 以反映过滤结果（调用方依赖此副作用）
  allProxies.length = 0;
  allProxies.push(...validProxies);

  return removed;
}

export async function startBenchInstance(): Promise<number> {
  const binary = PATHS.mihomoBinary;
  if (!fs.existsSync(binary)) throw new Error('未找到 mihomo 内核');

  const logFd = fs.openSync(BENCH_PATHS.logFile, 'a');
  const child = spawn(binary, ['-d', BENCH_DIRS.data, '-f', BENCH_PATHS.configFile], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();

  const pid = child.pid as number;
  fs.writeFileSync(BENCH_PATHS.pidFile, pid.toString(), { mode: 0o600 });

  const client = createHttpClient({ timeout: 2000 });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (!isProcessRunning(pid)) break;
    try {
      await client.get(`${BENCH_API}/version`);
      ready = true;
      break;
    } catch {
      /* not ready */
    }
  }

  if (!isProcessRunning(pid)) {
    let errorDetail = '';
    if (fs.existsSync(BENCH_PATHS.logFile)) {
      try {
        errorDetail = fs.readFileSync(BENCH_PATHS.logFile, 'utf8').slice(-1000);
      } catch {
        /* ignore */
      }
    }
    throw new Error(`bench 实例启动失败${errorDetail ? `\n${errorDetail}` : ''}`);
  }

  if (!ready) {
    throw new Error('bench 实例启动超时，API 未响应');
  }

  return pid;
}

export function stopBenchInstance(): void {
  if (!fs.existsSync(BENCH_PATHS.pidFile)) return;
  try {
    const pid = parseInt(fs.readFileSync(BENCH_PATHS.pidFile, 'utf8').trim(), 10);
    if (pid > 0 && isProcessRunning(pid)) {
      process.kill(pid, 'SIGKILL');
      for (let i = 0; i < 20; i++) {
        if (!isProcessRunning(pid)) break;
        sleepSync(100);
      }
    }
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(BENCH_PATHS.pidFile);
  } catch {
    /* ignore */
  }
}

async function testBenchProxy(proxyName: string, timeout: number, client: ReturnType<typeof createHttpClient>): Promise<ProxyTestResult> {
  const encodedName = encodeURIComponent(proxyName);
  const url = `${BENCH_API}/proxies/${encodedName}/delay?timeout=${timeout}&url=${encodeURIComponent(BENCH_TEST_URL)}`;

  try {
    const response = await client.get(url);
    const data = JSON.parse(response.data) as { delay?: number; message?: string };
    if (data.delay && data.delay > 0) {
      return { name: proxyName, delay: data.delay };
    }
    return { name: proxyName, delay: null, error: data.message || 'no delay' };
  } catch (e) {
    const err = e as Error & { response?: { data?: Record<string, unknown> } };
    let errorMsg = 'timeout';
    if (err.response?.data?.message) {
      errorMsg = String(err.response.data.message);
    } else if (err.message) {
      errorMsg = err.message;
    }
    return { name: proxyName, delay: null, error: errorMsg };
  }
}

export async function testBenchProxies(
  proxyNames: string[],
  options: {
    timeout?: number;
    concurrency?: number;
    onResult?: (result: ProxyTestResult, index: number, total: number) => void;
    onBatch?: (batchIndex: number, totalBatches: number, alive: number, tested: number, medianDelay: number) => void;
  } = {},
): Promise<ProxyTestResult[]> {
  const { timeout = 3000, concurrency = 100, onResult, onBatch } = options;
  const client = createHttpClient({ timeout: timeout + 3000 });
  const results: ProxyTestResult[] = [];
  let completedCount = 0;
  let aliveCount = 0;
  const delays: number[] = [];
  const totalBatches = Math.ceil(proxyNames.length / concurrency);

  for (let i = 0; i < proxyNames.length; i += concurrency) {
    const batch = proxyNames.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(name => testBenchProxy(name, timeout, client)));
    for (const result of batchResults) {
      results.push(result);
      if (result.delay !== null) {
        aliveCount++;
        delays.push(result.delay);
      }
      onResult?.(result, completedCount, proxyNames.length);
      completedCount++;
    }
    delays.sort((a, b) => a - b);
    const median = delays.length > 0 ? delays[Math.floor(delays.length / 2)] : 0;
    onBatch?.(Math.floor(i / concurrency) + 1, totalBatches, aliveCount, completedCount, median);
  }

  return results;
}

export function computeSourceResult(source: DownloadedSource, resultsByName: Map<string, ProxyTestResult>): BenchSourceResult {
  const proxyNames = source.proxies.map(p => p.name);
  const sourceResults = proxyNames.map(n => resultsByName.get(n)).filter((r): r is ProxyTestResult => r !== undefined);
  const delays = sourceResults.filter(r => r.delay !== null).map(r => r.delay as number);
  const alive = delays.length;
  const dead = sourceResults.length - alive;

  if (alive === 0) {
    return {
      name: source.name,
      url: source.url,
      downloadOk: !source.error,
      downloadError: source.error,
      totalProxies: source.proxies.length,
      proxyGroups: source.proxyGroups,
      alive: 0,
      dead,
      avgDelay: 0,
      minDelay: 0,
      medianDelay: 0,
    };
  }

  delays.sort((a, b) => a - b);
  return {
    name: source.name,
    url: source.url,
    downloadOk: true,
    totalProxies: source.proxies.length,
    proxyGroups: source.proxyGroups,
    alive,
    dead,
    avgDelay: Math.round(delays.reduce((sum, d) => sum + d, 0) / alive),
    minDelay: delays[0],
    medianDelay: delays[Math.floor(delays.length / 2)],
  };
}
