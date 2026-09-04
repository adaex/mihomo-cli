import { colors } from './colors.js';
import { buildConfig, parseYamlOrJson, writeDebugConfig, writeMihomoConfig } from './config.js';
import { DEFAULT_AUTO_UPDATE_TIMEOUT, DEFAULT_UPDATE_INTERVAL_HOURS, DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB } from './constants.js';
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
  ConfigSummary,
  DownloadResult,
  HttpResponse,
  PreparedConfig,
  Subscription,
  SubscriptionWithCache,
  TryUpdateResult,
  UserInfo,
} from './types.js';

// 供命令层沿用 `subscription.XXX` 引用（实际定义在 constants.ts，集中管理默认值）
export { DEFAULT_AUTO_UPDATE_TIMEOUT };

export function isGithubUrl(url: string): boolean {
  return /github\.com|raw\.githubusercontent\.com/i.test(url);
}

function getDefaultUpdateInterval(url: string): number {
  return isGithubUrl(url) ? DEFAULT_UPDATE_INTERVAL_HOURS_GITHUB : DEFAULT_UPDATE_INTERVAL_HOURS;
}

/** 取有效更新间隔（小时）：缓存值需为正整数，否则回退默认值。 */
export function resolveUpdateInterval(url: string, cachedInterval?: number | null): number {
  return cachedInterval && cachedInterval > 0 ? cachedInterval : getDefaultUpdateInterval(url);
}

const HTTP_CLIENT = createHttpClient({ timeout: 60_000 });

/** 校验是否为合法 http(s) 订阅 URL：必须 http/https 协议且能被 URL 解析（排除 httpfoo://、http-evil 等）。 */
export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
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
 * 将元信息组装为缓存对象并写入订阅缓存。
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

/**
 * 构建并校验待启动的配置，**不写盘**。
 *
 * 与 commitPreparedConfig 分成两步，是为了让 start 能「先校验、再停机」：
 * 坏覆写或不合法订阅在这一步就抛错，此时运行中的内核还没被 stop() 带走，
 * 用户维持在可用状态。合成一步的话，stop() 已经 rmrf 掉 runtime/，
 * 构建失败就留下「已停机 + 无 config.yaml」的半死态，且无从回滚。
 */
export function prepareConfigForStart(mode: string, subName = 'default'): PreparedConfig {
  const rawContent = readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new CliError(`未找到订阅配置 "${subName}"，请先添加订阅`);
  }

  const subUrl = getSubscriptions().find(s => s.name === subName)?.url;
  const buildResult = buildConfig(rawContent, mode, { subName, subUrl });

  const proxies = buildResult.config.proxies as unknown[] | undefined;
  const proxyGroups = buildResult.config['proxy-groups'] as unknown[] | undefined;

  return {
    buildResult,
    info: {
      proxies: proxies ? proxies.length : 0,
      proxyGroups: proxyGroups ? proxyGroups.length : 0,
    },
  };
}

/**
 * 把已校验的配置落盘。必须在 stop() 之后调用：stop() 的 clearRuntime()
 * 会 rmrf 整个 runtime/，先写就会被连同 pid 一起删掉。
 * 自动修复告警也放这里打印，避免校验失败时先刷一屏「已修复」再报错。
 */
export function commitPreparedConfig(prepared: PreparedConfig): ConfigSummary {
  const { buildResult } = prepared;

  if (buildResult.warnings.length > 0) {
    for (const warning of buildResult.warnings) {
      console.log(`${colors.yellow('自动修复:')} ${warning}`);
    }
    console.log('');
  }

  writeMihomoConfig(buildResult.config);
  writeDebugConfig(buildResult);

  return prepared.info;
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
    const info = await downloadSubscription(sub.url, sub.name, signal);
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
