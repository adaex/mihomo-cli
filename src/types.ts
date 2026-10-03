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
   * 仅供内核校验失败时附在错误里定位根因——覆写追加的元素缺必需字段时内核只报
   * 「哪个键坏了」，不会说「它是覆写加进来的」。存摘要而非 OverwriteFileEntry：
   * 错误路径只需展示，不该把整份覆写 config 拖进类型。
   */
  overwriteSummaries: string[];
  /**
   * 各 JS 脚本的命中判定（return true = 命中当前订阅）。与 overwriteSummaries
   * 不同，**包含未命中的脚本**——status 的生效提示要能指出「脚本对当前订阅
   * 提前退出」，只列命中的看不出谁缺席。YAML 文件的命中走 match 静态判定，
   * 不在此列（listOverwriteFile 的 matched 字段）。
   */
  scriptMatches: ScriptMatch[];
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
  /** YAML 覆写文件的合并内容（match/enabled 元数据键已剥离）；脚本文件无此字段 */
  config?: Record<string, unknown>;
  /** JS 覆写脚本的默认导出函数；YAML 文件无此字段。两类文件二选一 */
  transform?: OverwriteTransform;
  match?: OverwriteMatch;
  /** 文件内 `enabled:` 元数据键的规整值；缺省即 true。false 表示不参与合并（仅 YAML 文件有意义） */
  enabled?: boolean;
}

/**
 * JS 覆写脚本的变换函数：**就地修改**传入的 config。返回值约定：`return true`
 * 表示命中当前订阅（脚本没有 match 声明，status 靠它区分生效与不适用），
 * 其余返回值（含无返回值）一律视为未命中、不影响合并。必须同步——
 * 返回 Promise 报错（buildConfig 是同步管线，纯转换也没有要等网络的场景）。
 * 全信任模型：脚本以当前用户身份运行（同 .zshrc），不沙箱、不超时；
 * 但它改不动系统锁定项——脚本执行后 LOCKED_CONFIG_KEYS 照常剥除（见 buildConfig）
 */
export type OverwriteTransform = (config: Record<string, unknown>, ctx: OverwriteScriptContext) => void | true;

/** 传给覆写脚本的上下文 */
export interface OverwriteScriptContext {
  /**
   * 当前订阅（与 match 同源的信息）。host 是预解析的 URL hostname（解析失败为空串），
   * 脚本要按域名限定作用域时用它，不必自己 try URL
   */
  subscription: { name: string; url: string; host: string };
  /** 本次构建的运行模式 */
  mode: RuntimeMode;
  /** 发一条告警进 warnings 通道（`start` / `config` / `doctor` 的输出可见；`status` 判定脚本命中时会执行它，但不显示 warn 的内容） */
  warn: (message: string) => void;
}

/** 加载失败（YAML 语法错/元数据键非法等）的覆写文件：诊断面要带着错误列出它 */
export interface BrokenOverwriteFile {
  name: string;
  /** 单行失败原因 */
  message: string;
  /** 错误标签（如「覆写配置错误」），合并路径硬失败时重建 CliError 用 */
  label: string;
  /** 完整排查提示（含别名加引号这类定向指引） */
  hint: string[];
}

export interface OverwriteFileInfo {
  name: string;
  /** yaml = 声明式覆写（有 keys/作用域）；script = JS 脚本（无这两样，字段行显示占位） */
  kind: 'yaml' | 'script';
  keys: string[];
  scope?: string;
  /** 该文件自身是否启用（文件内 `enabled` 键）；与 OverwriteListResult.enabled 的全局开关是两层 */
  enabled: boolean;
  /**
   * match 是否命中调用方给的作用域；**仅在 listOverwriteFile 传了 scope 时存在**。
   * undefined = 未判定（`ow` 列表不绑定某条订阅，判不了），不等于「没命中」。
   * 展示用，别拿它当合并闸门——那只有 selectActiveOverwriteFiles
   */
  matched?: boolean;
}

/** 运行模式：Mixed 由 launchd 服务托管，TUN 是按需 sudo 的临时进程 */
export type RuntimeMode = 'mixed' | 'tun';

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

export interface StopResult {
  /** 死亡等待与复核后仍在的主实例 PID；缺省 = 已停干净 */
  remaining?: number[];
}

export interface CleanupResult {
  killed: number;
  /** 用户态逐个 kill 的失败数（root 路径与批量 pkill 不产出逐项失败） */
  failed: number;
  /** 死亡等待与复核后仍在的主实例 PID */
  remaining: number[];
  /**
   * root 清理 sudo 脚本（只 pkill，不删 pid 文件）的提权/脚本错误。SudoAuthError =
   * 取消或密码错误（调用方按「已取消」包装），其余为脚本失败；null = 未提权或成功。
   * remaining 为空但本字段非空 = 进程在死亡等待内自行退光、清理未走完——归因是
   * 「清理未完成」而非 pid 文件残留（那是 pidError 的事），两者不许再混用
   */
  scriptError: Error | null;
  /**
   * pid 文件删除（免提权 unlink，见 clearPid）的失败。null = 无文件、已清或清理成功；
   * scriptError 非空时本字段反映的是 clearPid 照常执行的结果（免提权、无交互代价，
   * 没有理由跳过）——不设「错误优先级」，两个字段各自如实带出
   */
  pidError: Error | null;
}

export interface StaleState {
  needsCleanup: boolean;
  allPids: number[];
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
  /**
   * 首选 gh 认证查询失败后回退直连成功（命令层据此补一行灰字：spinner 说的
   * 「gh 认证通道」与实际响应来源不一致时，用户需要能核对）
   */
  ghFallbackToDirect?: boolean;
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

/** 覆写文件作用域限定：所列条件需同时满足（AND），条件值为数组时其内部为 OR。 */
export interface OverwriteMatch {
  /**
   * 按订阅名匹配，大小写不敏感（与 `sub use` 的解析口径一致）。三种形态：
   * 精确值、尾部单个 `*`（前缀，如 `edu*`）、头部单个 `*`（后缀，如 `*edu`）；
   * 其余通配形态（多 `*`、中间 `*`、`?`）在加载时报错——通用匹配器已删，
   * 更复杂的匹配写 JS 脚本（见 OverwriteTransform）
   *
   * 类型恒为数组：YAML 里的裸 string 形态在 normalizeMatch 归一，消费方不再各自防御
   */
  name?: string[];
  /** 按订阅 URL 的 hostname 后缀匹配（字面比对，无通配） */
  'url-domain'?: string[];
}

/** 构建配置时的订阅上下文，用于按 match 过滤覆写文件 */
export interface OverwriteScope {
  subName?: string;
  subUrl?: string;
}

/**
 * JS 覆写脚本的命中判定：脚本没有 YAML 的 match 声明，改由变换函数的返回值报告
 * ——`return true` 即命中当前订阅（matched），其余返回值（含提前退出的 undefined）
 * 一律视为未命中。合并本身不受影响，判定只供 status/config 的生效提示。
 */
export interface ScriptMatch {
  file: string;
  matched: boolean;
}

export interface OverwriteListResult {
  enabled: boolean;
  dir: string;
  files: OverwriteFileInfo[];
  /**
   * 加载成功的完整条目（含 transform/config），与 files 同一次读目录的产出：
   * status 喂 judgeScriptMatches 判脚本命中，复用它避免二次扫目录（typo 警告与
   * YAML 解析不跑两遍）。ow 列表不消费。不进 status --json（序列化的是 files）
   */
  entries: OverwriteFileEntry[];
  /** 加载失败的文件（语法错/元数据键非法）；诊断面据此红字列出，合并路径会硬失败 */
  broken: BrokenOverwriteFile[];
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

export interface ProxyArg {
  /** 规范化后的 curl -x 代理地址（如 http://127.0.0.1:7897）；null = 未指定 --proxy */
  proxy: string | null;
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
  mode: RuntimeMode | null;
  carrier: 'service' | 'tun' | null;
  pid: number | null;
  kernel: string | null;
  kernelInstalled: boolean;
  ports: { mixed?: number; controller?: number; tun?: boolean };
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
  /**
   * `enabled` 是全局开关（settings.overwrite_enabled）。
   *
   * `files` 是目录里未被 `enabled: false` 停用的覆写文件名——**不等于本次生效的清单**，
   * 它不按 match 作用域过滤、也不随全局开关变空（旧契约，保持不变）。
   *
   * `applied` 是本次真正参与合并的文件，三道过滤与 buildConfig 一致：全局开关关闭时
   * 恒为空数组（那时 buildConfig 压根不加载覆写），再滤掉文件级 `enabled: false`，
   * 最后按当前活跃订阅的 match 过滤。无活跃订阅时判不了 match，不额外收窄
   */
  overwrite: {
    enabled: boolean;
    files: string[];
    applied: string[];
    /** hint 是可执行的迁移/修复指引（如已移除操作符的改写示例），诊断界面与 JSON 都必须带出 */
    errors: { name: string; message: string; hint: string[] }[];
  };
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

export interface TryUpdateResult {
  name: string;
  success: boolean;
  proxies?: number;
  proxyGroups?: number;
  error?: string;
  /**
   * 因本次自动更新整体超时被中止（abort），既不是成功也不是真实失败：
   * 调用方按「跳过、使用缓存」渲染，不计入 failed（start 用缓存启动是正常降级）
   */
  aborted?: boolean;
}
