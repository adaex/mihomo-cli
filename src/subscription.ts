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
import { colors, createHttpClient } from './utils.js';

export const DEFAULT_UPDATE_INTERVAL_HOURS = 12;

const YAML_DUMP_OPTS = { indent: 2, lineWidth: -1, noCompatMode: true };

const HTTP_CLIENT = createHttpClient({ timeout: 60_000 });

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
  shortenProxyNames(parsed);
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

export async function downloadSubscription(url: string, subName = 'default'): Promise<DownloadResult> {
  let response: Awaited<ReturnType<typeof HTTP_CLIENT.get>>;
  try {
    response = await HTTP_CLIENT.get(url, { responseType: 'text' });
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
  const updateIntervalHeader = headers.get('profile-update-interval');
  const updateInterval = updateIntervalHeader ? parseInt(updateIntervalHeader, 10) : null;
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

export function prepareConfigForStart(mode: string, subName = 'default'): { proxies: number; proxyGroups: number } {
  const rawContent = readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new Error(`未找到订阅配置 "${subName}"，请先添加订阅`);
  }

  const buildResult = buildConfig(rawContent, mode);
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
  const intervalHours = sub.update_interval || DEFAULT_UPDATE_INTERVAL_HOURS;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return Date.now() - lastUpdate > intervalMs;
}

export async function tryUpdateOne(sub: Subscription): Promise<TryUpdateResult> {
  try {
    const info = await downloadSubscription(sub.url, sub.name);
    return { name: sub.name, success: true, proxies: info.proxies, proxyGroups: info.proxyGroups };
  } catch (e) {
    return { name: sub.name, success: false, error: (e as Error).message };
  }
}

export async function autoUpdateStaleSubscription(): Promise<AutoUpdateResult> {
  const allSubs = getSubscriptionsWithCache();
  const staleSubs = allSubs.filter(needsAutoUpdate);

  if (staleSubs.length === 0) {
    return { total: 0, updated: 0, failed: 0 };
  }

  if (staleSubs.length === 1) {
    const sub = staleSubs[0];
    const interval = sub.update_interval || DEFAULT_UPDATE_INTERVAL_HOURS;
    console.log(`订阅 "${sub.name}" 超过 ${interval} 小时未更新，正在更新...`);
  } else {
    console.log(`检查到 ${staleSubs.length} 个订阅需要更新，正在并行更新...`);
  }

  const results = await Promise.all(staleSubs.map(tryUpdateOne));
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
): Promise<ProxyTestResult> {
  const encodedName = encodeURIComponent(proxyName);
  const url = `${API_BASE}/proxies/${encodedName}/delay?timeout=${timeout}&url=${encodeURIComponent(testUrl)}`;

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
    onResult?: (result: ProxyTestResult, index: number, total: number) => void;
    parsed?: ParsedSubscription;
  } = {},
): Promise<ProxyTestSummary> {
  const { timeout = 2000, concurrency = 100, testUrl = DEFAULT_TEST_URL, onResult } = options;

  const { proxies } = options.parsed || loadSubscriptionConfig(subName);

  if (proxies.length === 0) {
    return { total: 0, alive: 0, dead: 0, results: [] };
  }

  const client = createHttpClient({ timeout: timeout + 3000 });
  const results: ProxyTestResult[] = [];
  let completedCount = 0;

  for (let i = 0; i < proxies.length; i += concurrency) {
    const batch = proxies.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(proxy => testProxyDelay(proxy.name, timeout, testUrl, client)));
    for (const result of batchResults) {
      results.push(result);
      onResult?.(result, completedCount, proxies.length);
      completedCount++;
    }
  }

  const alive = results.filter(r => r.delay !== null).length;
  return { total: results.length, alive, dead: results.length - alive, results };
}

function shortenProxyNames(parsed: ParsedSubscription): number {
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
  }

  return { removedProxies, updatedGroups, removedGroups: removedGroupNames.size };
}

export async function autoCleanSubscription(
  subName: string,
  options: {
    timeout?: number;
    concurrency?: number;
    onResult?: (result: ProxyTestResult, index: number, total: number) => void;
  } = {},
): Promise<{ summary: ProxyTestSummary; removedProxies: number; updatedGroups: number; removedGroups: number; skipped?: boolean }> {
  const parsed = loadSubscriptionConfig(subName);

  const summary = await testSubscriptionProxies(subName, { ...options, parsed });

  let removedProxies = 0;
  let updatedGroups = 0;
  let removedGroups = 0;
  let skipped = false;

  if (summary.dead > 0) {
    if (summary.alive === 0 || summary.alive / summary.total < 0.01) {
      skipped = true;
    } else {
      const deadNames = new Set(summary.results.filter(r => r.delay === null).map(r => r.name));
      const cleanResult = cleanDeadProxies(parsed, deadNames);
      removedProxies = cleanResult.removedProxies;
      updatedGroups = cleanResult.updatedGroups;
      removedGroups = cleanResult.removedGroups;
    }
  }

  if (!skipped) {
    saveSubscriptionConfig(subName, parsed);
  }

  return { summary, removedProxies, updatedGroups, removedGroups, skipped };
}
