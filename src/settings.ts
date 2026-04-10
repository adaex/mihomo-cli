import fs from 'node:fs';
import { DEFAULT_GITHUB_MIRROR } from './constants.js';
import { DIRS, ensureDirs, PATHS } from './paths.js';
import type { Settings, Subscription, SubscriptionCache, SubscriptionCacheEntry, SubscriptionWithCache } from './types.js';

let settingsCache: Settings | null = null;

export function readSettings(): Settings {
  if (settingsCache !== null) return settingsCache;
  ensureDirs();
  if (fs.existsSync(PATHS.settingsFile)) {
    try {
      const content = fs.readFileSync(PATHS.settingsFile, 'utf8');
      settingsCache = JSON.parse(content) as Settings;
      return settingsCache;
    } catch {
      console.warn('警告: settings.json 格式损坏，使用默认设置（原文件已保留）');
      settingsCache = {};
      return settingsCache;
    }
  }
  settingsCache = {};
  return settingsCache;
}

export function writeSettings(settings: Partial<Settings>): Settings {
  ensureDirs();
  const existing = readSettings();
  const merged = { ...existing, ...settings } as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if ((settings as Record<string, unknown>)[key] === undefined) delete merged[key];
  }
  fs.writeFileSync(PATHS.settingsFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
  settingsCache = merged as Settings;
  return settingsCache;
}

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

export function maskUrl(url: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const tokenKeys = ['token', 'key', 'secret', 'pass', 'password', 'auth', 'access_token', 'api_key'];
    for (const key of tokenKeys) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '***');
      }
    }
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    if (url.length > 30) {
      return `${url.slice(0, 15)}...${url.slice(-10)}`;
    }
    return url;
  }
}

// === Subscription cache ===

export function readSubscriptionCache(): SubscriptionCache {
  ensureDirs();
  if (fs.existsSync(PATHS.subscriptionsCacheFile)) {
    try {
      const content = fs.readFileSync(PATHS.subscriptionsCacheFile, 'utf8');
      return JSON.parse(content) as SubscriptionCache;
    } catch {
      return {};
    }
  }
  return {};
}

function writeSubscriptionCache(cache: SubscriptionCache): void {
  ensureDirs();
  fs.writeFileSync(PATHS.subscriptionsCacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export function saveSubscriptionCache(subName: string, data: Partial<SubscriptionCacheEntry>): void {
  const cache = readSubscriptionCache();
  cache[subName] = { ...cache[subName], ...data };
  writeSubscriptionCache(cache);
}

// === Subscription list ===

export function getSubscriptions(): Subscription[] {
  const settings = readSettings();
  return settings.subscriptions || [];
}

export function getSubscriptionsWithCache(): SubscriptionWithCache[] {
  const subs = getSubscriptions();
  const cache = readSubscriptionCache();
  return subs.map(s => ({
    ...s,
    ...(cache[s.name] || {}),
  }));
}

export function addSubscription(url: string, name = 'default'): void {
  const settings = readSettings();
  const subs = settings.subscriptions || [];
  const existingIndex = subs.findIndex(s => s.name === name);
  if (existingIndex >= 0) {
    subs[existingIndex] = { name, url };
  } else {
    subs.push({ name, url });
  }
  const updates: Partial<Settings> = { subscriptions: subs };
  if (!settings.active_subscription && subs.length === 1) {
    updates.active_subscription = name;
  }
  writeSettings(updates);
}

export function setDefaultSubscription(name: string): boolean {
  const settings = readSettings();
  const subs = settings.subscriptions || [];
  const idx = subs.findIndex(s => s.name === name);
  if (idx < 0) return false;
  writeSettings({ active_subscription: name });
  return true;
}

// === GitHub mirror ===

export function getGitHubMirror(): string | null {
  const settings = readSettings();
  if (settings.github_mirror === '' || settings.github_mirror === false) {
    return null;
  }
  return (settings.github_mirror as string) || DEFAULT_GITHUB_MIRROR;
}

export function setGitHubMirror(mirror: string | null | false): string | null {
  if (mirror === null || mirror === undefined) {
    writeSettings({ github_mirror: undefined });
    return DEFAULT_GITHUB_MIRROR;
  }

  if (mirror === '' || mirror === false) {
    writeSettings({ github_mirror: '' as unknown as false });
    return null;
  }

  let mirrorUrl = mirror as string;
  if (!mirrorUrl.startsWith('http')) {
    mirrorUrl = `https://${mirrorUrl}`;
  }
  if (!mirrorUrl.endsWith('/')) {
    mirrorUrl += '/';
  }

  writeSettings({ github_mirror: mirrorUrl });
  return mirrorUrl;
}

// === Subscription raw config ===

function getSubscriptionRawConfigPath(subName: string): string {
  return `${DIRS.subscriptions}/${subName}.yaml`;
}

export function saveSubscriptionRawConfig(subName: string, content: string): void {
  ensureDirs();
  const filePath = getSubscriptionRawConfigPath(subName);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

export function readSubscriptionRawConfig(subName: string): string | null {
  const filePath = getSubscriptionRawConfigPath(subName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

// === Reset ===

export function resetUserData(options: { keepKernel?: boolean; kernelOnly?: boolean } = {}): number {
  const keepKernel = options.keepKernel !== false;
  const kernelOnly = options.kernelOnly === true;

  let itemsToRemove: string[];
  if (kernelOnly) {
    itemsToRemove = [DIRS.kernel];
  } else {
    itemsToRemove = [PATHS.settingsFile, DIRS.subscriptions, DIRS.logs, DIRS.data, DIRS.runtime];
    if (!keepKernel) {
      itemsToRemove.push(DIRS.kernel);
    }
  }

  let removedCount = 0;
  for (const item of itemsToRemove) {
    if (fs.existsSync(item)) {
      try {
        fs.rmSync(item, { recursive: true, force: true });
        removedCount++;
      } catch (e) {
        console.warn(`  警告: 无法删除 ${item}: ${(e as Error).message}`);
      }
    }
  }

  if (!kernelOnly) {
    ensureDirs();
    settingsCache = null;
  }
  return removedCount;
}
