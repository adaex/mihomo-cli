import { createRequire } from 'node:module';
import { CliError } from './errors.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/**
 * YAML 别名上限（防 billion-laughs 类 DoS）。config.ts 与 overwrite.ts 的两处
 * yaml.load 共用同一常量，改一处忘另一处会让两条解析路径的防护漂移。
 */
export const YAML_MAX_ALIASES = 200;

/** CLI 自身版本与包名（package.json 单一来源；http UA、version/update 命令共用） */
export const VERSION: string = pkg.version;
export const PKG_NAME: string = pkg.name;

/**
 * 支持的最低 Node 版本，取自 package.json 的 `engines.node`（单一来源，不另写一份常量）。
 *
 * 只剥掉 `>=` 前缀：本仓的 engines 一直是 `>=x.y.z` 这一种形态，不实现完整的 semver
 * range 解析——真要改成复杂 range，运行时守卫也该跟着改，而不是在这里猜。
 * 解析不出版本号时返回 null，守卫据此跳过检查（宁可不拦，也不能因为 engines 写法变了
 * 就把所有命令挡死）。
 */
export const MIN_NODE_VERSION: string | null = (() => {
  const raw: unknown = pkg.engines?.node;
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^>=\s*(\d+\.\d+\.\d+)$/);
  return m ? m[1] : null;
})();

/**
 * 镜像的**单一真相源**：短别名 → 完整地址。`--mirror <别名>` 经 `MIRROR_ALIASES` 展开，
 * 帮助文案里的「可用镜像」由 `AVAILABLE_MIRRORS` 从本表派生。
 *
 * 展示清单 `AVAILABLE_MIRRORS` 也从本表派生，增删镜像只需改这里：
 * 漏改别名表是别名直接不认，漏改展示清单至多是帮助文案过期。
 *
 * `bare` 是不带子域的裸域，是裸 `--mirror`（不给值）时的默认选择；
 * 它不作为短别名（用户写 `--mirror gh-proxy.org` 走裸主机名补 https 的通路即可）。
 */
export const MIRROR_HOST = 'gh-proxy.org';

/** --mirror <短别名> 映射：cdn/v4/v6/axisnow → 完整镜像地址 */
export const MIRROR_ALIASES: Record<string, string> = {
  v4: `https://v4.${MIRROR_HOST}/`,
  v6: `https://v6.${MIRROR_HOST}/`,
  cdn: `https://cdn.${MIRROR_HOST}/`,
  axisnow: `https://axisnow.${MIRROR_HOST}/`,
};

/** 裸域镜像（无子域）：裸 `--mirror` 不给值时的默认选择 */
export const MIRROR_BARE = `https://${MIRROR_HOST}/`;

/**
 * 可用镜像的展示清单（帮助/错误提示用），从 MIRROR_ALIASES 派生。
 * 裸域排最前，与裸 `--mirror` 的默认选择一致。
 */
export const AVAILABLE_MIRRORS: string[] = [MIRROR_HOST, ...Object.values(MIRROR_ALIASES).map(url => new URL(url).hostname)];

export const UI_URLS: Record<string, string> = {
  zash: 'https://board.zash.run.place',
  dash: 'https://metacubex.github.io/metacubexd',
  yacd: 'https://yacd.metacubex.one',
};

/**
 * launchd 服务的标签（同时用作 plist 文件名：用户级在 ~/Library/LaunchAgents/，
 * 系统级在 /Library/LaunchDaemons/）。
 * 可用 MIHOMO_CLI_DAEMON_LABEL 覆盖，供隔离测试使用一次性 label，避免碰生产 plist 文件名。
 *
 * 非法值在此静默回退到默认标签，另由本文件的 assertServiceLabelSafe()
 * （launchctl 写操作与 root 清理脚本的入口校验）抛出可读错误——不能在模块顶层抛：constants 在 import 阶段求值，早于 index.ts 的
 * main().catch 注册，抛出会直接打印堆栈而绕过统一收口。
 *
 * **值与环境变量名都保持 `daemon` 字样不变**：改了值会让老用户 v4.0 及更早装的
 * /Library/LaunchDaemons/com.mihomo-cli.daemon.plist 变成新 CLI 看不见的幽灵，而它带
 * KeepAlive 会持续拉起内核，用户没有任何途径卸载它。保持不变则遗留系统级安装天然
 * 可被识别与清理（D1）。
 */
export const DEFAULT_SERVICE_LABEL = 'com.mihomo-cli.daemon';

/**
 * 合法 label 字符集。必须校验：该值经 path.join 拼成 plist 路径后，是系统级安装时
 * `sudo install -m 644 -o root -g wheel` 的写入目标与 `sudo rm -f` 的删除目标。
 * path.join 会折叠 `..`（`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`），
 * 未校验时可借此以 root 身份写入/删除任意路径，内容还部分可控 → 提权原语。
 * 同时该值也拼进 launchctl 的服务目标（`gui/<uid>/<label>` 或 `system/<label>`）。
 */
const SERVICE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidServiceLabel(label: string): boolean {
  return SERVICE_LABEL_RE.test(label) && !label.includes('..');
}

const RAW_SERVICE_LABEL = process.env.MIHOMO_CLI_DAEMON_LABEL;
/** 环境变量提供的原始 label（可能非法），仅在下方校验与报错时引用 */
const RAW_SERVICE_LABEL_INPUT: string | undefined = RAW_SERVICE_LABEL;
export const SERVICE_LABEL: string = RAW_SERVICE_LABEL && isValidServiceLabel(RAW_SERVICE_LABEL) ? RAW_SERVICE_LABEL : DEFAULT_SERVICE_LABEL;

/** 服务二进制符号链名。见 paths.ts 的 serviceBinary 与 service.ts 的 ensureServiceSymlink。 */
export const SERVICE_BINARY_NAME = 'mihomo-cli-service';

/**
 * 默认混合端口（HTTP + SOCKS5）与 external-controller 端口。
 * 系统强制、不受订阅/覆写影响：端口是 UI 与热重载的统一依赖地址。
 * 可在 settings.json 的 `ports` 里覆盖（见 settings.ts 的 getPorts）——
 * 供默认端口被其他代理工具占用的场景逃生，不是给订阅/覆写的配置面。
 */
export const DEFAULT_MIXED_PORT = 7890;
export const CONTROLLER_PORT = 9090;

/**
 * 端口合法性的唯一谓词：number、整数、1–65535。settings 校验、入口守卫的自代理
 * 判定、--proxy 裸端口归一三处共用——端口范围口径变化只改这里（报错文案各调用方自管）
 */
export function isValidPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export const TUN_CONFIG = {
  tun: {
    enable: true,
    stack: 'mixed',
    'dns-hijack': ['any:53', 'tcp://any:53'],
    'auto-route': true,
    'auto-detect-interface': true,
    'strict-route': true,
  },
};

/**
 * 系统锁定的入站/控制面键：只允许来自 settings 或系统约束，订阅与覆写（YAML 与
 * JS 脚本 alike）显式提供时一律剥除（buildConfig）。判据与「刻意不锁」的清单见
 * docs/decisions.md D5——新增入站/控制器键时按同一判据核对（上游 `config.Inbound`
 * 字段全集 + `hub/executor.updateListeners()` 的逐个消费，不是按键名眼熟程度），
 * 并把不在表内的键的理由写进 config-inbound-snapshot.spec 的 NOT_IN_LOCKED_TABLE。
 *
 * 物理上住在本表而非 config.ts：overwrite.ts 的脚本执行要拿它做前后快照告警
 * （脚本设置的锁定键剥除时提示，不静默），而 config.ts import overwrite.ts，
 * 反向 import 会循环依赖。
 */
export const LOCKED_CONFIG_KEYS = [
  'mixed-port',
  'port',
  'socks-port',
  'redir-port',
  'tproxy-port',
  'external-controller',
  'external-controller-tls',
  'external-controller-unix',
  'external-controller-pipe',
  'external-controller-cors',
  'external-controller-routing-mark',
  'external-doh-server',
  'external-ui',
  'external-ui-name',
  'external-ui-url',
  'secret',
  // 完整入站代理服务端（监听 + 认证 + 自带证书字段）：订阅借此可把本机变成开放代理，
  // 比 redir/tproxy 严重得多，与「入站由 mixed/tun 托管」的产品边界直接冲突
  'tuic-server',
  // 同族的另外两个入站服务端，只是形态是一行 URL 而非映射，更易被忽略：
  // 上游 ParseSSURL/ParseVmessURL 直接把 URL 的 host 当 Listen，New() 再对
  // `strings.Split(Listen, ",")` 逐个 bind——**不经过 genAddr**，故 allow-lan 与
  // bind-address 都管不到它们（那两个只作用于 HTTP/Socks/Redir/TProxy/Mixed）。
  // 即订阅里一行 `ss-config: ss://aes-128-gcm:pass@0.0.0.0:8388` 就是全网卡开放代理
  'ss-config',
  'vmess-config',
  // 通用入站声明：`listeners` 每个元素自带 type + listen，一条
  // `{type: socks, listen: 0.0.0.0, port: 18080}` 即在全网卡开出无鉴权 SOCKS 入站；
  // `tunnels` 声明本地端口到目标地址的直通转发，同样自带监听地址。两者与上面三个
  // 入站服务端满足完全相同的判据（订阅可指定监听地址、不经 genAddr、allow-lan 管不到），
  // 只因在上游是 RawConfig 顶层字段而非 Inbound 结构体成员而容易被漏看。
  // 需要额外入站的用户改由本机另起实例，不接受远端订阅投递
  'listeners',
  'tunnels',
  // 局域网暴露与入站鉴权：实测链条（v1.19.30）：
  // - `listener.genAddr(host, port, allowLan)` 在 allowLan 为真、bind-address 为默认
  //   `"*"` 时返回 `":%d"`，即**全网卡监听**——订阅一行 `allow-lan: true` 就把 Mixed
  //   端口挪出回环；bind-address 则直接指定监听地址
  // - `authentication` 是这种情况下唯一的补偿防线，而 `skip-auth-prefixes` 能把它废掉：
  //   `listener/http/server.go` 的 accept 循环里
  //   `if inbound.SkipAuthRemoteAddr(conn.RemoteAddr()) { store = authStore.Nil }`，
  //   `0.0.0.0/0` 命中所有来源，鉴权 store 被换成空实现
  // 即远端订阅三行 YAML = 全网卡无鉴权开放代理。lan-allowed-ips/lan-disallowed-ips
  // 同属这套来源准入判定，一并锁死；bind-address 单看无害（allow-lan 为假时 genAddr
  // 根本不读它），锁它是为了消除「两个键配合才危险」这种要跨键推理的组合。
  //
  // allow-lan 恒为 false 由 config.ts 的 systemConfig 写入（**不在 BASE_CONFIG**，
  // 理由同 mixed-port：锁定项是「恒定此值」，不是「用户没写时的默认」）。剥除来源盲，
  // 故覆写也不能再给 Mixed 端口设 authentication——缓解是 allow-lan 已强制 false、
  // Mixed 只在回环，残余威胁面是同机其他进程（见 CONCLUSIONS）
  'allow-lan',
  'bind-address',
  'authentication',
  'skip-auth-prefixes',
  'lan-allowed-ips',
  'lan-disallowed-ips',
] as const;

/**
 * 剥除执行集：快照表 LOCKED_CONFIG_KEYS + 顶层 `tls` 段。tls 不是上游
 * `config.Inbound` 的结构体字段（故不进快照表，D5），但它是
 * external-controller-tls 证书/私钥的唯一来源、属控制面，剥除与告警对它一视同仁。
 * 这是「实际不会进入运行配置的键」的唯一清单：YAML 扫描、剥除循环、脚本快照探针
 * 与 config-inbound-snapshot.spec 全部派生自此——新增「表外但同剥除」的段只改这里
 */
export const EFFECTIVELY_LOCKED_KEYS: readonly string[] = [...LOCKED_CONFIG_KEYS, 'tls'];

export const BASE_CONFIG: Record<string, unknown> = {
  // 注意：mixed-port、external-controller 与 allow-lan 不在此表——前两个来自
  // settings.ports（getPorts），allow-lan 恒为 false，三者都由 config.ts 单独写入
  // systemConfig，订阅/覆写恒不可改。本表的语义是「用户没写时的默认」（可被覆盖），
  // 锁定项的语义是「恒定此值」，两者不能混在一张表里
  'unified-delay': true,
  'tcp-concurrent': true,
  'geo-auto-update': true,
  'geo-update-interval': 24,
  'geodata-mode': true,
  'log-level': 'warning',
  profile: {
    'store-selected': true,
  },
  'geox-url': {
    geoip: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip-lite.dat',
    geosite: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite-lite.dat',
    mmdb: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country-lite.mmdb',
    asn: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb',
  },
};

// === 订阅更新默认值 ===

/** 默认更新间隔（小时）：国内直连 GitHub 更难，更频繁的更新只会产生撞墙失败噪音 */
export const DEFAULT_UPDATE_INTERVAL_HOURS = 12;
/** 启动时自动更新订阅的默认超时（毫秒），超时后使用缓存配置 */
export const DEFAULT_AUTO_UPDATE_TIMEOUT = 10_000;

/** 校验 MIHOMO_CLI_DAEMON_LABEL：该值经 path.join 折叠 `..` 后会成为 root 清理路径
 * （`../../etc/sudoers.d/evil` → `/etc/sudoers.d/evil.plist`），不校验即提权原语。
 * constants 已把非法值回退为默认标签，此处在执行写/删前拒绝并告知用户。 */
export function assertServiceLabelSafe(): void {
  if (RAW_SERVICE_LABEL_INPUT !== undefined && !isValidServiceLabel(RAW_SERVICE_LABEL_INPUT)) {
    throw new CliError(`MIHOMO_CLI_DAEMON_LABEL 无效: "${RAW_SERVICE_LABEL_INPUT}"`, {
      label: '配置错误',
      hint: ['只允许字母、数字、点、下划线、短横线，且不能含 ".."。', '该值会成为 launchd plist 的文件名，并参与清理遗留安装时的 root 删除路径。'],
    });
  }
}
