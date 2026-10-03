import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import * as yaml from 'js-yaml';
import { BASE_CONFIG, EFFECTIVELY_LOCKED_KEYS, TUN_CONFIG, YAML_MAX_ALIASES } from './constants.js';
import { CliError } from './errors.js';
import { applyOverwrite, describeOverwriteScope, loadOverwriteFile, lockedKeysReferencedBy, selectActiveOverwriteFiles } from './overwrite.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS } from './paths.js';
import { getPorts, readSettings } from './settings.js';
import { sanitizeTerminal } from './text.js';
import type { BuildConfigResult, ConfigInfo, OverwriteFileEntry, OverwriteScope, RuntimeMode, ScriptMatch } from './types.js';

/**
 * 安全 YAML 解析选项:限制别名展开次数,防御远程订阅/覆写里的 YAML 别名炸弹(alias bomb)DoS。
 * js-yaml 5 默认 maxAliases=-1(无限制),恶意配置可借指数级别名膨胀撑爆内存/CPU。
 * 所有解析不可信来源(订阅、覆写、运行时配置)的 yaml.load 都应带上此选项。
 */
const SAFE_YAML_LOAD_OPTIONS: yaml.LoadOptions = { maxAliases: YAML_MAX_ALIASES };

/** 统一入口:带别名上限的 yaml.load,替代裸 yaml.load。 */
function loadYamlSafe(content: string): unknown {
  return yaml.load(content, SAFE_YAML_LOAD_OPTIONS);
}

/**
 * 解析配置内容（订阅 YAML 或 JSON）为顶层映射。**只走 YAML 解析器，不设独立 JSON 分支**
 * （论证见 docs/decisions.md D6）：重复键 JSON 是 YAML 明确报错、JSON.parse 静默取最后
 * 一个值，回退 JSON 分支会把「坏数据」变成「静默接受」。
 * 只接受对象：标量/数组不是合法配置（`proxies` 等段都挂在顶层映射下）。
 */
export function parseConfigContent(content: string, errorMsg?: string): Record<string, unknown> {
  const label = errorMsg || '内容';
  if (!content?.trim()) {
    throw new CliError(`${label}为空`, { label: '配置错误' });
  }

  let result: unknown;
  try {
    result = loadYamlSafe(content);
  } catch (e) {
    // YAML 的报错含行列号，对定位笔误很有用，原样带出（首行即可，堆栈无意义）。
    // CliError 而非裸 Error：config 命令直接消费本函数，裸 Error 会按「未预期错误」
    // 渲染完整堆栈——预期错误（订阅内容坏）被当成程序 bug 呈现
    throw new CliError(`${label}格式错误，无法解析: ${(e as Error).message.split('\n')[0]}`, { label: '配置错误' });
  }

  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    throw new CliError(`${label}不是有效的配置对象（顶层需为映射，当前是${Array.isArray(result) ? '列表' : typeof result}）`, { label: '配置错误' });
  }
  return result as Record<string, unknown>;
}

/**
 * 统一的 YAML 序列化选项:2 空格缩进、不折行。
 * 用默认 DUMP_SCHEMA(不显式指定 schema):对歧义标量(on/off/yes/no/y/n/true/null 等)加引号——
 * 节点名/分组名的值可能恰好是 `on`/`off`，裸输出 `name: on` 在 mihomo 下虽仍读作字符串,
 * 但流经 PyYAML 等 YAML 1.1 工具会被误解析成布尔 true,造成静默的配置损坏。
 * 加引号后在 1.1/1.2 解析器下含义唯一。
 */
export function dumpYaml(obj: unknown): string {
  return yaml.dump(obj, { indent: 2, lineWidth: -1 });
}

/**
 * 校验 dns 段是映射。非映射（`dns: true`、`dns: [...]`）会让下游的
 * `'enable' in subDns` / 展开运算符抛裸 TypeError 或静默产出垃圾配置。
 * TUN 分支在读 `dns.enable` 前先调（早于合并，报错指向订阅原值），
 * mixed 路径由 `assertConfigShape` 兜底——两条路径都要走到这里。
 */
function assertDnsShape(dnsRaw: unknown): void {
  if (dnsRaw === undefined || dnsRaw === null) return;
  if (typeof dnsRaw !== 'object' || Array.isArray(dnsRaw)) {
    throw new CliError(`dns 配置必须是映射，当前是${Array.isArray(dnsRaw) ? '数组' : `标量（${typeof dnsRaw}）`}`, {
      label: '配置错误',
      hint: ['dns 是订阅/覆写里的对象配置块（enable、nameserver 等），不支持标量或数组。'],
    });
  }
}

/**
 * 校验顶层配置段的形态，把 YAML 笔误转成可读的 CliError。
 * 避免后续读取字段时抛 TypeError，被 main().catch 当成程序 bug 打印堆栈
 * （典型：`rules: MATCH,DIRECT` 漏写 `-`；列表里留了空项产生 null 元素）。
 */
export function assertConfigShape(config: Record<string, unknown>): void {
  assertDnsShape(config.dns);

  const listSections: { key: string; label: string; needsName: boolean }[] = [
    { key: 'proxies', label: '节点', needsName: true },
    { key: 'proxy-groups', label: '代理组', needsName: true },
    { key: 'rules', label: '规则', needsName: false },
  ];

  for (const { key, label, needsName } of listSections) {
    const value = config[key];
    if (value === undefined || value === null) continue;

    if (!Array.isArray(value)) {
      throw new CliError(`${key} 必须是列表，当前为 ${typeof value === 'object' ? '映射' : typeof value}`, {
        label: '配置错误',
        hint: [
          `${label}段（${key}）需写成 YAML 列表，每项以 "- " 开头。`,
          `例如: ${key}:`,
          key === 'rules' ? '        - MATCH,DIRECT' : '        - {name: xxx, ...}',
        ],
      });
    }

    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (item === null || item === undefined) {
        throw new CliError(`${key}[${i}] 为空`, {
          label: '配置错误',
          hint: [`${label}段（${key}）第 ${i + 1} 项是空值，通常是列表里留了空的 "- " 行。`],
        });
      }
      if (needsName) {
        if (typeof item !== 'object' || Array.isArray(item)) {
          throw new CliError(`${key}[${i}] 必须是映射`, {
            label: '配置错误',
            hint: [`${label}段（${key}）第 ${i + 1} 项应为 {name: ..., ...} 形式，当前是 ${Array.isArray(item) ? '列表' : typeof item}。`],
          });
        }
        const name = (item as Record<string, unknown>).name;
        if (typeof name !== 'string' || name === '') {
          throw new CliError(`${key}[${i}] 缺少有效的 name`, {
            label: '配置错误',
            hint: [`${label}段（${key}）第 ${i + 1} 项没有 name 字段（或为空），mihomo-cli 会拒绝启动。`],
          });
        }
      } else if (typeof item !== 'string') {
        throw new CliError(`${key}[${i}] 必须是字符串`, {
          label: '配置错误',
          hint: [`${label}段（${key}）第 ${i + 1} 项应为形如 "MATCH,DIRECT" 的字符串，当前是 ${typeof item}。`],
        });
      }
    }
  }
}

export function buildConfig(subRawContent: string, mode: RuntimeMode, scope?: OverwriteScope): BuildConfigResult {
  const subscriptionConfig = parseConfigContent(subRawContent, '订阅内容');

  const settings = readSettings();
  const allFiles = settings.overwrite_enabled !== false ? loadOverwriteFile() : [];
  const overwriteFiles = selectActiveOverwriteFiles(allFiles, scope);
  // 脚本执行需要 mode/scope 构造 ctx（订阅信息与运行模式），YAML 合并不用
  const {
    config: withOverwrites,
    scriptWarnings,
    scriptLockedHits,
    scriptMatches,
  } = applyOverwrite(subscriptionConfig, overwriteFiles, {
    mode,
    scope,
  });
  const overwriteSummaries = overwriteFiles.map(describeOverwriteScope);

  const systemConfig: Record<string, unknown> = {};
  // 系统约束覆盖显式设置时告警，节点与分流规则保持用户给出的内容
  // 未命中脚本不进 warnings：按订阅分歧行为是脚本设计内的常态，不是告警——
  // 可见性由 status/ow 的「不适用」清单承担（走 scriptMatches，与本数组无关）
  const lockedWarnings: string[] = [...scriptWarnings];
  // 脚本设置的锁定键与 YAML 覆写同款告警（剥除对脚本输出一视同仁，但不静默——
  // 脚本作者会困惑「设置了怎么没生效」）
  for (const hit of scriptLockedHits) {
    lockedWarnings.push(renderLockedWarning(`覆写脚本 ${hit.file} 中的`, hit.keys));
  }
  for (const [key, value] of Object.entries(BASE_CONFIG)) {
    if (!(key in withOverwrites)) {
      systemConfig[key] = value;
    }
  }

  // 系统锁定项：入站端口与整个控制面只能来自 settings 与系统约束，订阅/覆写（远端不可信
  // 内容）显式设置时一律剥除；告警只对**生效的覆写文件**——机场订阅几乎必带 mixed-port/port
  // 等端口段，系统约束接管订阅入站是核心设计、用户没有行动手段，逐条告警只会刷屏；亲手写
  // 覆写文件/脚本的高级用户才会以为这些键生效，提示才有意义。扫描（含操作符形式与表外
  // tls）与剥除共用同一执行集 EFFECTIVELY_LOCKED_KEYS，判据见 D5。脚本文件无 config
  // 键，它的锁定键命中在 applyOverwrite 里经前后快照检出（脚本LockedHits）
  for (const file of overwriteFiles) {
    const hit = lockedKeysReferencedBy(Object.keys(file.config ?? {}));
    if (hit.length > 0) {
      lockedWarnings.push(renderLockedWarning(`覆写文件 ${file.name} 中的`, hit));
    }
  }
  for (const key of EFFECTIVELY_LOCKED_KEYS) {
    delete withOverwrites[key];
  }

  const ports = getPorts(settings);
  systemConfig['external-controller'] = `127.0.0.1:${ports.controller}`;
  systemConfig['mixed-port'] = ports.mixed;
  // 与端口同族的恒定值：入站只监听回环。写在这里而非 BASE_CONFIG，因为它是锁定项
  // （恒定此值）而不是默认值（用户没写时才用）——留在 BASE_CONFIG 的话，订阅提供
  // allow-lan 时填充循环会因 `key in withOverwrites` 跳过默认、随后被剥除循环删掉，
  // 终态里这个键会整个消失
  systemConfig['allow-lan'] = false;
  const controllerSecret = settings.controller_secret;
  if (controllerSecret !== undefined) {
    // 与 getPorts 同族：非字符串在唯一消费点明确报错（fail-closed），
    // 脱敏出口也据此可依赖字符串类型
    if (typeof controllerSecret !== 'string') {
      throw new CliError('settings.json 的 controller_secret 需为字符串', {
        label: '配置错误',
        hint: ['示例: "controller_secret": "your-secret"', '删除该键则不设置访问密钥'],
      });
    }
    if (controllerSecret) {
      systemConfig.secret = controllerSecret;
    }
  }

  if (mode === 'tun') {
    systemConfig.tun = TUN_CONFIG.tun;
    assertDnsShape(withOverwrites.dns);
    const subDns = (withOverwrites.dns || {}) as Record<string, unknown>;
    const dns: Record<string, unknown> = {};

    // dns.enable 在 TUN 下是**系统锁定项**，与 external-controller/mixed-port 同一性质：
    // auto-route + strict-route 把 53 端口流量导进 utun、dns-hijack 拦下来，内置 DNS 关着
    // 就没有任何组件接管，是死配置。而 `dns.enable: false` 在 mixed 下完全合法且由机场下发、
    // 用户改不了，硬拒绝等于逼用户先学会写覆写文件才能用 TUN——故强制打开并告警。
    // 只锁 enable 一个键：nameserver 等仍是用户的正当自定义。
    const dnsExplicitlyDisabled = 'enable' in subDns && subDns.enable !== true;
    dns.enable = true;
    // 补齐缺省值，保留用户显式设置的 DNS 模式与地址范围
    if (!('enhanced-mode' in subDns)) dns['enhanced-mode'] = 'fake-ip';
    if (!('fake-ip-range' in subDns)) dns['fake-ip-range'] = '198.18.0.1/16';
    systemConfig.dns = dns;

    if (dnsExplicitlyDisabled) {
      lockedWarnings.push('TUN 模式已强制开启 DNS（订阅/覆写中的 dns.enable 被忽略）：TUN 会劫持 53 端口流量，内置 DNS 关闭时无组件接管，网络将不可用');
    }
  } else {
    // Mixed 模式不保留订阅/覆写自带的 tun 字段，避免未要求 TUN 却被静默按 TUN 启动
    delete withOverwrites.tun;
  }

  const merged = { ...withOverwrites, ...systemConfig };

  if (systemConfig.dns) {
    merged.dns = { ...((withOverwrites.dns || {}) as Record<string, unknown>), ...(systemConfig.dns as Record<string, unknown>) };
  }

  const mergedDns = (merged.dns || {}) as Record<string, unknown>;
  if (mergedDns['enhanced-mode'] === 'fake-ip' && !('sniffer' in withOverwrites)) {
    merged.sniffer = {
      enable: true,
      sniff: {
        HTTP: { ports: [80, '8080-8880'], 'override-destination': true },
        TLS: { ports: [443, 8443] },
        QUIC: { ports: [443, 8443] },
      },
      'skip-domain': ['+.push.apple.com'],
    };
  }

  assertConfigShape(merged);
  return { config: merged, warnings: lockedWarnings, overwriteSummaries, scriptMatches };
}

/** 锁定键告警的统一文案（YAML 覆写与 JS 脚本共用一份，避免两处解释漂移） */
function renderLockedWarning(source: string, keys: string[]): string {
  return `${source}系统锁定项已忽略: ${keys.join('、')}（入站端口、控制面、控制器证书与局域网/入站鉴权由 mihomo-cli 管理；端口与 controller secret 在 settings.json 配置，入站固定只监听回环，需要局域网入站请在本机另起一个 mihomo-cli 实例）`;
}

/**
 * status 的脚本命中判定：只读、永不抛（诊断面，D7 姿态）。与 buildConfig 的差别：
 * 加载由调用方把 listOverwriteFile 的 entries 传进来——坏文件已在 broken 里、
 * **不在 entries 也不抛**，一个坏 YAML 不会把全部脚本的判定打回「未判定＝生效」；
 * 不做系统合并与形状断言（判定只关心脚本返回值，不产出可运行配置）。脚本变换
 * 在独立解析的副本上执行，不触碰任何运行态。解析失败（坏订阅）返回空 matches，
 * 调用方按未判定降级。
 */
export function judgeScriptMatches(
  subRawContent: string,
  mode: RuntimeMode,
  scope: OverwriteScope | undefined,
  entries: OverwriteFileEntry[],
): { matches: ScriptMatch[]; error?: string } {
  try {
    const subscriptionConfig = parseConfigContent(subRawContent, '订阅内容');
    const settings = readSettings();
    // 全局开关与 selectActiveOverwriteFiles 闸门与 buildConfig 同款（脚本恒过 match 筛）
    const active = settings.overwrite_enabled !== false ? selectActiveOverwriteFiles(entries, scope) : [];
    const { scriptMatches } = applyOverwrite(subscriptionConfig, active, {
      mode,
      scope,
    });
    return { matches: scriptMatches };
  } catch (e) {
    return { matches: [], error: (e as Error).message?.split('\n')[0] ?? String(e) };
  }
}

/**
 * 推导路径的运行模式判据（唯一真相）：当前落盘配置有 tun 即 TUN，否则 Mixed。
 * config / status / doctor 三处共用；runtime.ts 的 getRuntimeMode 是另一套——
 * 它带「服务安装优先 Mixed」的前置条件，不在此收敛。
 */
export function deriveRuntimeMode(info: ConfigInfo | null): RuntimeMode {
  return info?.tun ? 'tun' : 'mixed';
}

/** 运行模式的展示标签（start 行与 status 文本共用，JSON 仍走 deriveRuntimeMode 的原值） */
export function runtimeModeLabel(mode: RuntimeMode): string {
  return mode === 'tun' ? 'TUN' : 'Mixed';
}

/** 统计一份配置里的节点与节点组数量：订阅下载、启动准备与配置信息三处的同一取值口径 */
export function countConfigNodes(config: Record<string, unknown>): { proxies: number; proxyGroups: number } {
  const proxies = config.proxies as unknown[] | undefined;
  const proxyGroups = config['proxy-groups'] as unknown[] | undefined;
  return {
    proxies: proxies ? proxies.length : 0,
    proxyGroups: proxyGroups ? proxyGroups.length : 0,
  };
}

export function writeMihomoConfig(configObj: Record<string, unknown>): void {
  ensureDirs();
  const content = dumpYaml(configObj);
  atomicWriteFileSync(PATHS.configFile, content, { mode: 0o600 });
}

/** hint 行原样打印（index 的 main().catch 不加工），缩进得自己带 */
const HINT_INDENT = '  ';

/**
 * 拼装内核拒绝配置时的 hint。抽成纯函数便于逐行断言文案（同 shouldAbortStartOnDisable
 * 那类判据收口的用法）——留在 catch 块里就只能靠跑真实/桩内核间接验证。
 *
 * 覆写清单只在**非空**时附加：没有覆写文件、`ow off`、本次订阅没命中任何 match，
 * 三种情况下问题都必在订阅本身，多打一段「当前生效的覆写文件: 无」是纯噪音，
 * 还会把排查方向引偏。反之也不做「未命中即告警」：ssh -D 那类靠 `+proxies`
 * 追加节点的正常用法每次 start 都会刷屏，而它并没有出错。
 */
export function buildKernelRejectHint(detail: string, overwriteSummaries: string[], opts: { timedOut?: boolean } = {}): string[] {
  // 超时与配置内容无关：无内核输出可展示、不附覆写清单，尾行排查方向单独给
  if (opts.timedOut) {
    return ['', `${HINT_INDENT}内核在 30s 内未给出校验结论，可能是内核或系统异常（与配置内容无关）；当前运行时配置未改动。`];
  }
  // 内核可能一次报多条（每个不合法的键一行）；空行保持空行，不缩出尾随空格
  const hint = ['', ...detail.split('\n').map(line => (line.trim() ? `${HINT_INDENT}${line}` : ''))];

  if (overwriteSummaries.length > 0) {
    hint.push('', `${HINT_INDENT}当前生效的覆写文件:`);
    // 文件名与 match 值都来自用户文件，同内核输出一样消毒，防 ESC 序列污染终端
    for (const summary of overwriteSummaries) hint.push(sanitizeTerminal(`${HINT_INDENT.repeat(2)}${summary}`));
    hint.push(`${HINT_INDENT}若报错的元素来自覆写（YAML 追加或 JS 脚本注入），检查对应的覆写文件与脚本。`);
  }

  hint.push(
    '',
    `${HINT_INDENT}请修正订阅或覆写；当前运行时配置未改动。`,
    // 「未知键/字段」类报错的另一个真实根因是内核落后于订阅：机场开始用新协议字段，
    // 旧内核 -t 一律按不认识拒绝。只提示「修正订阅或覆写」会把方向带反
    `${HINT_INDENT}若订阅或覆写本身没有明显错误，也可能是内核版本过旧、不认识新配置键，可尝试: mihomo-cli kernel`,
  );
  return hint;
}

/**
 * 由内核检查节点、分组引用与规则语义，不在 CLI 中维护另一份配置修复器。
 * 临时配置只用于 -t，成功后调用方才替换运行时配置；成功或失败都会清理临时文件。
 *
 * overwriteSummaries 由调用方从 buildConfig 的结果透传（见 BuildConfigResult）：
 * 本函数不自行 loadOverwriteFile——它拿不到 scope 无从按作用域过滤，且违反
 * 「覆写的加载与筛选由调用方完成」的分工。参数必填、不给默认值：透传快照的
 * 可选默认值会让新调用方静默丢覆写清单。
 */
export async function validateConfigWithKernel(config: Record<string, unknown>, overwriteSummaries: string[]): Promise<void> {
  assertKernelInstalled();
  ensureDirs();
  const stageDir = fs.mkdtempSync(path.join(DIRS.runtime, 'check-'));
  const stageFile = path.join(stageDir, 'config.yaml');
  try {
    fs.writeFileSync(stageFile, dumpYaml(config), { mode: 0o600 });
    try {
      await promisify(execFile)(PATHS.mihomoBinary, ['-t', '-d', DIRS.data, '-f', stageFile], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (e) {
      const error = e as Error & { stdout?: string; stderr?: string; killed?: boolean };
      const detail = sanitizeTerminal(`${error.stdout || ''}\n${error.stderr || ''}`).trim();
      // 超时与配置内容无关（内核没在 30s 内给出结论）：不列覆写、不引内核输出，
      // 尾行排查方向也单独给（buildKernelRejectHint 的 timedOut 分支）
      if (error.killed) {
        throw new CliError('内核配置校验超时', {
          label: '配置错误',
          hint: buildKernelRejectHint('', [], { timedOut: true }),
        });
      }
      throw new CliError('内核拒绝加载配置', {
        label: '配置错误',
        hint: buildKernelRejectHint(detail || error.message, overwriteSummaries),
      });
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function hasConfig(): boolean {
  return fs.existsSync(PATHS.configFile);
}

export function getConfigInfo(): ConfigInfo | null {
  if (!hasConfig()) return null;

  try {
    const content = fs.readFileSync(PATHS.configFile, 'utf8');
    const cfg = loadYamlSafe(content) as Record<string, unknown> | null;
    if (!cfg) return null;

    const tun = cfg.tun as Record<string, unknown> | undefined;

    return {
      ...countConfigNodes(cfg),
      mixedPort: (cfg['mixed-port'] as number) || null,
      tun: tun ? !!tun.enable : false,
    };
  } catch {
    return null;
  }
}

export function hasKernel(): boolean {
  return fs.existsSync(PATHS.mihomoBinary);
}

/** 「内核未安装」的统一报错与指引（start/install/tun 启动/服务符号链/内核校验共用，措辞单点维护） */
export function assertKernelInstalled(): void {
  if (!hasKernel()) throw new CliError('未找到内核', { hint: '下载内核: mihomo-cli kernel' });
}

/** 「运行时配置缺失」的统一报错与指引（服务启动/TUN 启动共用）：配置由 start 按订阅重建 */
export function assertRuntimeConfigPresent(): void {
  if (!fs.existsSync(PATHS.configFile)) throw new CliError('未找到运行时配置', { hint: '请先添加订阅: mihomo-cli sub add <url>' });
}

/** 一次 `mihomo -v` spawn 的探测结果：可执行性判据与版本提取共用一份正则（doctor 检查项、kernel 下载自检、checkUpdate 消费） */
export interface KernelProbe {
  /** spawn 本身的失败（ENOENT/超时等），区别于非零退出 */
  spawnError: Error | null;
  /** 退出码；spawnError 时为 null */
  status: number | null;
  /** stdout+stderr 合并（已 trim） */
  output: string;
  /** 版本串（三段数字，可能带 v 前缀）；输出不含该形态时为 null */
  version: string | null;
}

/** 一次 spawn 拿可执行性与版本两类结论（此前同一信息要 2-3 次 spawn 各自提取） */
export function probeKernelVersion(binary: string = PATHS.mihomoBinary): KernelProbe {
  const r = spawnSync(binary, ['-v'], { encoding: 'utf8', timeout: 5000 });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const match = output.match(/v?\d+\.\d+\.\d+/);
  return { spawnError: r.error ?? null, status: r.status ?? null, output, version: match ? match[0] : null };
}

/**
 * 内核版本探测。CLI 是短进程、调用点全在展示路径（status/doctor/help/kernel），
 * 每次直接 spawn 一次 `mihomo-cli -v`（本地毫秒级）——不做进程内缓存：
 * 缓存需要失效协议（下载/reset 换掉内核后要记得清），省一次重复探测的收益不抵这层状态。
 *
 * 已持有 probe 结果的调用方（doctor 一次体检内复用同一份）经参数传入，免二次 spawn。
 */
export function getKernelVersion(probe?: KernelProbe): string | null {
  if (!hasKernel()) return null;
  try {
    const p = probe ?? probeKernelVersion();
    if (!p.output) return 'unknown';
    return p.version ?? p.output.split('\n')[0];
  } catch {
    return 'unknown';
  }
}
