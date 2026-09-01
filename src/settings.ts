import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS } from './paths.js';
import type { Settings, Subscription, SubscriptionCache, SubscriptionCacheEntry, SubscriptionWithCache } from './types.js';

let settingsCache: Settings | null = null;

export function readSettings(): Settings {
  if (settingsCache !== null) return settingsCache;
  ensureDirs();
  if (fs.existsSync(PATHS.settingsFile)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(PATHS.settingsFile, 'utf8'));
    } catch {
      return recoverCorruptedSettings();
    }
    // 合法 JSON 但不是对象（null / [] / 123 / "hi"）同样视为损坏：
    // 此前直接赋给 settingsCache，null 会让 getSubscriptions() 抛裸 TypeError + 堆栈，
    // 字符串会被 writeSettings 展开成 {"0":"h","1":"i",...}，且 settingsCache=null
    // 使缓存判定恒失效、每次调用都重新读盘
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return recoverCorruptedSettings();
    }
    settingsCache = parsed as Settings;
    return settingsCache;
  }
  settingsCache = {};
  return settingsCache;
}

/** 损坏的 settings.json 先备份（保留原始内容供人工恢复）再回退默认值。 */
function recoverCorruptedSettings(): Settings {
  try {
    fs.copyFileSync(PATHS.settingsFile, `${PATHS.settingsFile}.bak`);
    console.warn(`警告: settings.json 格式损坏，已备份到 ${PATHS.settingsFile}.bak，使用默认设置`);
  } catch {
    console.warn('警告: settings.json 格式损坏，使用默认设置');
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
  atomicWriteFileSync(PATHS.settingsFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
  settingsCache = merged as Settings;
  return settingsCache;
}

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/** 遮蔽单条 URL 里的敏感信息（query token / userinfo / 路径型令牌）。 */
function maskSingleUrl(url: string): string {
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
    // 路径型 token（如 /api/v1/client/subscribe/<长串>）：对疑似令牌的长路径段做遮蔽，
    // 保留结构可读。阈值 16，保留首尾 4 位便于用户辨认是哪条订阅。
    parsed.pathname = parsed.pathname
      .split('/')
      .map(seg => (seg.length >= 16 ? `${seg.slice(0, 4)}***${seg.slice(-4)}` : seg))
      .join('/');
    return parsed.toString();
  } catch {
    if (url.length > 30) {
      return `${url.slice(0, 15)}...${url.slice(-10)}`;
    }
    return url;
  }
}

/** 是否为逗号分隔的多源订阅：切分后每段都是合法 http(s) URL 且不止一段。 */
function looksLikeMultiUrl(url: string): boolean {
  if (!url.includes(',')) return false;
  const parts = url
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every(p => {
    try {
      const u = new URL(p);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  });
}

/**
 * 遮蔽 URL 中的敏感信息，支持逗号分隔的多源订阅。
 * 关键：只有「每段都是合法 URL」才按多源切分。无条件按逗号切分会把
 * `?nodes=us,hk&token=xxx` 劈开，两段都不含可识别的 token 参数 → 密钥明文输出。
 * 反之只看「整体能否解析」也不行：真多源 `https://a/s,https://b/s` 整体亦可解析
 * （逗号是合法 path 字符），会导致第二段的 token 完全不被遮蔽。
 * 判据与 subscription.isMultiUrl 保持一致。
 */
export function maskUrl(url: string): string {
  if (!url) return url;

  if (looksLikeMultiUrl(url)) {
    return url
      .split(',')
      .map(u => maskSingleUrl(u.trim()))
      .join(', ');
  }
  return maskSingleUrl(url);
}

// === Subscription cache ===

export function readSubscriptionCache(): SubscriptionCache {
  ensureDirs();
  if (fs.existsSync(PATHS.subscriptionsCacheFile)) {
    try {
      const content = fs.readFileSync(PATHS.subscriptionsCacheFile, 'utf8');
      return JSON.parse(content) as SubscriptionCache;
    } catch {
      // 与 settings.json 一致：损坏先备份再回退默认，避免下次写入覆盖丢失原始内容
      try {
        fs.copyFileSync(PATHS.subscriptionsCacheFile, `${PATHS.subscriptionsCacheFile}.bak`);
        console.warn(`警告: 订阅缓存格式损坏，已备份到 ${PATHS.subscriptionsCacheFile}.bak`);
      } catch {
        console.warn('警告: 订阅缓存格式损坏，已忽略');
      }
      return {};
    }
  }
  return {};
}

function writeSubscriptionCache(cache: SubscriptionCache): void {
  ensureDirs();
  atomicWriteFileSync(PATHS.subscriptionsCacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/**
 * 更新单个订阅的缓存条目（读全量→合并该条→写全量）。
 * 必须保持全程同步、读写之间不得插入 await：并行更新（autoUpdateStaleSubscription 的
 * Promise.all）依赖 Node 单线程下本函数不可被中断，才能避免「A 读旧全量、B 读旧全量、
 * B 写覆盖掉 A 的改动」的读-改-写丢失。临时文件踩踏另由 atomicWriteFileSync 的唯一临时名解决。
 */
export function saveSubscriptionCache(subName: string, data: Partial<SubscriptionCacheEntry>): void {
  const cache = readSubscriptionCache();
  cache[subName] = { ...cache[subName], ...data };
  writeSubscriptionCache(cache);
}

// === Subscription list ===

/**
 * 订阅列表的唯一读取入口。
 * 校验必须在此收口：settings.json 被手改成 `{"subscriptions":"oops"}` 时，
 * 下游的 `[...(settings.subscriptions || [])]` 会把字符串按字符展开，写出
 * `["o","o","p","s",{...}]` 这种垃圾列表且不报错，后续所有 s.name 都是 undefined。
 * 非数组一律视为空列表；顺带滤掉缺 name/url 的残缺条目。
 */
export function getSubscriptions(): Subscription[] {
  const settings = readSettings();
  const subs = settings.subscriptions;
  if (!Array.isArray(subs)) {
    if (subs !== undefined) {
      console.warn('警告: settings.json 的 subscriptions 不是列表，已忽略（可用 mihomo sub add 重新添加）');
    }
    return [];
  }
  return subs.filter(s => s != null && typeof s === 'object' && typeof s.name === 'string' && typeof s.url === 'string');
}

export function getSubscriptionsWithCache(): SubscriptionWithCache[] {
  const subs = getSubscriptions();
  const cache = readSubscriptionCache();
  return subs.map(s => ({
    ...s,
    ...(cache[s.name] || {}),
  }));
}

/**
 * 名称白名单：字母数字下划线短横线与中文，最长 64。同时用于订阅名与隧道名——
 * 两者都会被拼进文件路径（subscriptions/<name>.yaml、overwrite.tunnel-<name>.yaml），
 * 共用一条规则避免两套口径漂移。刻意不含 `.`，以免破坏覆写文件名的分段结构。
 */
export const SAFE_NAME_RE = /^[\w\-\p{Unified_Ideograph}]{1,64}$/u;

function validateSubscriptionName(name: string): void {
  if (!name || !SAFE_NAME_RE.test(name)) {
    throw new CliError(`订阅名称无效: "${name}"，只允许字母、数字、下划线、短横线和中文（最长 64 字符）`);
  }
}

export function addSubscription(url: string, name = 'default'): void {
  validateSubscriptionName(name);
  const settings = readSettings();
  // 经 getSubscriptions 而非直读：非数组的 subscriptions 会被字符串展开成垃圾列表
  const subs = [...getSubscriptions()];
  if (subs.some(s => s.name === name)) {
    throw new CliError(`订阅 "${name}" 已存在，请换个名称（mihomo sub add <url> <名称>），或先删除（mihomo sub remove ${name}）`);
  }
  subs.push({ name, url });
  const updates: Partial<Settings> = { subscriptions: subs };
  if (!settings.active_subscription && subs.length === 1) {
    updates.active_subscription = name;
  }
  writeSettings(updates);
}

export function removeSubscription(name: string): string | null {
  const settings = readSettings();
  const subs = [...getSubscriptions()];
  const idx = subs.findIndex(s => s.name === name);
  if (idx < 0) return null;

  subs.splice(idx, 1);
  const updates: Partial<Settings> = { subscriptions: subs };

  let switchedTo: string | null = null;
  if (settings.active_subscription === name) {
    switchedTo = subs.length > 0 ? subs[0].name : null;
    updates.active_subscription = switchedTo ?? undefined;
  }

  writeSettings(updates);

  const cache = readSubscriptionCache();
  if (cache[name]) {
    delete cache[name];
    writeSubscriptionCache(cache);
  }

  // 名字非法（手改 settings.json）时 getSubscriptionRawConfigPath 会抛错；
  // 此处跳过文件清理即可——订阅已从设置移除，非法路径的文件本就不应存在
  try {
    fs.rmSync(getSubscriptionRawConfigPath(name), { force: true });
  } catch {
    /* ignore */
  }

  return switchedTo;
}

export function setDefaultSubscription(name: string): boolean {
  const settings = readSettings();
  const subs = getSubscriptions();
  const idx = subs.findIndex(s => s.name === name);
  if (idx < 0) return false;
  if (settings.active_subscription === name) return true;
  writeSettings({ active_subscription: name });
  return true;
}

// === Subscription raw config ===

function getSubscriptionRawConfigPath(subName: string): string {
  // 防御路径穿越：名字正常经 addSubscription 校验，但 settings.json 可被手改成 ../ 之类，
  // 直接拼接会让读/写/删越出 subscriptions 目录
  if (!SAFE_NAME_RE.test(subName)) {
    throw new CliError(`订阅名称无效: "${subName}"`);
  }
  return path.join(DIRS.subscriptions, `${subName}.yaml`);
}

export function saveSubscriptionRawConfig(subName: string, content: string): void {
  ensureDirs();
  const filePath = getSubscriptionRawConfigPath(subName);
  atomicWriteFileSync(filePath, content, { mode: 0o600 });
}

export function readSubscriptionRawConfig(subName: string): string | null {
  const filePath = getSubscriptionRawConfigPath(subName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}
