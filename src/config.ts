import { execSync } from 'node:child_process';
import fs from 'node:fs';

import yaml from 'js-yaml';
import { BASE_CONFIG, TUN_CONFIG } from './constants.js';
import { applyOverwrite, isOverwriteEnabled, loadOverwriteFile } from './overwrite.js';
import { ensureDirs, PATHS } from './paths.js';
import type { BuildConfigResult, ConfigInfo } from './types.js';

export function parseYamlOrJson(content: string, errorMsg?: string): Record<string, unknown> {
  if (!content?.trim()) {
    throw new Error(`${errorMsg || '内容'}为空`);
  }
  try {
    const result = yaml.load(content);
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

function collectOverwriteProxyNames(overwriteFiles: { config: Record<string, unknown> }[]): string[] {
  const names: string[] = [];
  for (const file of overwriteFiles) {
    for (const [key, value] of Object.entries(file.config)) {
      if ((key === '+proxies' || key === 'proxies+') && Array.isArray(value)) {
        for (const proxy of value) {
          if (proxy && typeof proxy === 'object' && 'name' in proxy) {
            names.push((proxy as { name: string }).name);
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

  const excludePattern = injectedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

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

export function buildConfig(subRawContent: string, mode: string): BuildConfigResult {
  const subscriptionConfig = parseYamlOrJson(subRawContent, '订阅内容');

  if (!subscriptionConfig) {
    throw new Error('订阅内容为空');
  }

  const overwriteEnabled = isOverwriteEnabled();
  const overwriteFiles = overwriteEnabled ? loadOverwriteFile() : [];
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

  systemConfig['allow-lan'] = false;
  systemConfig['external-controller'] = BASE_CONFIG['external-controller'];
  systemConfig['mixed-port'] = BASE_CONFIG['mixed-port'];
  delete withOverwrites['mixed-port'];
  delete withOverwrites.port;
  delete withOverwrites['socks-port'];
  delete withOverwrites['external-ui'];
  delete withOverwrites['external-ui-name'];
  delete withOverwrites['external-ui-url'];

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

  return { config: merged, subscriptionConfig, overwriteFiles, systemConfig };
}

export function writeMihomoConfig(configObj: Record<string, unknown>): void {
  ensureDirs();
  const content = yaml.dump(configObj, { indent: 2, lineWidth: -1, noCompatMode: true });
  fs.writeFileSync(PATHS.configFile, content, { mode: 0o600 });
}

export function writeDebugConfig(buildResult: BuildConfigResult): void {
  ensureDirs();
  const dumpOpts = { indent: 2, lineWidth: -1, noCompatMode: true };

  fs.writeFileSync(PATHS.configStage1Subscription, yaml.dump(buildResult.subscriptionConfig, dumpOpts), { mode: 0o600 });

  const overwriteMerged: Record<string, unknown> = {};
  for (const f of buildResult.overwriteFiles) {
    Object.assign(overwriteMerged, f.config);
  }
  const overwriteContent = buildResult.overwriteFiles.length > 0 ? yaml.dump(overwriteMerged, dumpOpts) : '# overwrite 已禁用或无覆写文件\n';
  fs.writeFileSync(PATHS.configStage2Overwrite, overwriteContent, { mode: 0o600 });

  fs.writeFileSync(PATHS.configStage3System, yaml.dump(buildResult.systemConfig, dumpOpts), { mode: 0o600 });
}

export function hasConfig(): boolean {
  return fs.existsSync(PATHS.configFile);
}

export function getConfigInfo(): ConfigInfo | null {
  if (!hasConfig()) return null;

  try {
    const content = fs.readFileSync(PATHS.configFile, 'utf8');
    const cfg = yaml.load(content) as Record<string, unknown> | null;
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
    const output = execSync(`"${PATHS.mihomoBinary}" -v 2>&1 || true`, { encoding: 'utf8' }).trim();
    if (output) {
      const match = output.match(/v?[\d]+\.[\d]+\.[\d]+/);
      kernelVersionCache = match ? match[0] : output;
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
