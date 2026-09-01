import { colors } from './colors.js';
import { buildConfig, dumpYaml, getRuleTarget, parseYamlOrJson, writeDebugConfig, writeMihomoConfig } from './config.js';
import {
  AUTO_CLEAN_THRESHOLD,
  AUTO_CLEAN_THRESHOLD_GITHUB,
  CONTROLLER_BASE_URL,
  DEFAULT_AUTO_UPDATE_TIMEOUT,
  DEFAULT_CLEAN_ROUNDS,
  DEFAULT_TEST_CONCURRENCY,
  DEFAULT_TEST_TIMEOUT,
  DEFAULT_TEST_URL,
  DEFAULT_UPDATE_INTERVAL_HOURS,
  DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB,
} from './constants.js';
import { CliError, TimeoutError, withTimeout } from './errors.js';
import { createHttpClient } from './http.js';
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
  HttpResponse,
  ParsedSubscription,
  ProxyTestResult,
  ProxyTestSummary,
  Subscription,
  SubscriptionWithCache,
  TryUpdateResult,
  UserInfo,
} from './types.js';

// 供命令层沿用 `subscription.XXX` 引用（实际定义在 constants.ts，集中管理默认值）
export { AUTO_CLEAN_THRESHOLD, AUTO_CLEAN_THRESHOLD_GITHUB, DEFAULT_AUTO_UPDATE_TIMEOUT, DEFAULT_CLEAN_ROUNDS };

export function isGithubUrl(url: string): boolean {
  const githubRe = /github\.com|raw\.githubusercontent\.com/i;
  // 多 URL 合并订阅：全部来源都是 GitHub 才按 GitHub 策略（更勤更新、更低清理阈值）
  if (isMultiUrl(url)) {
    return splitUrls(url).every(u => githubRe.test(u));
  }
  return githubRe.test(url);
}

function getDefaultUpdateInterval(url: string): number {
  return isGithubUrl(url) ? DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB : DEFAULT_UPDATE_INTERVAL_HOURS;
}

/** 取有效更新间隔（小时）：缓存值需为正整数，否则回退默认值。 */
export function resolveUpdateInterval(url: string, cachedInterval?: number | null): number {
  return cachedInterval && cachedInterval > 0 ? cachedInterval : getDefaultUpdateInterval(url);
}

const HTTP_CLIENT = createHttpClient({ timeout: 60_000 });

/**
 * 是否为逗号分隔的多源订阅。
 * 判据：按逗号切分后每段都是合法 http(s) URL 且不止一段。
 * 不能只看「整体能否解析」——`https://a.com/s,https://b.com/s` 整体也能被 URL 解析
 * （逗号是合法 path 字符），那样真多源会被误判成单源。
 * 也不能只看「含逗号」——`?flag=clash,meta` 是单条 URL，切开后第二段不合法，
 * 会让 `sub add` 报「无效的 URL: meta」而无法添加。
 */
export function isMultiUrl(url: string): boolean {
  if (!url.includes(',')) return false;
  const parts = url
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
  return parts.length > 1 && parts.every(isValidHttpUrl);
}

/** 校验是否为合法 http(s) 订阅 URL：必须 http/https 协议且能被 URL 解析（排除 httpfoo://、http-evil 等）。 */
export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 拆分多源订阅；非多源（含 query 里带逗号的单条 URL）原样返回单元素数组。 */
export function splitUrls(url: string): string[] {
  if (!isMultiUrl(url)) return [url.trim()];
  return url
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
}

function loadSubscriptionConfig(subName: string): ParsedSubscription {
  const rawContent = readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new CliError(`未找到订阅配置 "${subName}"，请先更新订阅（mihomo sub update ${subName}）`);
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
  saveSubscriptionRawConfig(subName, dumpYaml(parsed.raw));
}

/**
 * 解析 `Subscription-Userinfo` 头。**只接受有限非负数，其余按「该字段缺失」处理**
 * （不落盘），而不是塞 0 或原样收下：
 * - `expire=abc` 此前塞 0，而 `formatTimestamp(0)` 特判返回「永久」——垃圾值被
 *   展示成「永久有效」，正好是最误导用户的方向
 * - `total=1e999` 是 Infinity，`JSON.stringify` 写成 `"total":null`
 * - `upload=-5` 原样入库会让用量百分比失真
 *
 * 无任何有效字段时返回 null（而非 `{}`）：`{}` 是 truthy，会让调用方误以为拿到了
 * 流量信息，进而用四个 undefined 覆盖掉缓存里已有的值（见 saveSubscriptionMeta）。
 */
export function parseUserInfo(header: string | null): UserInfo | null {
  if (!header) return null;
  const info: Record<string, number> = {};
  let hasAny = false;
  for (const part of header.split(';')) {
    const [rawKey, rawVal] = part.split('=');
    const key = rawKey?.trim();
    const val = rawVal?.trim();
    if (!key || val === undefined || val === '') continue;
    const numVal = Number(val);
    // Number('') 是 0、Number('12abc') 是 NaN；只收有限非负数
    if (!Number.isFinite(numVal) || numVal < 0) continue;
    info[key] = numVal;
    hasAny = true;
  }
  return hasAny ? (info as UserInfo) : null;
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

interface SubscriptionMeta {
  userInfo: UserInfo | null;
  updateInterval: number | null;
  webPageUrl: string | null;
  username: string | null;
}

/** 从响应头解析订阅元信息（流量/更新间隔/页面/用户名） */
function extractSubscriptionMeta(headers: Headers | undefined): SubscriptionMeta {
  return {
    userInfo: parseUserInfo(headers?.get('subscription-userinfo') ?? null),
    updateInterval: parsePositiveInterval(headers?.get('profile-update-interval')),
    webPageUrl: headers?.get('profile-web-page-url') || null,
    username: parseUsernameFromContentDisposition(headers?.get('content-disposition') ?? null),
  };
}

/**
 * 将元信息组装为缓存对象并写入订阅缓存（下载/合并下载共用）。
 *
 * 四个流量字段**逐个判断存在性**再赋值，不能整块赋：`saveSubscriptionCache` 用
 * `{...old, ...data}` 合并，显式的 `undefined` 会覆盖掉旧值。机场返回只带 upload
 * 的部分头时，整块赋会让 total/expire 凭空消失（到期日不翼而飞）。
 */
function saveSubscriptionMeta(subName: string, meta: SubscriptionMeta): void {
  const cacheData: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (meta.userInfo) {
    const { upload, download, total, expire } = meta.userInfo;
    if (upload !== undefined) cacheData.upload = upload;
    if (download !== undefined) cacheData.download = download;
    if (total !== undefined) cacheData.total = total;
    if (expire !== undefined) cacheData.expire = expire;
  }
  if (meta.updateInterval) cacheData.update_interval = meta.updateInterval;
  if (meta.webPageUrl) cacheData.web_page_url = meta.webPageUrl;
  if (meta.username) cacheData.username = meta.username;
  saveSubscriptionCache(subName, cacheData);
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

/** 取当前活跃订阅，无则抛 CliError（emptyMsg 按场景定制：无订阅 vs 有订阅但需指定）。 */
export function requireActiveSubscription(emptyMsg = '没有订阅，请先添加订阅'): Subscription {
  const sub = getActiveSubscription();
  if (!sub) {
    throw new CliError(emptyMsg);
  }
  return sub;
}

export function findSubscriptionFuzzy<T extends Subscription>(subs: T[], pattern: string): T[] {
  const lowerPattern = pattern.toLowerCase();
  const exact: T[] = [];
  const prefix: T[] = [];
  const includes: T[] = [];

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

export function pickSingleSubscription<T extends Subscription>(subs: T[], pattern: string): T {
  if (subs.length === 0) {
    throw new CliError(`未找到匹配 "${pattern}" 的订阅`);
  }
  if (subs.length === 1) return subs[0];
  throw new CliError('匹配到多个订阅，请更精确指定', {
    hint: ['', '匹配的订阅:', ...subs.map(s => `  ${s.name}`)],
  });
}

/** 模糊匹配并收敛到唯一订阅（折叠 findSubscriptionFuzzy + pickSingleSubscription）；不唯一时抛 CliError。 */
export function resolveSubscription<T extends Subscription>(subs: T[], pattern: string): T {
  return pickSingleSubscription(findSubscriptionFuzzy(subs, pattern), pattern);
}

/**
 * 校验下载内容确实是一份订阅配置，而非机场返回的错误/配额 JSON。
 * 必须在写盘前调用：saveSubscriptionRawConfig 是原子覆盖、无备份，一旦写入
 * `{"error":"quota exceeded"}` 这类「合法对象但无节点」的响应，磁盘上原本可用的
 * 订阅就被不可恢复地覆盖，而流程仍报「已更新 (0 节点)」，随后 mihomo 带零节点启动 → 断网。
 * 判据放宽到三类来源之一存在即可（proxies / proxy-groups / proxy-providers），
 * 避免误伤纯 provider 型订阅。
 */
function assertLooksLikeSubscription(parsed: Record<string, unknown>, maskedUrl: string): void {
  const hasProxies = Array.isArray(parsed.proxies) && parsed.proxies.length > 0;
  const hasGroups = Array.isArray(parsed['proxy-groups']) && (parsed['proxy-groups'] as unknown[]).length > 0;
  const providers = parsed['proxy-providers'];
  const hasProviders = providers != null && typeof providers === 'object' && Object.keys(providers as object).length > 0;

  if (hasProxies || hasGroups || hasProviders) return;

  // 服务端常把错误信息放在这些字段，取出来直接展示比「无节点」更有助排查
  const serverMsg = ['error', 'message', 'msg', 'info'].map(k => parsed[k]).find(v => typeof v === 'string' && v.length > 0) as string | undefined;

  throw new CliError('订阅内容不含任何节点来源（proxies / proxy-groups / proxy-providers 均为空）', {
    label: '订阅无效',
    hint: [
      ...(serverMsg ? [`服务端返回: ${serverMsg}`] : []),
      `URL: ${maskedUrl}`,
      '常见原因：订阅链接过期、流量耗尽、需要重新获取订阅地址。',
      '磁盘上原有的订阅配置未被覆盖。',
    ],
  });
}

export async function downloadSubscription(url: string, subName = 'default', signal?: AbortSignal, persist = true): Promise<DownloadResult> {
  let response: HttpResponse<string>;
  try {
    response = await HTTP_CLIENT.get<string>(url, { responseType: 'text', signal });
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

  assertLooksLikeSubscription(parsed, maskUrl(url));

  if (persist) {
    saveSubscriptionRawConfig(subName, content);
  }

  const meta = extractSubscriptionMeta(response.headers);
  if (persist) {
    saveSubscriptionMeta(subName, meta);
  }

  const proxies = parsed.proxies as unknown[] | undefined;
  const proxyGroups = parsed['proxy-groups'] as unknown[] | undefined;

  return {
    proxies: proxies ? proxies.length : 0,
    proxyGroups: proxyGroups ? proxyGroups.length : 0,
    userInfo: meta.userInfo,
    updateInterval: meta.updateInterval,
    webPageUrl: meta.webPageUrl,
    username: meta.username,
  };
}

export async function downloadMergedSubscription(urls: string[], subName: string, signal?: AbortSignal, persist = true): Promise<DownloadResult> {
  // 任一来源失败即取消其余下载，避免白等其他 URL
  const internal = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, internal.signal]) : internal.signal;
  const responses = await Promise.all(
    urls.map(async (url, index) => {
      try {
        const response = await HTTP_CLIENT.get(url, { responseType: 'text', signal: combinedSignal });
        return { url, index, response, error: null };
      } catch (e) {
        internal.abort();
        return { url, index, response: null, error: e as Error };
      }
    }),
  );

  // 优先报非 abort 的真实错误：任一 URL 失败会 internal.abort() 取消其余请求，
  // 若按顺序取第一个 error，报出的往往是被连带取消的那条（"This operation was aborted"），
  // 真正的 403/token 过期被隐藏，用户会去排查错误的订阅源
  const failures = responses.filter(r => r.error);
  if (failures.length > 0) {
    const isAbort = (e: Error) => e.name === 'AbortError' || /abort/i.test(e.message);
    const real = failures.find(r => !isAbort(r.error as Error)) ?? failures[0];
    const maskedUrl = maskUrl(real.url);
    throw new Error(`合并订阅第 ${real.index + 1} 个 URL 获取失败: ${(real.error as Error).message}\n  URL: ${maskedUrl}`);
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

  const mergedContent = dumpYaml(base);
  // 同单源：合并结果无任何节点来源时不写盘，避免覆盖掉磁盘上可用的旧配置
  assertLooksLikeSubscription(base, urls.map(u => maskUrl(u)).join(', '));
  if (persist) {
    saveSubscriptionRawConfig(subName, mergedContent);
  }

  const meta = extractSubscriptionMeta(responses[0].response?.headers);
  if (persist) {
    saveSubscriptionMeta(subName, meta);
  }

  const proxyGroups = base['proxy-groups'] as unknown[] | undefined;
  return {
    proxies: baseProxies.length,
    proxyGroups: proxyGroups ? proxyGroups.length : 0,
    userInfo: meta.userInfo,
    updateInterval: meta.updateInterval,
    webPageUrl: meta.webPageUrl,
    username: meta.username,
  };
}

export function prepareConfigForStart(mode: string, subName = 'default'): { proxies: number; proxyGroups: number } {
  const rawContent = readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new CliError(`未找到订阅配置 "${subName}"，请先添加订阅`);
  }

  const subUrl = getSubscriptions().find(s => s.name === subName)?.url;
  const buildResult = buildConfig(rawContent, mode, { subName, subUrl });

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
  // 未来时间戳（系统时钟被改过、跨时区调时、缓存被手改）会让下面的差值恒为负，
  // needsAutoUpdate 恒 false —— 订阅从此永不自动更新，静默过期到失联。
  // 视为「缓存不可信」立即更新，顺带把 updated_at 纠正回当前时间。
  if (lastUpdate > Date.now()) return true;
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

/** 打印单个订阅的更新结果（成功/失败），供自动更新与手动更新命令共用 */
export function printUpdateResult(r: TryUpdateResult): void {
  if (r.success) {
    console.log(`${colors.green('✓')} ${r.name}: ${colors.green('已更新')} (${formatProxySummary(r)})`);
  } else {
    console.log(`${colors.red('✗')} ${r.name}: ${colors.red('失败')} (${(r.error || '').split('\n')[0]})`);
  }
}

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
  // 结果就地收集：超时后也能统计已完成的更新，而不是把全部计为失败
  const results: TryUpdateResult[] = [];
  const updatePromise = Promise.all(
    staleSubs.map(sub =>
      tryUpdateOne(sub, controller.signal).then(r => {
        results.push(r);
        return r;
      }),
    ),
  );
  try {
    await withTimeout(updatePromise, timeoutMs);
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    controller.abort(); // 中断仍在跑的 fetch，阻止其超时后成功回来又写盘（与"已用缓存启动"竞态）
    await updatePromise.catch(() => {}); // 等 abort 落地，收全已完成/已失败的结果
    console.log(colors.yellow(`自动更新超时 (${timeoutMs / 1000}s)，已完成的更新生效，其余使用缓存配置`));
  }

  let updatedCount = 0;

  for (const r of results) {
    if (r.success) updatedCount++;
    printUpdateResult(r);
  }

  return { total: staleSubs.length, updated: updatedCount, failed: staleSubs.length - updatedCount };
}

async function testProxyDelay(
  proxyName: string,
  timeout: number,
  testUrl: string,
  client: ReturnType<typeof createHttpClient>,
  apiBase = CONTROLLER_BASE_URL,
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
  const {
    timeout = DEFAULT_TEST_TIMEOUT,
    concurrency = DEFAULT_TEST_CONCURRENCY,
    testUrl = DEFAULT_TEST_URL,
    apiBase = CONTROLLER_BASE_URL,
    onResult,
  } = options;

  const { proxies } = options.parsed || loadSubscriptionConfig(subName);

  if (proxies.length === 0) {
    return { total: 0, alive: 0, dead: 0, results: [] };
  }

  // 走主实例（默认 CONTROLLER_BASE_URL）时附带 controller_secret；隔离测试实例自身无 secret，不带
  const secret = apiBase === CONTROLLER_BASE_URL ? readSettings().controller_secret : undefined;
  const client = createHttpClient({ timeout: timeout + 3000, secret });
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

export function normalizeProxyNamesBeforeSave(parsed: ParsedSubscription): number {
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

  // 同步 raw.rules 中直接引用旧节点名的规则目标，避免裁剪后留下悬空引用（会被 validateConfig 静默删除）
  const rules = parsed.raw.rules;
  if (Array.isArray(rules)) {
    parsed.raw.rules = rules.map(rule => {
      if (typeof rule !== 'string') return rule;
      const parts = rule.split(',');
      if (parts.length < 2) return rule;
      // 目标位：末段是 no-resolve 修饰时取倒数第二段（与 config.ts getRuleTarget 口径一致）
      const targetIdx = parts[parts.length - 1].trim().toLowerCase() === 'no-resolve' && parts.length >= 3 ? parts.length - 2 : parts.length - 1;
      const target = parts[targetIdx].trim();
      const renamed = renameMap.get(target);
      if (renamed) parts[targetIdx] = renamed;
      return parts.join(',');
    });
  }

  return renameMap.size;
}

function cleanDeadProxies(parsed: ParsedSubscription, deadNames: Set<string>): { removedProxies: number; updatedGroups: number; removedGroups: number } {
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
      // 与 config.ts validateConfig 一致：有 use/include-all 等其他节点来源的组，proxies 清空也不删
      const hasOtherSource = group.use || group['include-all'] || group['include-all-proxies'];
      if (group.proxies.length === 0 && !hasOtherSource) {
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

  // 移除引用了已删空分组或已删死节点的规则，避免残留在保存的订阅文件里
  // （target 提取与 config.ts validateConfig 一致；构建时还有一层兜底）
  const removedTargets = new Set([...removedGroupNames, ...deadNames]);
  if (removedTargets.size > 0) {
    const rules = parsed.raw.rules;
    if (Array.isArray(rules)) {
      parsed.raw.rules = rules.filter(rule => {
        if (typeof rule !== 'string') return true;
        return !removedTargets.has(getRuleTarget(rule));
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
