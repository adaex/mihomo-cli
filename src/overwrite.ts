import fs from 'node:fs';
import path from 'node:path';

import * as yaml from 'js-yaml';
import { USER_DATA_DIR } from './paths.js';
import { readSettings, writeSettings } from './settings.js';
import type { OverwriteFileEntry, OverwriteListResult, OverwriteMatch, OverwriteScope, ParsedOverrideKey } from './types.js';

function parseOverrideKey(key: string): ParsedOverrideKey {
  let actualKey = key;
  let forceOverwrite = false;
  let arrayPrepend = false;
  let arrayAppend = false;
  let arrayMergeByName = false;

  const lastChar = key[key.length - 1];
  const openAngleCount = (key.match(/</g) || []).length;
  const closeAngleCount = (key.match(/>/g) || []).length;

  if (lastChar === '!' && openAngleCount === closeAngleCount) {
    forceOverwrite = true;
    actualKey = key.slice(0, -1);
  }

  const wrappedMatch = actualKey.match(/^(\+)?(<[^>]+>)(\+)?$/);
  if (wrappedMatch) {
    const prefixPlus = wrappedMatch[1] === '+';
    const wrappedPart = wrappedMatch[2];
    const suffixPlus = wrappedMatch[3] === '+';

    const unwrapped = wrappedPart.slice(1, -1);

    if (prefixPlus || suffixPlus) {
      actualKey = unwrapped;
      if (prefixPlus) arrayPrepend = true;
      if (suffixPlus) arrayAppend = true;
    } else {
      actualKey = unwrapped;
    }
  } else if (actualKey.startsWith('~')) {
    arrayMergeByName = true;
    actualKey = actualKey.slice(1);
  } else {
    if (actualKey.startsWith('+')) {
      arrayPrepend = true;
      actualKey = actualKey.slice(1);
    }
    if (actualKey.endsWith('+')) {
      arrayAppend = true;
      actualKey = actualKey.slice(0, -1);
    }
  }

  return { key: actualKey, forceOverwrite, arrayPrepend, arrayAppend, arrayMergeByName };
}

function deepMergeWithOverrides(target: unknown, override: unknown): Record<string, unknown> {
  let t = target as Record<string, unknown>;
  if (t === null || t === undefined) {
    t = Array.isArray(override) ? ([] as unknown as Record<string, unknown>) : {};
  }

  if (override === null || override === undefined) {
    return t;
  }

  if (typeof override !== 'object') {
    return override as Record<string, unknown>;
  }

  if (Array.isArray(override)) {
    return override as unknown as Record<string, unknown>;
  }

  const result = { ...t };

  for (const [rawKey, value] of Object.entries(override as Record<string, unknown>)) {
    const { key, forceOverwrite, arrayPrepend, arrayAppend, arrayMergeByName } = parseOverrideKey(rawKey);

    const existingValue = result[key];

    if (arrayMergeByName) {
      // 按 name 就地 patch：在已有数组里找同名元素只合并其字段（保留其余字段与其余元素），
      // 找不到同名则追加。必须复制数组，禁止原地改写 target（否则会污染 subscriptionConfig）。
      const existingArr = Array.isArray(existingValue) ? existingValue : [];
      const overrideArr = Array.isArray(value) ? value : [value];
      const merged = [...existingArr];
      for (const item of overrideArr) {
        const name = item && typeof item === 'object' && !Array.isArray(item) ? (item as { name?: unknown }).name : undefined;
        const idx = name != null ? merged.findIndex(e => e && typeof e === 'object' && (e as { name?: unknown }).name === name) : -1;
        if (idx >= 0) {
          merged[idx] = deepMergeWithOverrides(merged[idx], item);
        } else {
          merged.push(item);
        }
      }
      result[key] = merged;
      continue;
    }

    if (arrayPrepend || arrayAppend) {
      const existingArr = Array.isArray(existingValue) ? existingValue : [];
      const overrideArr = Array.isArray(value) ? value : [value];

      if (arrayPrepend) {
        result[key] = [...overrideArr, ...existingArr];
      } else {
        result[key] = [...existingArr, ...overrideArr];
      }
      continue;
    }

    if (forceOverwrite) {
      result[key] = value;
      continue;
    }

    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existingValue !== null &&
      typeof existingValue === 'object' &&
      !Array.isArray(existingValue)
    ) {
      result[key] = deepMergeWithOverrides(existingValue as Record<string, unknown>, value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

export function isOverwriteEnabled(): boolean {
  const settings = readSettings();
  return settings.overwrite_enabled !== false;
}

export function setOverwriteEnabled(enabled: boolean): void {
  writeSettings({ overwrite_enabled: enabled });
}

/** 判断文件名是否为覆写文件:主文件 overwrite.yaml 或扩展文件 overwrite.*.ya?ml。 */
export function isOverwriteFilename(filename: string): boolean {
  return filename === 'overwrite.yaml' || /^overwrite\..+\.ya?ml$/.test(filename);
}

/** match 块支持的匹配键（作用域限定），未知键会被拒绝并告警。 */
const MATCH_KEYS = new Set(['subscription', 'url-domain']);

/**
 * 校验并规整 match 块。仅接受对象；剔除未知键（告警）；每个键值收敛为 string[]。
 * 返回 null 表示无作用域限定（全局生效）。
 */
function normalizeMatch(raw: unknown, fileName: string): OverwriteMatch | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`警告: 覆写文件 "${fileName}" 的 match 必须是对象，已忽略作用域限定`);
    return undefined;
  }

  const result: OverwriteMatch = {};
  let hasValid = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!MATCH_KEYS.has(key)) {
      console.warn(`警告: 覆写文件 "${fileName}" 的 match 含未知键 "${key}"，已忽略`);
      continue;
    }
    const arr = (Array.isArray(value) ? value : [value]).filter(v => typeof v === 'string' && v.length > 0) as string[];
    if (arr.length === 0) continue;
    (result as Record<string, string[]>)[key] = arr;
    hasValid = true;
  }

  return hasValid ? result : undefined;
}

/** 一行摘要 match 作用域，供 `ow list` 展示；无限定返回 undefined。 */
function summarizeMatch(match?: OverwriteMatch): string | undefined {
  if (!match) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(match)) {
    const vals = Array.isArray(value) ? value : [value];
    parts.push(`${key}=${vals.join('/')}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** 拆分逗号分隔的多 URL（内联，避免依赖 subscription.ts 造成循环引用）。 */
function splitUrlsLocal(url: string): string[] {
  return url
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
}

/** hostname 后缀匹配：host 完全等于 domain，或为其子域（.domain 结尾）。 */
function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * 判断单个覆写文件在给定作用域下是否应用。
 * - 无 match → 全局应用（向后兼容）。
 * - 有 match → 所列条件全部满足（AND）；条件值数组内为 OR。
 * - fail closed：scope 缺少评估该条件所需字段时，该文件不应用。
 */
function matchesScope(match: OverwriteMatch | undefined, scope?: OverwriteScope): boolean {
  if (!match) return true;

  if (match.subscription) {
    const names = Array.isArray(match.subscription) ? match.subscription : [match.subscription];
    if (!scope?.subName || !names.includes(scope.subName)) return false;
  }

  if (match['url-domain']) {
    const domains = Array.isArray(match['url-domain']) ? match['url-domain'] : [match['url-domain']];
    if (!scope?.subUrl) return false;
    const hosts: string[] = [];
    for (const u of splitUrlsLocal(scope.subUrl)) {
      try {
        hosts.push(new URL(u).hostname);
      } catch {
        /* 非法 URL 跳过 */
      }
    }
    if (hosts.length === 0) return false;
    const ok = domains.some(d => hosts.some(h => hostMatchesDomain(h, d)));
    if (!ok) return false;
  }

  return true;
}

/** 按订阅作用域过滤覆写文件：保留 match 命中（或无 match）的文件。 */
export function filterOverwriteFilesByScope(files: OverwriteFileEntry[], scope?: OverwriteScope): OverwriteFileEntry[] {
  return files.filter(f => matchesScope(f.match, scope));
}

export function loadOverwriteFile(): OverwriteFileEntry[] {
  const dir = USER_DATA_DIR;

  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter(isOverwriteFilename)
    .sort((a, b) => {
      if (a === 'overwrite.yaml') return -1;
      if (b === 'overwrite.yaml') return 1;
      return a.localeCompare(b);
    });

  const results: OverwriteFileEntry[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      // 别名上限防 YAML 炸弹 DoS（同 config.ts SAFE_YAML_LOAD_OPTIONS，此处内联避免与 config 循环依赖）
      const parsed = yaml.load(content, { maxAliases: 200 }) as Record<string, unknown> | null;
      // 顶层数组/标量不是合法覆写文件（解构会得到数字键），直接跳过并告警
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // match 是元数据键：抽成结构化字段并从 config 剥离，确保它永不进入最终 mihomo 配置。
        const { match, ...config } = parsed;
        results.push({ name: file, path: filePath, config, match: normalizeMatch(match, file) });
      } else if (parsed !== null) {
        console.warn(`警告: 覆写文件 "${file}" 顶层必须是对象，已跳过`);
      }
    } catch (e) {
      console.warn(`警告: 覆写文件 "${file}" 解析失败: ${(e as Error).message}`);
    }
  }

  return results;
}

export function applyOverwrite(baseConfig: Record<string, unknown>, preloadedFiles?: OverwriteFileEntry[]): Record<string, unknown> {
  if (!isOverwriteEnabled()) return { ...baseConfig };

  const overwriteFiles = preloadedFiles || loadOverwriteFile();
  if (overwriteFiles.length === 0) return { ...baseConfig };

  // 恒返回浅拷贝：buildConfig 随后会 delete 端口/tun 等锁定键，
  // 直接返回 baseConfig 会污染订阅原始对象（debug stage1 也会随之失真）
  let result = { ...baseConfig };
  for (const file of overwriteFiles) {
    result = deepMergeWithOverrides(result, file.config);
  }
  return result;
}

export function listOverwriteFile(): OverwriteListResult {
  const files = loadOverwriteFile();
  const enabled = isOverwriteEnabled();

  return {
    enabled,
    dir: USER_DATA_DIR,
    files: files.map(f => ({
      name: f.name,
      path: f.path,
      keys: Object.keys(f.config || {}),
      scope: summarizeMatch(f.match),
    })),
  };
}
