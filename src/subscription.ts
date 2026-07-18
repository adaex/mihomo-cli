import yaml from 'js-yaml';
import { buildConfig, parseYamlOrJson, writeDebugConfig, writeMihomoConfig } from './config.js';
import { BASE_CONFIG } from './constants.js';
import {
  getSubscriptions,
  getSubscriptionsWithCache,
  maskUrl,
  readSettings,
  readSubscriptionRawConfig,
  saveSubscriptionCache,
  saveSubscriptionRawConfig,
} from './settings.js';

import type {
  AutoUpdateResult,
  DownloadResult,
  ParsedSubscription,
  ProxyTestResult,
  ProxyTestSummary,
  Subscription,
  SubscriptionWithCache,
  TryUpdateResult,
  UserInfo,
} from './types.js';
import { colors, createHttpClient, TimeoutError, withTimeout } from './utils.js';

export const DEFAULT_UPDATE_INTERVAL_HOURS = 12;
export const DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB = 6;
export const DEFAULT_CLEAN_ROUNDS = 2;
export const AUTO_CLEAN_THRESHOLD = 100;
export const AUTO_CLEAN_THRESHOLD_GITHUB = 50;

export function isGithubUrl(url: string): boolean {
  return /github\.com|raw\.githubusercontent\.com/i.test(url);
}

export function getDefaultUpdateInterval(url: string): number {
  return isGithubUrl(url) ? DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB : DEFAULT_UPDATE_INTERVAL_HOURS;
}

/** 取有效更新间隔（小时）：缓存值需为正整数，否则回退默认值。 */
export function resolveUpdateInterval(url: string, cachedInterval?: number | null): number {
  return cachedInterval && cachedInterval > 0 ? cachedInterval : getDefaultUpdateInterval(url);
}

const YAML_DUMP_OPTS = { indent: 2, lineWidth: -1, noCompatMode: true };

const HTTP_CLIENT = createHttpClient({ timeout: 60_000 });

export function isMultiUrl(url: string): boolean {
  return url.includes(',');
}

export function splitUrls(url: string): string[] {
  return url
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
}

export function loadSubscriptionConfig(subName: string): ParsedSubscription {
  const rawContent = readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new Error(`未找到订阅配置 "${subName}"`);
  }
  const raw = parseYamlOrJson(rawContent, '订阅内容') as Record<string, unknown>;
  return {
    raw,
    proxies: (raw.proxies || []) as ParsedSubscription['proxies'],
    proxyGroups: (raw['proxy-groups'] || []) as ParsedSubscription['proxyGroups'],
  };
}

function saveSubscriptionConfig(subName: string, parsed: ParsedSubscription): void {
  normalizeProxyNamesBeforeSave(parsed);
  parsed.raw.proxies = parsed.proxies;
  parsed.raw['proxy-groups'] = parsed.proxyGroups;
  saveSubscriptionRawConfig(subName, yaml.dump(parsed.raw, YAML_DUMP_OPTS));
}

function parseUserInfo(header: string | null): UserInfo | null {
  if (!header) return null;
  const info: Record<string, number> = {};
  const parts = header.split(';').map(p => p.trim());
  for (const part of parts) {
    const [key, val] = part.split('=').map(s => s.trim());
    if (key && val !== undefined) {
      const numVal = parseFloat(val);
      info[key] = Number.isNaN(numVal) ? 0 : numVal;
    }
  }
  return info as UserInfo;
}

/**
 * 解析 profile-update-interval 头。仅接受正整数小时数；
 * 机场返回 -1/0/非数字时返回 null（由调用方回退到默认间隔），
 * 避免负值写入缓存后导致 needsAutoUpdate 永远为 true。
 */
function parsePositiveInterval(header: string | null | undefined): number | null {
  if (!header) return null;
  const n = parseInt(header, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseUsernameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/filename\s*=\s*["']?([^"';\s]+)["']?/i);
  if (!match) return null;
  const filename = match[1];
  const parts = filename.split('/');
  return parts[parts.length - 1] || null;
}

export function formatProxySummary(info: { proxies?: number; proxyGroups?: number }): string {
  const parts: string[] = [];
  if (info.proxyGroups && info.proxyGroups > 0) parts.push(`${info.proxyGroups} 组`);
  parts.push(`${info.proxies || 0} 节点`);
  return parts.join(', ');
}

export function getActiveSubscription(): Subscription | null {
  const subs = getSubscriptions();
  if (subs.length === 0) return null;
  const settings = readSettings();
  const activeName = settings.active_subscription;
  if (activeName) {
    const found = subs.find(s => s.name === activeName);
    if (found) return found;
  }
  return subs[0];
}

export function findSubscriptionFuzzy(subs: Subscription[], pattern: string): Subscription[] {
  const lowerPattern = pattern.toLowerCase();
  const exact: Subscription[] = [];
  const prefix: Subscription[] = [];
  const includes: Subscription[] = [];

  for (const s of subs) {
    const name = s.name.toLowerCase();
    if (name === lowerPattern) {
      exact.push(s);
    } else if (name.startsWith(lowerPattern)) {
      prefix.push(s);
    } else if (name.includes(lowerPattern)) {
      includes.push(s);
    }
  }

  if (exact.length > 0) return exact;
  if (prefix.length > 0) return prefix;
  return includes;
}

export function pickSingleSubscription(subs: Subscription[], pattern: string): Subscription {
  if (subs.length === 0) {
    console.error(`错误: 未找到匹配 "${pattern}" 的订阅`);
    process.exit(1);
  }
  if (subs.length === 1) return subs[0];
  console.error('错误: 匹配到多个订阅，请更精确指定');
  console.log('\n匹配的订阅:');
  for (const s of subs) console.log(`  ${s.name}`);
  process.exit(1);
}

export async function downloadSubscription(url: string, subName = 'default', signal?: AbortSignal): Promise<DownloadResult> {
  let response: Awaited<ReturnType<typeof HTTP_CLIENT.get>>;
  try {
    response = await HTTP_CLIENT.get(url, { responseType: 'text', signal });
  } catch (e) {
    const maskedUrl = maskUrl(url);
    let errorMsg = `获取订阅失败: ${(e as Error).message}`;
    const err = e as Error & { response?: { status: number } };
    if (err.response) {
      errorMsg += ` (HTTP ${err.response.status})`;
    }
    errorMsg += `\n  URL: ${maskedUrl}`;
    throw new Error(errorMsg);
  }

  const content = response.data;
  if (!content?.trim()) {
    throw new Error('订阅内容为空');
  }

  const parsed = parseYamlOrJson(content, '订阅内容') as Record<string, unknown>;
  if (!parsed) throw new Error('订阅内容为空');

  saveSubscriptionRawConfig(subName, content);

  const headers = response.headers;
  const userInfo = parseUserInfo(headers.get('subscription-userinfo'));
  const updateInterval = parsePositiveInterval(headers.get('profile-update-interval'));
  const webPageUrl = headers.get('profile-web-page-url') || null;
  const username = parseUsernameFromContentDisposition(headers.get('content-disposition'));

  const cacheData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (userInfo) {
    cacheData.upload = userInfo.upload;
    cacheData.download = userInfo.download;
    cacheData.total = userInfo.total;
    cacheData.expire = userInfo.expire;
  }
  if (updateInterval) cacheData.update_interval = updateInterval;
  if (webPageUrl) cacheData.web_page_url = webPageUrl;
  if (username) cacheData.username = username;
  saveSubscriptionCache(subName, cacheData);

  const proxies = parsed.proxies as unknown[] | undefined;
  const proxyGroups = parsed['proxy-groups'] as unknown[] | undefined;

  return {
    proxies: proxies ? proxies.length : 0,
    proxyGroups: proxyGroups ? proxyGroups.length : 0,
    userInfo,
    updateInterval,
    webPageUrl,
    username,
  };
}

export async function downloadMergedSubscription(urls: string[], subName: string, signal?: AbortSignal): Promise<DownloadResult> {
  const responses = await Promise.all(
    urls.map(async (url, index) => {
      try {
        const response = await HTTP_CLIENT.get(url, { responseType: 'text', signal });
        return { url, index, response, error: null };
      } catch (e) {
        return { url, index, response: null, error: e as Error };
      }
    }),
  );

  for (const r of responses) {
    if (r.error) {
      const maskedUrl = maskUrl(r.url);
      throw new Error(`合并订阅第 ${r.index + 1} 个 URL 获取失败: ${r.error.message}\n  URL: ${maskedUrl}`);
    }
  }

  const parsed = responses.map((r, i) => {
    const content = r.response?.data;
    if (!content?.trim()) throw new Error(`合并订阅第 ${i + 1} 个 URL 内容为空`);
    return parseYamlOrJson(content, `合并订阅第 ${i + 1} 个`) as Record<string, unknown>;
  });

  const base = parsed[0];
  const baseProxies = (base.proxies || []) as Array<{ name: string; [k: string]: unknown }>;
  const seenNames = new Set(baseProxies.map(p => p.name));

  for (let i = 1; i < parsed.length; i++) {
    const extraProxies = (parsed[i].proxies || []) as Array<{ name: string; [k: string]: unknown }>;
    for (const proxy of extraProxies) {
      if (!seenNames.has(proxy.name)) {
        baseProxies.push(proxy);
        seenNames.add(proxy.name);
      }
    }
  }
  base.proxies = baseProxies;

  const mergedContent = yaml.dump(base, YAML_DUMP_OPTS);
  saveSubscriptionRawConfig(subName, mergedContent);

  const firstHeaders = responses[0].response?.headers;
  const userInfo = parseUserInfo(firstHeaders?.get('subscription-userinfo') ?? null);
  const updateInterval = parsePositiveInterval(firstHeaders?.get('profile-update-interval'));
  const webPageUrl = firstHeaders?.get('profile-web-page-url') || null;
  const username = parseUsernameFromContentDisposition(firstHeaders?.get('content-disposition') ?? null);

  const cacheData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (userInfo) {
    cacheData.upload = userInfo.upload;
    cacheData.download = userInfo.download;
    cacheData.total = userInfo.total;
    cacheData.expire = userInfo.expire;
  }
  if (updateInterval) cacheData.update_interval = updateInterval;
  if (webPageUrl) cacheData.web_page_url = webPageUrl;
  if (username) cacheData.username = username;
  saveSubscriptionCache(subName, cacheData);

  const proxyGroups = base['proxy-groups'] as unknown[] | undefined;
  return {
    proxies: baseProxies.length,
    proxyGroups: proxyGroups ? proxyGroups.length : 0,
    userInfo,
    updateInterval,
    webPageUrl,
    username,
  };
}

export function prepareConfigForStart(mode: string, subName = 'default'): { proxies: number; proxyGroups: number } {
  const rawContent = readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new Error(`未找到订阅配置 "${subName}"，请先添加订阅`);
  }

  const buildResult = buildConfig(rawContent, mode);

  if (buildResult.warnings.length > 0) {
    for (const warning of buildResult.warnings) {
      console.log(`${colors.yellow('自动修复:')} ${warning}`);
    }
    console.log('');
  }

  writeMihomoConfig(buildResult.config);
  writeDebugConfig(buildResult);

  const proxies = buildResult.config.proxies as unknown[] | undefined;
  const proxyGroups = buildResult.config['proxy-groups'] as unknown[] | undefined;

  return {
    proxies: proxies ? proxies.length : 0,
    proxyGroups: proxyGroups ? proxyGroups.length : 0,
  };
}

function needsAutoUpdate(sub: SubscriptionWithCache): boolean {
  if (!sub.updated_at) return true;
  const lastUpdate = new Date(sub.updated_at).getTime();
  if (Number.isNaN(lastUpdate)) return true;
  // 防御历史坏缓存：update_interval 为 0/负数/非数时回退默认值
  const intervalHours = resolveUpdateInterval(sub.url, sub.update_interval);
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return Date.now() - lastUpdate > intervalMs;
}

export async function tryUpdateOne(sub: Subscription, signal?: AbortSignal): Promise<TryUpdateResult> {
  try {
    let info: DownloadResult;
    if (isMultiUrl(sub.url)) {
      info = await downloadMergedSubscription(splitUrls(sub.url), sub.name, signal);
    } else {
      info = await downloadSubscription(sub.url, sub.name, signal);
    }
    return { name: sub.name, success: true, proxies: info.proxies, proxyGroups: info.proxyGroups };
  } catch (e) {
    return { name: sub.name, success: false, error: (e as Error).message };
  }
}

export const DEFAULT_AUTO_UPDATE_TIMEOUT = 10_000;

export async function autoUpdateStaleSubscription(options: { timeout?: number } = {}): Promise<AutoUpdateResult> {
  const allSubs = getSubscriptionsWithCache();
  const staleSubs = allSubs.filter(needsAutoUpdate);

  if (staleSubs.length === 0) {
    return { total: 0, updated: 0, failed: 0 };
  }

  if (staleSubs.length === 1) {
    const sub = staleSubs[0];
    const interval = resolveUpdateInterval(sub.url, sub.update_interval);
    console.log(`订阅 "${sub.name}" 超过 ${interval} 小时未更新，正在更新...`);
  } else {
    console.log(`检查到 ${staleSubs.length} 个订阅需要更新，正在并行更新...`);
  }

  const timeoutMs = options.timeout ?? DEFAULT_AUTO_UPDATE_TIMEOUT;
  const controller = new AbortController();
  let results: TryUpdateResult[];
  try {
    results = await withTimeout(Promise.all(staleSubs.map(sub => tryUpdateOne(sub, controller.signal))), timeoutMs);
  } catch (e) {
    if (e instanceof TimeoutError) {
      controller.abort(); // 中断仍在跑的 fetch，阻止其超时后成功回来又写盘（与"已用缓存启动"竞态）
      console.log(colors.yellow(`自动更新超时 (${timeoutMs / 1000}s)，跳过更新，使用缓存配置`));
      return { total: staleSubs.length, updated: 0, failed: staleSubs.length };
    }
    throw e;
  }

  let updatedCount = 0;

  for (const r of results) {
    if (r.success) {
      updatedCount++;
      console.log(`${colors.green('✓')} ${r.name}: ${colors.green('已更新')} (${formatProxySummary(r)})`);
    } else {
      console.log(`${colors.red('✗')} ${r.name}: ${colors.red('失败')} (${(r.error || '').split('\n')[0]})`);
    }
  }

  return { total: staleSubs.length, updated: updatedCount, failed: staleSubs.length - updatedCount };
}

const API_BASE = `http://${BASE_CONFIG['external-controller']}`;
const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';

export async function testProxyDelay(
  proxyName: string,
  timeout: number,
  testUrl: string,
  client: ReturnType<typeof createHttpClient>,
  apiBase = API_BASE,
): Promise<ProxyTestResult> {
  const encodedName = encodeURIComponent(proxyName);
  const url = `${apiBase}/proxies/${encodedName}/delay?timeout=${timeout}&url=${encodeURIComponent(testUrl)}`;

  try {
    const response = await client.get(url);
    const data = JSON.parse(response.data) as { delay?: number; message?: string };
    if (data.delay && data.delay > 0) {
      return { name: proxyName, delay: data.delay };
    }
    return { name: proxyName, delay: null, error: data.message || 'no delay' };
  } catch (e) {
    const err = e as Error & { response?: { status: number; data?: Record<string, unknown> } };
    let errorMsg = 'timeout';
    if (err.response?.data?.message) {
      errorMsg = String(err.response.data.message);
    } else if (err.message) {
      errorMsg = err.message;
    }
    return { name: proxyName, delay: null, error: errorMsg };
  }
}

export async function testSubscriptionProxies(
  subName: string,
  options: {
    timeout?: number;
    concurrency?: number;
    testUrl?: string;
    apiBase?: string;
    onResult?: (result: ProxyTestResult, index: number, total: number) => void;
    parsed?: ParsedSubscription;
  } = {},
): Promise<ProxyTestSummary> {
  const { timeout = 2000, concurrency = 100, testUrl = DEFAULT_TEST_URL, apiBase = API_BASE, onResult } = options;

  const { proxies } = options.parsed || loadSubscriptionConfig(subName);

  if (proxies.length === 0) {
    return { total: 0, alive: 0, dead: 0, results: [] };
  }

  const client = createHttpClient({ timeout: timeout + 3000 });
  const results: ProxyTestResult[] = new Array(proxies.length);
  let completedCount = 0;
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < proxies.length) {
      const idx = nextIndex++;
      const result = await testProxyDelay(proxies[idx].name, timeout, testUrl, client, apiBase);
      results[idx] = result;
      onResult?.(result, completedCount, proxies.length);
      completedCount++;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, proxies.length) }, () => runNext());
  await Promise.all(workers);

  const alive = results.filter(r => r.delay !== null).length;
  return { total: results.length, alive, dead: results.length - alive, results };
}

function normalizeProxyNamesBeforeSave(parsed: ParsedSubscription): number {
  const { proxies, proxyGroups } = parsed;

  const renameMap = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const proxy of proxies) {
    const shortened = proxy.name.replace(/_github\.com\/[^_]+/, '');
    if (shortened !== proxy.name && !usedNames.has(shortened)) {
      renameMap.set(proxy.name, shortened);
      usedNames.add(shortened);
    } else {
      usedNames.add(proxy.name);
    }
  }

  if (renameMap.size === 0) return 0;

  for (const proxy of proxies) {
    const newName = renameMap.get(proxy.name);
    if (newName) proxy.name = newName;
  }

  for (const group of proxyGroups) {
    if (Array.isArray(group.proxies)) {
      group.proxies = group.proxies.map(name => renameMap.get(name) || name);
    }
  }

  return renameMap.size;
}

export function cleanDeadProxies(parsed: ParsedSubscription, deadNames: Set<string>): { removedProxies: number; updatedGroups: number; removedGroups: number } {
  const { proxies, proxyGroups } = parsed;

  const originalCount = proxies.length;
  parsed.proxies = proxies.filter(p => !deadNames.has(p.name));
  const removedProxies = originalCount - parsed.proxies.length;

  let updatedGroups = 0;
  const removedGroupNames = new Set<string>();

  for (const group of proxyGroups) {
    if (Array.isArray(group.proxies)) {
      const before = group.proxies.length;
      group.proxies = group.proxies.filter(name => !deadNames.has(name));
      if (group.proxies.length < before) {
        updatedGroups++;
      }
      if (group.proxies.length === 0) {
        removedGroupNames.add(group.name);
      }
    }
  }

  if (removedGroupNames.size > 0) {
    parsed.proxyGroups = proxyGroups.filter(g => !removedGroupNames.has(g.name));
    for (const group of parsed.proxyGroups) {
      if (Array.isArray(group.proxies)) {
        group.proxies = group.proxies.filter(name => !removedGroupNames.has(name));
      }
    }
    // 移除引用了已删空分组的规则，避免残留在保存的订阅文件里（target 取末段，与 config.ts validateConfig 一致）
    const rules = parsed.raw.rules;
    if (Array.isArray(rules)) {
      parsed.raw.rules = rules.filter(rule => {
        if (typeof rule !== 'string') return true;
        const parts = rule.split(',');
        if (parts.length < 2) return true;
        return !removedGroupNames.has(parts[parts.length - 1].trim());
      });
    }
  }

  return { removedProxies, updatedGroups, removedGroups: removedGroupNames.size };
}

export async function autoCleanSubscription(
  subName: string,
  options: {
    timeout?: number;
    concurrency?: number;
    apiBase?: string;
    rounds?: number;
    onResult?: (result: ProxyTestResult, index: number, total: number, round: number) => void;
    onRetryRound?: (round: number, count: number) => void;
  } = {},
): Promise<{ summary: ProxyTestSummary; removedProxies: number; updatedGroups: number; removedGroups: number; skipped?: boolean }> {
  const parsed = loadSubscriptionConfig(subName);
  const { onResult, onRetryRound, rounds = DEFAULT_CLEAN_ROUNDS, ...testOptions } = options;

  const wrapOnResult = (round: number) => (onResult ? (r: ProxyTestResult, i: number, t: number) => onResult(r, i, t, round) : undefined);

  const summary = await testSubscriptionProxies(subName, {
    ...testOptions,
    parsed,
    onResult: wrapOnResult(1),
  });

  let removedProxies = 0;
  let updatedGroups = 0;
  let removedGroups = 0;
  let skipped = false;

  if (summary.dead > 0) {
    if (summary.alive === 0 || summary.alive / summary.total < 0.01) {
      skipped = true;
    } else {
      const deadNames = new Set(summary.results.filter(r => r.delay === null).map(r => r.name));
      const deadProxies = parsed.proxies.filter(p => deadNames.has(p.name));

      for (let retry = 0; retry < rounds - 1; retry++) {
        const round = retry + 2;
        const retryTargets = deadProxies.filter(p => deadNames.has(p.name));
        if (retryTargets.length === 0) break;

        onRetryRound?.(round, retryTargets.length);

        const retryParsed: ParsedSubscription = { raw: {}, proxies: retryTargets, proxyGroups: [] };
        const retrySummary = await testSubscriptionProxies(subName, {
          ...testOptions,
          parsed: retryParsed,
          onResult: wrapOnResult(round),
        });

        for (const r of retrySummary.results) {
          if (r.delay !== null) {
            deadNames.delete(r.name);
          }
        }
      }

      summary.dead = deadNames.size;
      summary.alive = summary.total - summary.dead;

      if (deadNames.size > 0) {
        const cleanResult = cleanDeadProxies(parsed, deadNames);
        removedProxies = cleanResult.removedProxies;
        updatedGroups = cleanResult.updatedGroups;
        removedGroups = cleanResult.removedGroups;
      }
    }
  }

  if (!skipped && removedProxies > 0) {
    saveSubscriptionConfig(subName, parsed);
  }

  return { summary, removedProxies, updatedGroups, removedGroups, skipped };
}
