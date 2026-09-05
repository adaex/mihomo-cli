import fs from 'node:fs';
import path from 'node:path';
import { CONTROLLER_PORT, DEFAULT_MIXED_PORT } from './constants.js';
import { CliError } from './errors.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS, withFileLock } from './paths.js';
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

/**
 * 校验 settings 内容是否为合法 JSON 对象（纯函数，不触发恢复/备份/缓存）。
 * 供 doctor 等只读诊断复用，避免各处自己 JSON.parse 后对「损坏」的定义漂移。
 */
export function isValidSettingsContent(content: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * 写入设置。**持跨进程锁 + 先丢缓存重读盘再合并**：`settingsCache` 是进程级的，
 * 而两个 CLI 进程会并发跑（慢速 `sub add` 跨整个网络下载期间，用户在另一个终端
 * 做别的操作是日常）。此前拿启动时的陈旧缓存做全量合并写回，会把对方刚落盘的
 * 改动整块抹掉，**且写入方收到的是成功回执**——实测 6 个并发 `sub add` 丢 3 条。
 *
 * 本函数只安全用于「单键/整值替换」。**数组类改动（subscriptions）必须走
 * `updateSettings`**：调用方若在锁外用陈旧数组算好再传进来，重读也无从恢复对方的条目。
 */
export function writeSettings(settings: Partial<Settings>): Settings {
  ensureDirs();
  return withFileLock(PATHS.settingsFile, () => writeSettingsUnlocked(settings));
}

/** `writeSettings` 的锁内实现。锁不可重入，故持锁路径（updateSettings）只能调它。 */
function writeSettingsUnlocked(settings: Partial<Settings>): Settings {
  settingsCache = null;
  const existing = readSettings();
  const merged = { ...existing, ...settings } as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if ((settings as Record<string, unknown>)[key] === undefined) delete merged[key];
  }
  atomicWriteFileSync(PATHS.settingsFile, JSON.stringify(merged, null, 2), { mode: 0o600 });
  settingsCache = merged as Settings;
  return settingsCache;
}

/**
 * 读-改-写的唯一正确入口：**持跨进程锁**，丢缓存 → 读盘上最新 → 由 mutator 基于
 * 最新算出改动 → 写回 → 放锁。
 *
 * 数组类改动（subscriptions）必须用它而不是 `writeSettings`：
 * 后者虽也重读，但读与写之间仍有窗口，两个进程照样能交错（实测 6 个并发
 * `sub add` 仍丢 3 条）。只有把整个读-改-写圈进锁里才真正安全。
 *
 * mutator 必须同步、且不得再调用本函数或 `writeSettings`（锁不可重入，会死等到
 * 强夺陈旧锁）。mutator 内部读 `getSubscriptions()` 是安全的：
 * 缓存已在进锁后清掉，它读到的是盘上最新。
 */
export function updateSettings(mutate: (current: Settings) => Partial<Settings>): Settings {
  ensureDirs();
  return withFileLock(PATHS.settingsFile, () => {
    settingsCache = null;
    const current = readSettings();
    return writeSettingsUnlocked(mutate(current));
  });
}

export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/** 校验单个端口覆盖值：1-65535 的整数。返回 undefined 表示「未配置，用默认」。 */
function validatePort(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new CliError(`settings.json 的 ${key} 需为 1-65535 的整数，当前是 ${JSON.stringify(value)}`, {
      label: '配置错误',
      hint: ['示例:', '  "ports": { "mixed": 17890, "controller": 19090 }', '两个键均可选；删掉 ports 则回到默认端口 7890/9090'],
    });
  }
  return value;
}

/**
 * 端口解析的唯一入口（config 构建、热重载、ui 文案、doctor 共用）：
 * settings.ports 覆盖默认 7890/9090，非法值直接抛错而非静默回退——
 * 端口突降回默认会让 controller 调用与热重载连到错误地址，且用户毫无线索。
 */
export function getPorts(): { mixed: number; controller: number } {
  const ports = readSettings().ports;
  if (ports === undefined) return { mixed: DEFAULT_MIXED_PORT, controller: CONTROLLER_PORT };
  if (ports === null || typeof ports !== 'object' || Array.isArray(ports)) {
    throw new CliError('settings.json 的 ports 需为对象，如 { "mixed": 17890, "controller": 19090 }', { label: '配置错误' });
  }
  const mixed = validatePort(ports.mixed, 'ports.mixed');
  const controller = validatePort(ports.controller, 'ports.controller');
  if (mixed !== undefined && controller !== undefined && mixed === controller) {
    throw new CliError(`ports.mixed 与 ports.controller 不能相同（当前均为 ${mixed}）`, {
      label: '配置错误',
      hint: ['混合端口与控制器端口各需独立端口，相同会导致内核启动失败'],
    });
  }
  return { mixed: mixed ?? DEFAULT_MIXED_PORT, controller: controller ?? CONTROLLER_PORT };
}

/** 遮蔽单条 URL 里的敏感信息（query token / userinfo / 路径型令牌）。 */
function maskSingleUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // 已知 token 参数名（值可能很短，如 ?token=abc）
    const tokenKeys = new Set([
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
      'api_key',
      'access',
    ]);
    // 启发式：值长度 ≥16 的 query 参数一律遮蔽（token 几乎都是长串，误伤率低）。
    // 黑名单永远枚举不完（uuid/sid/id 等都曾漏网），启发式更耐久。
    for (const [key, value] of parsed.searchParams) {
      if (tokenKeys.has(key.toLowerCase()) || value.length >= 16) {
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

/**
 * 遮蔽 URL 中的敏感信息。
 * 不对逗号做任何切分：逗号在 query/path 中合法（`?nodes=us,hk&token=xxx`），
 * 切开后两段都不含可识别的 token 参数，反而会让密钥明文输出。
 */
export function maskUrl(url: string): string {
  if (!url) return url;
  return maskSingleUrl(url);
}

// === Subscription cache ===

/**
 * 读订阅缓存。返回**无原型对象**（`Object.create(null)`）：订阅名会作为键使用，
 * 而 `__proto__` / `constructor` / `prototype` 都通过 `SAFE_NAME_RE` 校验。
 * 普通对象上 `cache['__proto__'] = {...}` 是**设置原型而非自有属性**，
 * `JSON.stringify` 后落盘为 `{}` → `updated_at` 永远缺失 → `needsAutoUpdate` 恒 true
 * → 每次 `start` 都重新下载该订阅。无原型对象上这三个名字都是普通键。
 */
export function readSubscriptionCache(): SubscriptionCache {
  ensureDirs();
  const empty = (): SubscriptionCache => Object.create(null) as SubscriptionCache;
  if (fs.existsSync(PATHS.subscriptionsCacheFile)) {
    try {
      const content = fs.readFileSync(PATHS.subscriptionsCacheFile, 'utf8');
      const parsed = JSON.parse(content) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return empty();
      // 拷进无原型对象：JSON.parse 的结果仍是普通对象，直接返回会让后续
      // cache['__proto__'] = ... 重新踩回设置原型的坑
      return Object.assign(empty(), parsed);
    } catch {
      // 与 settings.json 一致：损坏先备份再回退默认，避免下次写入覆盖丢失原始内容
      try {
        fs.copyFileSync(PATHS.subscriptionsCacheFile, `${PATHS.subscriptionsCacheFile}.bak`);
        console.warn(`警告: 订阅缓存格式损坏，已备份到 ${PATHS.subscriptionsCacheFile}.bak`);
      } catch {
        console.warn('警告: 订阅缓存格式损坏，已忽略');
      }
      return empty();
    }
  }
  return empty();
}

function writeSubscriptionCache(cache: SubscriptionCache): void {
  ensureDirs();
  atomicWriteFileSync(PATHS.subscriptionsCacheFile, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

/**
 * 更新单个订阅的缓存条目（读全量→合并该条→写全量），**持跨进程锁**。
 *
 * 单进程内的并行更新（autoUpdateStaleSubscription 的 Promise.all）靠「全程同步、
 * 读写之间无 await」即可安全，但那只在进程内成立：cache.json 与 settings.json 一样
 * 会被多个 CLI 进程同时写（一个终端 `sub update` 并行下载各自回写，另一个终端
 * `start` 又触发自动更新），裸读-改-写下后写者会整块覆盖先写者的条目。
 * 实测 2 进程各写 30 条丢 1 条、4 进程各写 30 条丢 7 条。
 *
 * 丢的是 `updated_at` → `needsAutoUpdate` 恒 true → 该订阅每次 `start` 都重新下载，
 * 且流量/到期展示一并消失。故与 settings.json 同构，把整个读-改-写圈进锁里。
 */
export function saveSubscriptionCache(subName: string, data: Partial<SubscriptionCacheEntry>): void {
  ensureDirs();
  withFileLock(PATHS.subscriptionsCacheFile, () => {
    const cache = readSubscriptionCache();
    // 损坏的条目可能是字符串/数字（cache.json 被手改），展开会产生字符键垃圾
    const old = cache[subName];
    cache[subName] = { ...(old && typeof old === 'object' && !Array.isArray(old) ? old : {}), ...data };
    writeSubscriptionCache(cache);
  });
}

/** 删除单个订阅的缓存条目。同 saveSubscriptionCache 持锁：并发下裸读-改-写会覆盖对方的条目。 */
function deleteSubscriptionCache(subName: string): void {
  ensureDirs();
  withFileLock(PATHS.subscriptionsCacheFile, () => {
    const cache = readSubscriptionCache();
    if (!cache[subName]) return;
    delete cache[subName];
    writeSubscriptionCache(cache);
  });
}

// === Subscription list ===

function isValidSubscription(s: unknown): s is Subscription {
  return s != null && typeof s === 'object' && typeof (s as Subscription).name === 'string' && typeof (s as Subscription).url === 'string';
}

/**
 * 订阅列表的唯一读取入口。住在 settings.ts 而非订阅命令层：subscription.ts（核心）、
 * config.ts、status 等多处都要读。
 *
 * 非数组一律视为空列表：字段被手改成非数组（如 `{"subscriptions":"oops"}`）时，
 * 下游的展开运算符会把字符串按字符展开成垃圾列表且不报错，后续所有 s.name 都是 undefined。
 * 条目再经 isValidSubscription 滤掉残缺项。
 */
export function getSubscriptions(): Subscription[] {
  // 收成 unknown 再过滤：直接 .filter(类型谓词) 匹配不上 filter 的 S extends T 重载
  const list: unknown = readSettings().subscriptions;
  if (!Array.isArray(list)) {
    if (list !== undefined) {
      console.warn('警告: settings.json 的 subscriptions 不是列表，已忽略（可用 mihomo sub add 重新添加）');
    }
    return [];
  }
  return list.filter(isValidSubscription);
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
 * 订阅名白名单：字母数字下划线短横线与中文，最长 64。名字会被拼进文件路径
 * （subscriptions/<name>.yaml），刻意不含 `.`，以免破坏覆写文件名的分段结构。
 */
export const SAFE_NAME_RE = /^[\w\-\p{Unified_Ideograph}]{1,64}$/u;

function validateSubscriptionName(name: string): void {
  if (!name || !SAFE_NAME_RE.test(name)) {
    throw new CliError(`订阅名称无效: "${name}"，只允许字母、数字、下划线、短横线和中文（最长 64 字符）`);
  }
}

export function addSubscription(url: string, name = 'default'): void {
  validateSubscriptionName(name);
  // 经 updateSettings：列表必须基于盘上最新计算，否则并发的另一个 CLI 进程
  // 刚添加的订阅会被本次的陈旧数组覆盖掉（对方却已打印「已添加」）
  let duplicate = false;
  updateSettings(settings => {
    // 经 getSubscriptions 而非直读：非数组的 subscriptions 会被字符串展开成垃圾列表
    const subs = [...getSubscriptions()];
    if (subs.some(s => s.name === name)) {
      duplicate = true;
      return {};
    }
    subs.push({ name, url });
    const updates: Partial<Settings> = { subscriptions: subs };
    if (!settings.active_subscription && subs.length === 1) {
      updates.active_subscription = name;
    }
    return updates;
  });
  // 抛错移到 mutator 外：mutator 内抛会让 updateSettings 半途退出，语义不清
  if (duplicate) {
    throw new CliError(`订阅 "${name}" 已存在，请换个名称（mihomo sub add <url> <名称>），或先删除（mihomo sub remove ${name}）`);
  }
}

export function removeSubscription(name: string): string | null {
  let switchedTo: string | null = null;
  let found = false;

  updateSettings(settings => {
    const subs = [...getSubscriptions()];
    const idx = subs.findIndex(s => s.name === name);
    if (idx < 0) return {};
    found = true;

    subs.splice(idx, 1);
    const updates: Partial<Settings> = { subscriptions: subs };

    if (settings.active_subscription === name) {
      switchedTo = subs.length > 0 ? subs[0].name : null;
      updates.active_subscription = switchedTo ?? undefined;
    }

    // 在锁内删原始配置：锁外 rm 与并发 sub add 同名存在 TOCTOU——
    // A 删 foo（锁内提交）→ B 加 foo（锁内提交 + 下载写 foo.yaml）→ A 锁外 rm 删掉 B 刚写的配置
    try {
      fs.rmSync(getSubscriptionRawConfigPath(name), { force: true });
    } catch {
      /* 名字非法时跳过文件清理 */
    }

    return updates;
  });

  if (!found) return null;

  deleteSubscriptionCache(name);

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
