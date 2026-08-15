import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import * as yaml from 'js-yaml';
import { BASE_CONFIG, TUN_CONFIG } from './constants.js';
import { applyOverwrite, filterOverwriteFilesByScope, isOverwriteEnabled, loadOverwriteFile } from './overwrite.js';
import { atomicWriteFileSync, ensureDirs, PATHS } from './paths.js';
import { readSettings } from './settings.js';
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

export function parseYamlOrJson(content: string, errorMsg?: string): Record<string, unknown> {
  if (!content?.trim()) {
    throw new Error(`${errorMsg || '内容'}为空`);
  }
  try {
    const result = loadYamlSafe(content);
    if (result != null && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch {
    // fall through to JSON
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error(`${errorMsg || '内容'}格式错误，无法解析为 YAML 或 JSON`);
  }
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

function collectOverwriteProxyNames(overwriteFiles: { config: Record<string, unknown> }[]): string[] {
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
            if (typeof name === 'string' && name.length > 0) names.push(name);
          }
        }
      }
    }
  }
  return names;
}

function excludeOverwriteProxiesFromIncludeAll(config: Record<string, unknown>, overwriteFiles: { config: Record<string, unknown> }[]): void {
  const injectedNames = collectOverwriteProxyNames(overwriteFiles);
  if (injectedNames.length === 0) return;

  const groups = config['proxy-groups'] as Array<Record<string, unknown>> | undefined;
  if (!groups) return;

  const excludePattern = injectedNames.map(n => escapeRegExp(n)).join('|');

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

export function validateConfig(config: Record<string, unknown>): string[] {
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
  const activeGroups = groupDedup.result;
  const removedGroups = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const group of activeGroups) {
      if (removedGroups.has(group.name)) continue;
      if (!Array.isArray(group.proxies)) continue;

      const invalid = group.proxies.filter(name => !validNames.has(name));
      if (invalid.length === 0) continue;

      group.proxies = group.proxies.filter(name => validNames.has(name));
      warnings.push(`proxy-group "${group.name}": 移除了不存在的引用 ${invalid.map(n => `"${n}"`).join(', ')}`);

      const hasOtherSource = group.use || group['include-all'] || group['include-all-proxies'];
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
  const subscriptionConfig = parseYamlOrJson(subRawContent, '订阅内容');

  if (!subscriptionConfig) {
    throw new Error('订阅内容为空');
  }

  const overwriteEnabled = isOverwriteEnabled();
  const allFiles = overwriteEnabled ? loadOverwriteFile() : [];
  // 作用域过滤统一在此做一次，后续 applyOverwrite / excludeOverwrite / 返回值全部沿用这份已过滤列表
  const overwriteFiles = filterOverwriteFilesByScope(allFiles, scope);
  const withOverwrites = applyOverwrite(subscriptionConfig, overwriteFiles);

  if (overwriteFiles.length > 0) {
    excludeOverwriteProxiesFromIncludeAll(withOverwrites, overwriteFiles);
  }

  const systemConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(BASE_CONFIG)) {
    if (!(key in withOverwrites)) {
      systemConfig[key] = value;
    }
  }

  // 系统锁定项：controller/端口固定是 UI、热重载、测速的统一依赖地址；secret 仅取自用户设置。
  // allow-lan 不锁定——订阅/覆写显式提供时按其值（见入站需求），未提供时由上面的 BASE_CONFIG 循环兜底为 false。
  systemConfig['external-controller'] = BASE_CONFIG['external-controller'];
  systemConfig['mixed-port'] = BASE_CONFIG['mixed-port'];
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
    const subDns = (withOverwrites.dns || {}) as Record<string, unknown>;
    const dns: Record<string, unknown> = {};
    if (!('enable' in subDns)) dns.enable = true;
    if (!('enhanced-mode' in subDns)) dns['enhanced-mode'] = 'fake-ip';
    if (!('fake-ip-range' in subDns)) dns['fake-ip-range'] = '198.18.0.1/16';
    if (Object.keys(dns).length > 0) {
      systemConfig.dns = dns;
    }
  } else {
    // Mixed 模式（含保活）不保留订阅/覆写自带的 tun 字段，避免未要求 TUN 却被静默按 TUN 启动
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

  const warnings = validateConfig(merged);

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
      mode: (cfg.mode as string) || 'rule',
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
