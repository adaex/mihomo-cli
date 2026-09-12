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
  warnings: string[];
  /**
   * 本次构建实际生效的覆写文件展示摘要（已按开关与 match 作用域筛选），
   * 形如 `overwrite.glados.yaml (url-domain=glados-config.com)`、`overwrite.seal.yaml (全局)`。
   * 仅供内核校验失败时附在错误里定位根因——`~key` 未命中同名元素会追加新元素，
   * 补丁落到不含该元素的订阅上就会造出缺必需字段的残缺项，而内核只报「哪个键坏了」，
   * 不会说「它是覆写加进来的」。存摘要而非 OverwriteFileEntry：错误路径只需展示，
   * 不该把整份覆写 config 拖进类型。
   */
  overwriteSummaries: string[];
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
  /**
   * 托管进程上次收到的致命信号，形如 `Killed: 9` / `Terminated: 15`；非信号死亡为 null。
   *
   * **与 lastExitCode 互斥**（实测 macOS 26.6）：被信号杀死时 launchd 只写这个字段，
   * `last exit code` 整行消失。少了它，OOM killer 或手工 kill 掉的内核对崩溃判据
   * 完全不可见——status 显示「不在运行」却无任何异常提示。
   */
  lastTerminatingSignal: string | null;
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
  /**
   * `~?key`：只改已有元素，按 name 匹配不到就**忽略该补丁**（`~key` 则追加）。
   * 用于「订阅下发了这个分组我才改它」——补丁往往只带 name + 一两个字段，
   * 被追加进去就是个缺 type 的残缺分组，内核直接拒绝加载整份配置。
   */
  arrayMergeOnly: boolean;
}

/** `~?key` 匹配不到同名元素而被跳过的补丁，供启动时告警 */
export interface SkippedMerge {
  /** 目标键，如 proxy-groups */
  key: string;
  /** 补丁的 name（无 name 时为占位串） */
  name: string;
  /** 来源覆写文件名，由 applyOverwrite 补上 */
  file?: string;
}

/**
 * 嵌套层形似 DSL 操作符、已按字面键名处理的键，供启动时告警。
 * 操作符只在覆写文件顶层生效；嵌套层的 `~x`/`x!`/`x+`/`<...>` 等形态大概率是
 * 把顶层语法写进了嵌套层（用户以为操作符会生效），记一条提示。`+.` 开头不记：
 * 那是 mihomo 原生通配域名的常见形态。
 */
export interface OperatorShapedKey {
  /** 原样键名（含操作符形态，如 "+rules"） */
  key: string;
  /** 来源覆写文件名，由 applyOverwrite 补上 */
  file?: string;
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
  tun: boolean;
}

// === Mirror ===

export interface MirrorArg {
  /** 镜像 URL；null = 直连（显式 --mirror direct 或未指定） */
  mirror: string | null;
  /** 是否显式传了 --mirror（含 bare/direct） */
  isOverride: boolean;
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
  ports: { mixed?: number; tun?: boolean };
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
    lastTerminatingSignal: string | null;
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
  preserveOnBare?: boolean;
}

// === Directory ===

export interface DirectoryTarget {
  path: string | null;
  label: string;
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
