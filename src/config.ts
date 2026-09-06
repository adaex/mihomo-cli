import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import * as yaml from 'js-yaml';
import { BASE_CONFIG, TUN_CONFIG } from './constants.js';
import { CliError } from './errors.js';
import { applyOverwrite, filterOverwriteFilesByScope, isOverwriteEnabled, loadOverwriteFile } from './overwrite.js';
import { atomicWriteFileSync, ensureDirs, PATHS } from './paths.js';
import { getPorts, readSettings } from './settings.js';
import type { BuildConfigResult, ConfigInfo, OverwriteScope, ParsedProxy, ParsedProxyGroup } from './types.js';
import { escapeRegExp } from './utils.js';

/**
 * 安全 YAML 解析选项:限制别名展开次数,防御远程订阅/覆写里的 YAML 别名炸弹(alias bomb)DoS。
 * js-yaml 5 默认 maxAliases=-1(无限制),恶意配置可借指数级别名膨胀撑爆内存/CPU。
 * 所有解析不可信来源(订阅、覆写、运行时配置)的 yaml.load 都应带上此选项。
 */
export const SAFE_YAML_LOAD_OPTIONS: yaml.LoadOptions = { maxAliases: 200 };

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

function collectOverwriteProxyNames(overwriteFiles: { config: Record<string, unknown> }[], baseProxyNames: Set<string>): string[] {
  const names: string[] = [];
  for (const file of overwriteFiles) {
    for (const [key, value] of Object.entries(file.config)) {
      // +proxies/proxies+（前置/追加）与 ~proxies（按 name 就地合并，同名不存在时也会追加新节点）
      // 都会向节点列表注入新节点，需一并从 include-all 分组排除，避免被重复纳入
      if ((key === '+proxies' || key === 'proxies+' || key === '~proxies') && Array.isArray(value)) {
        for (const proxy of value) {
          if (proxy && typeof proxy === 'object' && 'name' in proxy) {
            const name = (proxy as { name: unknown }).name;
            // 过滤空/非字符串 name：否则 exclude-filter 正则会出现空分支（a||b），匹配所有节点，清空 include-all 分组
            if (typeof name !== 'string' || name.length === 0) continue;
            // ~proxies 就地 patch 订阅已有节点时**不注入新节点**——节点本就在池子里、
            // include-all 本就含它，照收进 exclude-filter 反而把它从所有自动分组剔除
            // （机场订阅主流写法是 include-all，patch 节点字段是 ~ 的正当用法，此前静默改变分流）。
            // 故 ~ 分支只收「订阅里没有的名字」（真正的新增）
            if (key === '~proxies' && baseProxyNames.has(name)) continue;
            names.push(name);
          }
        }
      }
    }
  }
  return names;
}

/** 导出供单测：注入节点需从 include-all 分组排除，且排除模式必须整名锚定（见函数内注释） */
export function excludeOverwriteProxiesFromIncludeAll(
  config: Record<string, unknown>,
  overwriteFiles: { config: Record<string, unknown> }[],
  baseProxyNames: Set<string> = new Set(),
): void {
  const injectedNames = collectOverwriteProxyNames(overwriteFiles, baseProxyNames);
  if (injectedNames.length === 0) return;

  const groups = config['proxy-groups'] as Array<Record<string, unknown>> | undefined;
  if (!groups) return;

  // 锚定为整名精确匹配：mihomo 的 exclude-filter 是无锚点正则搜索（Go regexp.MatchString），
  // 裸拼接会把「名字包含注入名」的订阅节点一起排除——注入名为 HK 时 HK-01/HK-02 也被踢出 include-all
  // 分组。本函数只为排除「自己注入的那个节点」，故用 ^(?:...)$ 收窄为整名相等。
  // 与订阅自带 exclude-filter 拼接安全：| 优先级最低，^(?:...)$ 自成独立分支，不影响原有语义。
  const excludePattern = `^(?:${injectedNames.map(n => escapeRegExp(n)).join('|')})$`;

  for (const group of groups) {
    if (!group['include-all'] && !group['include-all-proxies']) continue;
    const existing = group['exclude-filter'] as string | undefined;
    if (existing) {
      group['exclude-filter'] = `${existing}|${excludePattern}`;
    } else {
      group['exclude-filter'] = excludePattern;
    }
  }
}

const BUILTIN_PROXY_NAMES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);

function deduplicateByName<T extends { name: string }>(items: T[]): { result: T[]; names: Set<string>; duplicates: string[] } {
  const names = new Set<string>();
  const duplicates: string[] = [];
  const result = items.filter(item => {
    if (names.has(item.name)) {
      duplicates.push(item.name);
      return false;
    }
    names.add(item.name);
    return true;
  });
  return { result, names, duplicates };
}

/**
 * 无「目标为代理/分组名」语义的规则类型：末段不是 proxy/group 引用，不参与目标存在性校验。
 * - SUB-RULE: `SUB-RULE,(表达式),<sub-rule名>` 末段引用 sub-rules 顶层键，非代理
 */
const NON_TARGET_RULE_TYPES = new Set(['SUB-RULE']);

/**
 * 取规则的目标（代理/分组名）。末段为 `no-resolve` 修饰后缀时取倒数第二段
 * （如 `IP-CIDR,1.1.1.1/32,DIRECT,no-resolve` 的目标是 DIRECT，不是 no-resolve）。
 */
export function getRuleTarget(rule: string): string {
  const parts = rule.split(',');
  if (parts.length < 2) return '';
  const last = parts[parts.length - 1].trim();
  if (last.toLowerCase() === 'no-resolve' && parts.length >= 3) {
    return parts[parts.length - 2].trim();
  }
  return last;
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
 * 不做则后续断言（`as ParsedProxy[]` 等）会在解引用时抛裸 TypeError，
 * 经 main().catch 当成程序 bug 打印堆栈——而这实际是用户配置问题
 * （典型：`rules: MATCH,DIRECT` 漏写 `-`；列表里留了空项产生 null 元素）。
 */
function assertConfigShape(config: Record<string, unknown>): void {
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

export function validateConfig(config: Record<string, unknown>): string[] {
  assertConfigShape(config);
  const warnings: string[] = [];

  const proxies = (config.proxies || []) as ParsedProxy[];
  const groups = (config['proxy-groups'] || []) as ParsedProxyGroup[];
  const rules = (config.rules || []) as string[];

  const proxyDedup = deduplicateByName(proxies);
  config.proxies = proxyDedup.result;
  if (proxyDedup.duplicates.length > 0) {
    const preview = proxyDedup.duplicates
      .slice(0, 3)
      .map(n => `"${n}"`)
      .join(', ');
    warnings.push(`移除了 ${proxyDedup.duplicates.length} 个重名节点: ${preview}${proxyDedup.duplicates.length > 3 ? ' ...' : ''}`);
  }

  const groupDedup = deduplicateByName(groups);
  config['proxy-groups'] = groupDedup.result;
  if (groupDedup.duplicates.length > 0) {
    warnings.push(`移除了 ${groupDedup.duplicates.length} 个重名分组: ${groupDedup.duplicates.map(n => `"${n}"`).join(', ')}`);
  }

  const validNames = new Set([...BUILTIN_PROXY_NAMES, ...proxyDedup.names, ...groupDedup.names]);

  // proxy 与 proxy-group 同名：validNames 是合并 Set，冲突在其中不可见，两者都被留下，
  // 而 mihomo 启动时会因重复名直接报错。这里只告警不自动删——删哪个都可能不是用户想要的
  for (const name of groupDedup.names) {
    if (proxyDedup.names.has(name)) {
      warnings.push(`名称冲突: "${name}" 同时是节点和分组名，mihomo 会拒绝加载（请重命名其一）`);
    }
  }

  // proxy-providers 里声明的 provider 名，用于校验分组的 use 引用
  const providerNames = new Set<string>(
    config['proxy-providers'] && typeof config['proxy-providers'] === 'object' && !Array.isArray(config['proxy-providers'])
      ? Object.keys(config['proxy-providers'] as Record<string, unknown>)
      : [],
  );

  const activeGroups = groupDedup.result;
  const removedGroups = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const group of activeGroups) {
      if (removedGroups.has(group.name)) continue;

      // proxies 写成标量（漏了列表缩进）时此前被整体跳过，非法结构原样落盘。
      // 转成单元素列表继续走后续校验，并告警提示用户改正
      if (group.proxies !== undefined && !Array.isArray(group.proxies)) {
        if (typeof group.proxies === 'string') {
          warnings.push(`proxy-group "${group.name}": proxies 应为列表，已按单元素处理（"${group.proxies}"）`);
          group.proxies = [group.proxies];
        } else {
          warnings.push(`proxy-group "${group.name}": proxies 不是列表，已忽略该字段`);
          group.proxies = [];
        }
      }
      if (!Array.isArray(group.proxies)) continue;

      // use 引用不存在的 provider：此前从不校验，且 use 计入 hasOtherSource 使该组免于删除，
      // 于是生成的配置引用了不存在的 provider，mihomo 报错
      if (Array.isArray(group.use)) {
        const ghosts = group.use.filter(u => typeof u === 'string' && !providerNames.has(u));
        if (ghosts.length > 0) {
          group.use = group.use.filter(u => providerNames.has(u as string));
          warnings.push(`proxy-group "${group.name}": 移除了不存在的 provider 引用 ${ghosts.map(n => `"${n}"`).join(', ')}`);
        }
      }

      const invalid = group.proxies.filter(name => !validNames.has(name));
      if (invalid.length > 0) {
        group.proxies = group.proxies.filter(name => validNames.has(name));
        warnings.push(`proxy-group "${group.name}": 移除了不存在的引用 ${invalid.map(n => `"${n}"`).join(', ')}`);
      }

      // include-all* 只在确有节点可纳入时才算有效来源：proxies 全空 + 节点池为空时，
      // 该组实际没有任何出口，留着会让 MATCH,<组名> 指向一个空组（表现为完全不通）
      const hasUse = Array.isArray(group.use) ? group.use.length > 0 : Boolean(group.use);
      const includesAll = Boolean(group['include-all'] || group['include-all-proxies']);
      const includeAllUsable = includesAll && proxyDedup.result.length > 0;
      const hasOtherSource = hasUse || includeAllUsable;
      if (group.proxies.length === 0 && !hasOtherSource) {
        removedGroups.add(group.name);
        validNames.delete(group.name);
        warnings.push(`proxy-group "${group.name}": 已移除（无可用节点）`);
        changed = true;
      }
    }
  }

  if (removedGroups.size > 0) {
    config['proxy-groups'] = activeGroups.filter(g => !removedGroups.has(g.name));
  }

  if (rules.length > 0) {
    const removedRules: string[] = [];
    config.rules = rules.filter(rule => {
      // SUB-RULE 等类型末段非代理/分组引用，跳过目标存在性校验，避免误删
      const ruleType = rule.split(',')[0]?.trim().toUpperCase();
      if (NON_TARGET_RULE_TYPES.has(ruleType)) return true;
      const target = getRuleTarget(rule);
      if (!target || validNames.has(target)) return true;
      removedRules.push(rule);
      return false;
    });
    if (removedRules.length > 0) {
      warnings.push(`移除了 ${removedRules.length} 条引用不存在目标的规则`);
    }
  }

  return warnings;
}

export function buildConfig(subRawContent: string, mode: string, scope?: OverwriteScope): BuildConfigResult {
  const subscriptionConfig = parseConfigContent(subRawContent, '订阅内容');

  if (!subscriptionConfig) {
    throw new Error('订阅内容为空');
  }

  const overwriteEnabled = isOverwriteEnabled();
  const allFiles = overwriteEnabled ? loadOverwriteFile() : [];
  // 作用域过滤统一在此做一次，后续 applyOverwrite / excludeOverwrite / 返回值全部沿用这份已过滤列表
  const overwriteFiles = filterOverwriteFilesByScope(allFiles, scope);
  // 深拷贝后再传给 applyOverwrite：它只做浅拷贝（{...base}），proxy-groups 等嵌套对象
  // 仍与原对象共享引用，excludeOverwriteProxiesFromIncludeAll / validateConfig 会原地改它们，
  // 污染 subscriptionConfig 导致 debug stage1（本应是「原始订阅」）失真
  const working = structuredClone(subscriptionConfig);
  const withOverwrites = applyOverwrite(working, overwriteFiles);

  if (overwriteFiles.length > 0) {
    // 订阅原有节点名单：~proxies patch 已有节点不该被排除出 include-all（见 collectOverwriteProxyNames）
    // 从原始 subscriptionConfig 读，不用 working（它可能已被覆写改了 proxies）
    const baseProxies = Array.isArray(subscriptionConfig.proxies) ? (subscriptionConfig.proxies as unknown[]) : [];
    const baseProxyNames = new Set(
      baseProxies.filter(p => p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string').map(p => (p as { name: string }).name),
    );
    excludeOverwriteProxiesFromIncludeAll(withOverwrites, overwriteFiles, baseProxyNames);
  }

  const systemConfig: Record<string, unknown> = {};
  // 系统锁定项覆盖用户显式配置时产生的告警，最终并入 validateConfig 的 warnings 一并返回
  const lockedWarnings: string[] = [];
  for (const [key, value] of Object.entries(BASE_CONFIG)) {
    if (!(key in withOverwrites)) {
      systemConfig[key] = value;
    }
  }

  // 系统锁定项：controller/端口固定是 UI 与热重载的统一依赖地址；secret 仅取自用户设置。
  // 端口经 settings.ports（getPorts）解析——默认 7890/9090，可在 settings.json 覆盖（与其他代理工具共存的逃生口）。
  // allow-lan 不锁定——订阅/覆写显式提供时按其值（见入站需求），未提供时由上面的 BASE_CONFIG 循环兜底为 false。
  const ports = getPorts();
  systemConfig['external-controller'] = `127.0.0.1:${ports.controller}`;
  systemConfig['mixed-port'] = ports.mixed;
  delete withOverwrites['mixed-port'];
  delete withOverwrites.port;
  delete withOverwrites['socks-port'];
  delete withOverwrites['external-ui'];
  delete withOverwrites['external-ui-name'];
  delete withOverwrites['external-ui-url'];
  delete withOverwrites.secret;
  const controllerSecret = readSettings().controller_secret;
  if (controllerSecret) {
    systemConfig.secret = controllerSecret;
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
    // 此前这三项都用 `!('enable' in subDns)` 之流做条件，订阅显式关 dns 时
    // 照样往「已关闭」的 dns 块里补 fake-ip 字段，生成端自相矛盾（CODE_REVIEW v4.2.3 记录）。
    // 现在 enable 恒为 true，补默认值不再矛盾
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

  const warnings = [...lockedWarnings, ...validateConfig(merged)];

  return { config: merged, subscriptionConfig, overwriteFiles, systemConfig, warnings };
}

export function writeMihomoConfig(configObj: Record<string, unknown>): void {
  ensureDirs();
  const content = dumpYaml(configObj);
  atomicWriteFileSync(PATHS.configFile, content, { mode: 0o600 });
}

export function writeDebugConfig(buildResult: BuildConfigResult): void {
  ensureDirs();

  fs.writeFileSync(PATHS.configStage1Subscription, dumpYaml(buildResult.subscriptionConfig), { mode: 0o600 });

  const overwriteMerged: Record<string, unknown> = {};
  for (const f of buildResult.overwriteFiles) {
    Object.assign(overwriteMerged, f.config);
  }
  const overwriteContent = buildResult.overwriteFiles.length > 0 ? dumpYaml(overwriteMerged) : '# overwrite 已禁用或无覆写文件\n';
  fs.writeFileSync(PATHS.configStage2Overwrite, overwriteContent, { mode: 0o600 });

  fs.writeFileSync(PATHS.configStage3System, dumpYaml(buildResult.systemConfig), { mode: 0o600 });
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
      httpPort: (cfg.port as number) || null,
      socksPort: (cfg['socks-port'] as number) || null,
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
