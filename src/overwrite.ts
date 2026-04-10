import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';
import { USER_DATA_DIR } from './paths.js';
import { readSettings, writeSettings } from './settings.js';
import type { OverwriteFileEntry, OverwriteListResult, ParsedOverrideKey } from './types.js';

function parseOverrideKey(key: string): ParsedOverrideKey {
  let actualKey = key;
  let forceOverwrite = false;
  let arrayPrepend = false;
  let arrayAppend = false;

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

  return { key: actualKey, forceOverwrite, arrayPrepend, arrayAppend };
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
    const { key, forceOverwrite, arrayPrepend, arrayAppend } = parseOverrideKey(rawKey);

    const existingValue = result[key];

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

export function loadOverwriteFile(): OverwriteFileEntry[] {
  const dir = USER_DATA_DIR;

  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter(f => f === 'overwrite.yaml' || /^overwrite\..+\.ya?ml$/.test(f))
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
      const parsed = yaml.load(content) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        results.push({ name: file, path: filePath, config: parsed });
      }
    } catch (e) {
      console.warn(`警告: 覆写文件 "${file}" 解析失败: ${(e as Error).message}`);
    }
  }

  return results;
}

export function applyOverwrite(baseConfig: Record<string, unknown>): Record<string, unknown> {
  if (!isOverwriteEnabled()) return baseConfig;

  const overwriteFiles = loadOverwriteFile();
  if (overwriteFiles.length === 0) return baseConfig;

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
    })),
  };
}
