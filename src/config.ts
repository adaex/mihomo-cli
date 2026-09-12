import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import * as yaml from 'js-yaml';
import { BASE_CONFIG, TUN_CONFIG } from './constants.js';
import { CliError } from './errors.js';
import { applyOverwrite, describeOverwriteScope, filterOverwriteFilesByScope, loadOverwriteFile } from './overwrite.js';
import { atomicWriteFileSync, DIRS, ensureDirs, PATHS } from './paths.js';
import { getPorts, readSettings } from './settings.js';
import type { BuildConfigResult, ConfigInfo, OverwriteScope } from './types.js';
import { sanitizeTerminal } from './utils.js';

/**
 * 安全 YAML 解析选项:限制别名展开次数,防御远程订阅/覆写里的 YAML 别名炸弹(alias bomb)DoS。
 * js-yaml 5 默认 maxAliases=-1(无限制),恶意配置可借指数级别名膨胀撑爆内存/CPU。
 * 所有解析不可信来源(订阅、覆写、运行时配置)的 yaml.load 都应带上此选项。
 */
export const SAFE_YAML_LOAD_OPTIONS: yaml.LoadOptions = { maxAliases: 200 };

/**
 * 系统锁定的入站/控制面键：只允许来自 settings 或系统约束，订阅与覆写显式提供时
 * 剥除并告警（buildConfig）。新增入站/控制器键时加在这里——redir/tproxy 与
 * external-controller-tls/-unix/-cors 都曾是漏网之鱼。
 * 对应上游 mihomo `config/config.go` 的 General 段（端口家族 + ExternalController* +
 * ExternalUI* + Secret）；listeners 刻意不在内（产品决策未定）。
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
  'external-ui',
  'external-ui-name',
  'external-ui-url',
  'secret',
] as const;

/** 统一入口:带别名上限的 yaml.load,替代裸 yaml.load。 */
export function loadYamlSafe(content: string): unknown {
  return yaml.load(content, SAFE_YAML_LOAD_OPTIONS);
}

/**
 * 解析配置内容（订阅 YAML 或 JSON）为顶层映射。
 *
 * **只走 YAML 解析器，没有独立的 JSON 分支**：YAML 1.2 是 JSON 的超集，标准 JSON
 * （含 tab 缩进、长整数、嵌套数组）实测全部由 `loadYamlSafe` 正常解析。
 * 此前额外挂了个 `JSON.parse` 回退，实际唯一能走到那里的输入是**重复键 JSON**
 * （`{"a":1,"a":2}` —— YAML 明确报错，JSON.parse 静默取最后一个值）：
 * 那条回退把「坏数据」变成了「静默接受」，方向正好是错的。订阅里出现重复键
 * 意味着上游生成有问题，取哪个值都是猜，必须报错让用户看见。
 *
 * 只接受对象：标量/数组不是合法配置（`proxies` 等段都挂在顶层映射下）。
 */
export function parseConfigContent(content: string, errorMsg?: string): Record<string, unknown> {
  const label = errorMsg || '内容';
  if (!content?.trim()) {
    throw new Error(`${label}为空`);
  }

  let result: unknown;
  try {
    result = loadYamlSafe(content);
  } catch (e) {
    // YAML 的报错含行列号，对定位笔误很有用，原样带出（首行即可，堆栈无意义）
    throw new Error(`${label}格式错误，无法解析: ${(e as Error).message.split('\n')[0]}`);
  }

  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${label}不是有效的配置对象（顶层需为映射，当前是${Array.isArray(result) ? '列表' : typeof result}）`);
  }
  return result as Record<string, unknown>;
}

/**
 * 统一的 YAML 序列化选项:2 空格缩进、不折行。
 * 用默认 DUMP_SCHEMA(不显式指定 schema):对歧义标量(on/off/yes/no/y/n/true/null 等)加引号。
 * 关键原因:节点名/分组名等 string 字段的值可能恰好是 `on`/`off`。裸输出 `name: on` 在 mihomo
 * (go-yaml v3,仅 typed bool 才认 1.1 布尔)下虽仍读作字符串,但流经 PyYAML 等 YAML 1.1 工具会被
 * 误解析成布尔 true,造成静默的配置损坏。加引号后在 1.1/1.2 解析器下含义唯一,mihomo 处理带引号
 * 字符串无副作用。(此前用 CORE_SCHEMA 省引号,反而丢了这层跨解析器安全。)
 */
export function dumpYaml(obj: unknown): string {
  return yaml.dump(obj, { indent: 2, lineWidth: -1 });
}

/**
 * 校验 dns 段是映射。非映射（`dns: true`、`dns: [...]`）会让下游的
 * `'enable' in subDns` / 展开运算符抛裸 TypeError 或静默产出垃圾配置。
 *
 * **两条路径共用**：TUN 分支在读 `dns.enable` 前先调（早于合并，报错指向订阅原值），
 * mixed 路径由 `assertConfigShape` 兜底——此前只有 TUN 有守卫（v4.2.3 顺手修的），
 * mixed 下同样的订阅笔误照样抛裸 TypeError。
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
            hint: [`${label}段（${key}）第 ${i + 1} 项没有 name 字段（或为空），mihomo 会拒绝启动。`],
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

export function buildConfig(subRawContent: string, mode: string, scope?: OverwriteScope): BuildConfigResult {
  const subscriptionConfig = parseConfigContent(subRawContent, '订阅内容');

  const settings = readSettings();
  const allFiles = settings.overwrite_enabled !== false ? loadOverwriteFile() : [];
  const overwriteFiles = filterOverwriteFilesByScope(allFiles, scope);
  const { config: withOverwrites, skipped: skippedMerges, operatorShapedKeys } = applyOverwrite(subscriptionConfig, overwriteFiles);
  const overwriteSummaries = overwriteFiles.map(describeOverwriteScope);

  const systemConfig: Record<string, unknown> = {};
  // 系统约束覆盖显式设置时告警，节点与分流规则保持用户给出的内容
  const lockedWarnings: string[] = [];
  // `~?key` 跳过的补丁：静默跳过与「分组名拼错」无法区分，用户会以为覆写生效了
  for (const s of skippedMerges) {
    lockedWarnings.push(`覆写 ~?${s.key} 的补丁 "${s.name}" 未匹配到当前订阅中的同名元素，已跳过${s.file ? `（${s.file}）` : ''}`);
  }
  // 嵌套层形似操作符的键：已按字面处理，但用户可能以为操作符会生效（如把 +rules 写进
  // dns 里）；若是 mihomo 原生键则无碍，文案里说清可忽略。不承诺最终保留——后续文件的
  // key! 整体覆盖可能让它从终态消失（收集发生在逐文件合并期）
  for (const n of operatorShapedKeys) {
    lockedWarnings.push(
      `覆写${n.file ? `文件 ${n.file} 的` : ''}嵌套键 "${n.key}" 形似操作符，已按字面键名处理；操作符只在覆写文件顶层生效，若这是 mihomo 原生键可忽略本提示`,
    );
  }
  for (const [key, value] of Object.entries(BASE_CONFIG)) {
    if (!(key in withOverwrites)) {
      systemConfig[key] = value;
    }
  }

  // 系统锁定项：入站端口与整个控制面只能来自 settings 与系统约束，订阅/覆写（远端不可信
  // 内容）显式设置时必须剥除并告警——静默忽略就是「用户以为生效了，实际行为完全没变」。
  // 端口经 settings.ports（getPorts）解析——默认 7890/9090，可在 settings.json 覆盖
  // （与其他代理工具共存的逃生口）。
  //
  // 控制器家族一个都不能漏：external-controller-tls 可在 0.0.0.0 再开一个控制器（配合顶层
  // tls 段给证书）、-unix 可在任意路径建 socket 控制器、-cors 直接放宽现有控制器的浏览器
  // 跨域，而订阅自带的 secret 同在此处被剥除、默认又不设密钥——额外控制器将无鉴权，打破
  // 「控制器仅监听本机回环」的信任边界（上游 config.go 的 General 键逐个核对过）。
  // -pipe 仅 Windows 内核识别，一并剥除保持跨平台输出一致。
  // allow-lan 不锁定——订阅/覆写显式提供时按其值（见入站需求），未提供时由上面的 BASE_CONFIG 循环兜底为 false。
  // listeners 不在本清单：订阅以 listeners 投递入站是否合法属未定的产品决策，不在删除表收口。
  const ignoredLockedKeys = LOCKED_CONFIG_KEYS.filter(k => k in withOverwrites);
  if (ignoredLockedKeys.length > 0) {
    lockedWarnings.push(
      `订阅/覆写中的系统锁定项已忽略: ${ignoredLockedKeys.join('、')}（入站端口与控制面由 mihomo-cli 管理；端口与 controller secret 在 settings.json 配置）`,
    );
  }
  for (const key of LOCKED_CONFIG_KEYS) {
    delete withOverwrites[key];
  }
  // 顶层 tls 段是 external-controller-tls 的证书/私钥来源（上游 parseTLS 只喂控制器），
  // 与控制器家族同属控制面、一并锁定，否则剥了监听地址却留下证书配置只会误导排查
  if ('tls' in withOverwrites) {
    delete withOverwrites.tls;
    lockedWarnings.push('订阅/覆写中的 tls 段已忽略: 该段仅用于外部控制器 TLS 证书，控制面由 mihomo-cli 管理');
  }

  const ports = getPorts(settings);
  systemConfig['external-controller'] = `127.0.0.1:${ports.controller}`;
  systemConfig['mixed-port'] = ports.mixed;
  const controllerSecret = settings.controller_secret;
  if (controllerSecret !== undefined) {
    // 与 getPorts 同族：手改 settings.json 写成数字/布尔时，内核 -t 可能拒绝也可能强转，
    // 而 config 展示命令不跑内核校验——在唯一消费点明确报错，脱敏出口也据此可依赖字符串类型
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
  return { config: merged, warnings: lockedWarnings, overwriteSummaries };
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
 * 还会把排查方向引偏。反之也不做「未命中即告警」：ssh -D 那类靠 `~proxies`
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
    hint.push(`${HINT_INDENT}若报错的元素来自覆写追加（~key 未匹配到同名元素时会新增），改用 ~?key 可在缺少该元素的订阅上跳过。`);
  }

  hint.push('', `${HINT_INDENT}请修正订阅或覆写；当前运行时配置未改动。`);
  return hint;
}

/**
 * 由内核检查节点、分组引用与规则语义，不在 CLI 中维护另一份配置修复器
 * 临时配置只用于 -t，成功后调用方才替换运行时配置；成功或失败都会清理临时文件
 *
 * overwriteSummaries 由调用方从 buildConfig 的结果透传（见 BuildConfigResult）：
 * 本函数不自行 loadOverwriteFile——它拿不到 scope 无从按作用域过滤，且违反
 * 「覆写的加载与筛选由调用方完成」的分工。参数必填、不给默认值：透传快照的可选默认值
 * 会让新调用方静默丢覆写清单（CLAUDE.md「透传快照的参数一律必填」的成文教训）。
 */
export async function validateConfigWithKernel(config: Record<string, unknown>, overwriteSummaries: string[]): Promise<void> {
  if (!hasKernel()) throw new CliError('未找到内核', { hint: '下载内核: mihomo kernel' });
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

export function hasConfig(): boolean {
  return fs.existsSync(PATHS.configFile);
}

export function getConfigInfo(): ConfigInfo | null {
  if (!hasConfig()) return null;

  try {
    const content = fs.readFileSync(PATHS.configFile, 'utf8');
    const cfg = loadYamlSafe(content) as Record<string, unknown> | null;
    if (!cfg) return null;

    const proxies = cfg.proxies as unknown[] | undefined;
    const proxyGroups = cfg['proxy-groups'] as unknown[] | undefined;
    const tun = cfg.tun as Record<string, unknown> | undefined;

    return {
      proxies: proxies ? proxies.length : 0,
      proxyGroups: proxyGroups ? proxyGroups.length : 0,
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

let kernelVersionCache: string | null = null;
let kernelVersionCached = false;

export function getKernelVersion(): string | null {
  if (!hasKernel()) {
    kernelVersionCache = null;
    kernelVersionCached = false;
    return null;
  }
  if (kernelVersionCached) return kernelVersionCache;
  try {
    const result = spawnSync(PATHS.mihomoBinary, ['-v'], { encoding: 'utf8', timeout: 5000 });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (output) {
      const match = output.match(/v?[\d]+\.[\d]+\.[\d]+/);
      kernelVersionCache = match ? match[0] : output.split('\n')[0];
    } else {
      kernelVersionCache = 'unknown';
    }
  } catch {
    kernelVersionCache = 'unknown';
  }
  kernelVersionCached = true;
  return kernelVersionCache;
}

export function clearKernelVersionCache(): void {
  kernelVersionCache = null;
  kernelVersionCached = false;
}
