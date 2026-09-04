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
  ssh?: SshConfig[];
}

// === ssh 隧道 (ssh -D 动态转发) ===

export interface SshConfig {
  name: string;
  /** ssh 目标主机（别名或 user@host）；恒不以 `-` 开头，见 ssh.ts 的校验 */
  host: string;
  /** 本地 SOCKS5 监听端口，恒绑 127.0.0.1 */
  port: number;
  /** true 时 `mihomo start` 顺带拉起、`mihomo stop` 连带停止 */
  auto: boolean;
}

/**
 * 隧道运行态。存 `<USER_DATA_DIR>/ssh/<name>.json`，**不能放 DIRS.runtime**——
 * process-stop.ts 的 clearRuntime() 会在 stop() 成功路径 rmrf 整个 runtime 目录。
 */
export interface SshRuntime {
  pid: number;
  /** 谁起的：auto = start 顺带拉起（stop 可连带停），manual = 用户显式 ssh up（stop 不碰） */
  started_by: 'auto' | 'manual';
  started_at: string;
  /** 起进程时用的端口，用于校验状态文件与当前配置是否已漂移 */
  port: number;
}

/** 三态运行状况：进程在但端口不通即「假活」，正是 ExitOnForwardFailure 要防的形态 */
export type SshState = 'running' | 'dead-port' | 'stopped';

export interface SshStatus {
  config: SshConfig;
  state: SshState;
  pid: number | null;
  started_by: 'auto' | 'manual' | null;
  started_at: string | null;
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
  allProcesses: number[];
  hasStaleProcesses: boolean;
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
  alreadyRunning?: boolean;
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

// === Daemon (launchd 保活) ===

export interface DaemonStatus {
  /** plist 文件是否存在（即用户是否启用过保活） */
  enabled: boolean;
  /** 托管内核是否在运行（免 sudo 近似：root 属主主实例进程存在；非 launchctl 真实装载状态） */
  loaded: boolean;
  /** 被 launchd 托管的内核进程 PID（未运行为 null） */
  pid: number | null;
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
  mode: string;
  mixedPort: number | null;
  httpPort: number | null;
  socksPort: number | null;
  tun: boolean;
}

// === Mirror ===

export interface MirrorArg {
  mirror: string | null;
  isOverride: boolean;
}

// === Reset ===

export interface ResetTarget {
  id: string;
  aliases: string[];
  label: string;
  paths: () => string[];
  needsStop: boolean;
  /** 在删除 paths 之前执行。用于「删掉文件就再也做不成」的清理（如隧道要先读 pid 文件才能停进程） */
  onBefore?: () => void;
  onAfter?: () => void;
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
  /** external-controller 访问密钥；设置后所有请求带 Authorization: Bearer <secret> */
  secret?: string;
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
