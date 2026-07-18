// === Settings ===

export interface Subscription {
  url: string;
  name: string;
}

export interface Settings {
  subscriptions?: Subscription[];
  active_subscription?: string;
  overwrite_enabled?: boolean;
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

export interface UserInfo {
  upload: number;
  download: number;
  total: number;
  expire: number;
  [key: string]: number;
}

// === Config Build ===

export interface BuildConfigResult {
  config: Record<string, unknown>;
  subscriptionConfig: Record<string, unknown>;
  overwriteFiles: OverwriteFileEntry[];
  systemConfig: Record<string, unknown>;
  warnings: string[];
}

export interface OverwriteFileEntry {
  name: string;
  path: string;
  config: Record<string, unknown>;
}

export interface OverwriteFileInfo {
  name: string;
  path: string;
  keys: string[];
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
  /** launchd 是否已装载该任务 */
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
  type: 'download' | 'all';
}

// === Reset ===

export interface ResetTarget {
  id: string;
  aliases: string[];
  label: string;
  paths: () => string[];
  needsStop: boolean;
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

// === Proxy Test ===

export interface ProxyTestResult {
  name: string;
  delay: number | null;
  error?: string;
}

export interface ProxyTestSummary {
  total: number;
  alive: number;
  dead: number;
  results: ProxyTestResult[];
}

// === HTTP Client ===

export interface HttpClientOptions {
  timeout?: number;
}

export interface HttpResponse {
  data: string;
  headers: Headers;
  status: number;
}

export interface HttpClient {
  get(url: string, config?: { responseType?: 'text' | 'json'; signal?: AbortSignal }): Promise<HttpResponse>;
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
