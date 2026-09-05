// === Settings ===

export interface Subscription {
  url: string;
  name: string;
}

export interface Settings {
  subscriptions?: Subscription[];
  active_subscription?: string;
  overwrite_enabled?: boolean;
  /** external-controller 访问密钥（可选，多用户环境建议设置）；不设置则控制器无鉴权 */
  controller_secret?: string;
  /**
   * 内核下载的镜像偏好（`mihomo kernel --mirror` 记住、`--no-mirror` 清除）。
   * 存 normalize 后的 https URL；缺省 = 直连。
   */
  kernel_mirror?: string;
  /**
   * 端口覆盖（可选，逃生口：默认端口被其他代理工具占用时调整）。
   * 两键均可选；值必须是 1-65535 的整数，非法值在使用点抛错（getPorts）而非静默回退默认——
   * 端口突降会让 UI/热重载连到错误地址且毫无线索。
   */
  ports?: {
    mixed?: number;
    controller?: number;
  };
}

// === Subscription Cache ===

export interface SubscriptionCacheEntry {
  updated_at?: string;
  update_interval?: number;
  upload?: number;
  download?: number;
  total?: number;
  expire?: number;
  web_page_url?: string;
  username?: string;
}

export interface SubscriptionCache {
  [name: string]: SubscriptionCacheEntry;
}

export interface SubscriptionWithCache extends Subscription, Partial<SubscriptionCacheEntry> {}

// === Download Result ===

export interface DownloadResult {
  proxies: number;
  proxyGroups: number;
  userInfo: UserInfo | null;
  updateInterval: number | null;
  webPageUrl: string | null;
  username: string | null;
}

/**
 * `Subscription-Userinfo` 头解析结果。四个字段都是**可选**的：机场可能只返回其中
 * 几个，也可能返回垃圾值（被 parseUserInfo 按缺失丢弃）。声明为必填会让
 * 「缺字段」在类型层面不可见，进而写出用 undefined 覆盖旧缓存的代码。
 */
export interface UserInfo {
  upload?: number;
  download?: number;
  total?: number;
  expire?: number;
  [key: string]: number | undefined;
}

// === Config Build ===

export interface BuildConfigResult {
  config: Record<string, unknown>;
  subscriptionConfig: Record<string, unknown>;
  overwriteFiles: OverwriteFileEntry[];
  systemConfig: Record<string, unknown>;
  warnings: string[];
}

/** 配置规模摘要，用于启动时的一行提示（`Mixed · default · 12 组, 340 节点`） */
export interface ConfigSummary {
  proxies: number;
  proxyGroups: number;
}

/** 已构建校验、尚未写盘的配置。见 subscription.prepareConfigForStart */
export interface PreparedConfig {
  buildResult: BuildConfigResult;
  info: ConfigSummary;
}

export interface OverwriteFileEntry {
  name: string;
  path: string;
  config: Record<string, unknown>;
  match?: OverwriteMatch;
}

export interface OverwriteFileInfo {
  name: string;
  path: string;
  keys: string[];
  scope?: string;
}

// === Process ===

export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  processInfo: ProcessInfo | null;
  hasConfig: boolean;
  hasKernel: boolean;
  kernelVersion: string | null;
}

export interface ProcessInfo {
  pid: number;
  memory: string;
  isRoot: boolean;
}

export interface StartResult {
  success: boolean;
  pid: number;
  mode?: 'mixed' | 'tun';
}

export interface StopResult {
  success: boolean;
  notRunning?: boolean;
  killed?: number;
  warning?: string;
  remaining?: number[];
}

export interface CleanupResult {
  killed: number;
  failed: number;
  remaining: number[];
}

export interface StaleState {
  needsCleanup: boolean;
  allPids: number[];
  hasRootProcess: boolean;
  hasRootPidFile: boolean;
  needsSudo: boolean;
}

// === Service (launchd 服务) ===

export interface ServiceStatus {
  /** plist 文件是否存在 */
  installed: boolean;
  /** launchctl print 能查到（已 bootstrap 进域） */
  loaded: boolean;
  /** 顶层 state = running */
  running: boolean;
  /** 服务进程 PID（未运行为 null） */
  pid: number | null;
  /** 登录自启是否被禁用（launchctl disable 位，独立于 plist 文件存在与否） */
  disabled: boolean;
  /**
   * 托管进程上次的退出码；从未退出过（健康运行）或查不到为 null。
   *
   * 非 0 即「内核起来过又挂了」。这是区分「用户主动停止」与「崩溃循环」的唯一信号：
   * 两者的 running 都是 false，但后者会被 KeepAlive 每隔约 10s 反复拉起。
   * launchd 在健康服务上把该字段写成字符串 `(never exited)`，故解析后为 null。
   */
  lastExitCode: number | null;
}

// === Kernel ===

export interface KernelUpdateInfo {
  current: string;
  latest: string;
  needsUpdate: boolean;
  assets: GitHubAsset[];
  release: GitHubRelease;
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  prerelease: boolean;
  html_url: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

// === Overwrite ===

export interface ParsedOverrideKey {
  key: string;
  forceOverwrite: boolean;
  arrayPrepend: boolean;
  arrayAppend: boolean;
  arrayMergeByName: boolean;
}

/** 覆写文件作用域限定：所列条件需同时满足（AND），条件值为数组时其内部为 OR。 */
export interface OverwriteMatch {
  /** 按订阅名精确匹配 */
  subscription?: string | string[];
  /** 按订阅 URL 的 hostname 后缀匹配 */
  'url-domain'?: string | string[];
}

/** 构建配置时的订阅上下文，用于按 match 过滤覆写文件 */
export interface OverwriteScope {
  subName?: string;
  subUrl?: string;
}

export interface OverwriteListResult {
  enabled: boolean;
  dir: string;
  files: OverwriteFileInfo[];
}

// === Log ===

export interface LogEntry {
  name: string;
  path: string;
  size: number;
  mtime: Date;
  isCurrent: boolean;
}

export interface LogList {
  current: LogEntry | null;
  archives: LogEntry[];
}

// === Config Info (runtime) ===

export interface ConfigInfo {
  proxies: number;
  proxyGroups: number;
  mixedPort: number | null;
  httpPort: number | null;
  socksPort: number | null;
  tun: boolean;
}

// === Mirror ===

export interface MirrorArg {
  mirror: string | null;
  isOverride: boolean;
  /** 显式 `--mirror`（裸或带值）：把选择写入 settings.kernel_mirror */
  remember?: boolean;
  /** 显式 `--no-mirror`/`--direct`：清除已记住的镜像偏好 */
  clearSaved?: boolean;
}

// === Proxy connectivity probe ===

export interface ProxyProbeResult {
  ok: boolean;
  /** HTTP 状态码；curl 失败时为 null */
  statusCode: number | null;
  /** 失败原因（curl 错误/超时/非 2xx），成功为 null */
  error: string | null;
  durationMs: number;
}

/** 订阅缓存的紧急度：过期 / 流量用尽 / 即将到期（7 天内）/ 无 */
export type SubscriptionUrgency = 'expired' | 'traffic-exhausted' | 'expiring' | null;

// === Status (JSON 输出) ===

export interface StatusJson {
  version: string;
  running: boolean;
  /** 运行中且探测过连通性时有值；未运行或无端口信息为 null */
  connectivity: { ok: boolean; statusCode: number | null; error: string | null; durationMs: number } | null;
  mode: 'mixed' | 'tun' | null;
  carrier: 'service' | 'tun' | null;
  pid: number | null;
  kernel: string | null;
  kernelInstalled: boolean;
  ports: { mixed?: number; http?: number; socks?: number; tun?: boolean };
  subscription: {
    name: string;
    proxies: number;
    proxyGroups: number;
    upload?: number;
    download?: number;
    total?: number;
    expire?: number;
    /** 缓存里的上次更新时间（ISO）；缓存缺失则无此键 */
    updatedAt?: string;
    /** 已超过更新间隔未更新（与 doctor 订阅新鲜度同口径） */
    stale: boolean;
    urgency: Exclude<SubscriptionUrgency, null> | null;
  } | null;
  overwrite: { enabled: boolean; files: string[] };
  service: {
    installed: boolean;
    loaded: boolean;
    running: boolean;
    disabled: boolean;
    lastExitCode: number | null;
    legacySystemInstall: boolean;
  };
}

// === Reset ===

export interface ResetTarget {
  id: string;
  aliases: string[];
  label: string;
  paths: () => string[];
  needsStop: boolean;
  onAfter?: () => void | Promise<void>;
  checkEmpty?: () => boolean;
  emptyMsg?: string;
  warnIfRunning?: boolean;
}

// === Directory ===

export interface DirectoryTarget {
  path: string | null;
  label: string;
}

// === Parsed Subscription ===

export interface ParsedProxy {
  name: string;
  [k: string]: unknown;
}

export interface ParsedProxyGroup {
  name: string;
  proxies?: string[];
  [k: string]: unknown;
}

export interface ParsedSubscription {
  raw: Record<string, unknown>;
  proxies: ParsedProxy[];
  proxyGroups: ParsedProxyGroup[];
}

// === HTTP Client ===

export interface HttpClientOptions {
  timeout?: number;
}

export interface HttpResponse<T = string> {
  data: T;
  headers: Headers;
  status: number;
}

export interface HttpClient {
  get<T = string>(url: string, config?: { responseType?: 'text' | 'json'; signal?: AbortSignal }): Promise<HttpResponse<T>>;
}

// === Update Result ===

export interface AutoUpdateResult {
  total: number;
  updated: number;
  failed: number;
}

export interface TryUpdateResult {
  name: string;
  success: boolean;
  proxies?: number;
  proxyGroups?: number;
  error?: string;
}
