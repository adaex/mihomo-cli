// 内置模块
const fs = require('fs');
const path = require('path');

// 第三方模块
const yaml = require('js-yaml');

// 本地模块
const config = require('./config');

/**
 * 解析覆写键名
 * 支持的格式：
 * - key!           → 强制覆盖整个对象
 * - +key           → 数组前置插入
 * - key+           → 数组追加
 * - <+key>         → 实际键名是 +key（当键名以 + 开头/结尾时）
 * - +<+key>        → 为键名 +key 执行前置插入
 * - <+key>+        → 为键名 +key 执行追加
 *
 * 返回: { key: string, forceOverwrite: boolean, arrayPrepend: boolean, arrayAppend: boolean }
 */
function parseOverrideKey(key) {
  let actualKey = key;
  let forceOverwrite = false;
  let arrayPrepend = false;
  let arrayAppend = false;

  // 1. 检查强制覆盖标记 (! 后缀，不在 <> 内时)
  // 只有当 ! 是最后一个字符，且前面没有未闭合的 < 时才是标记
  const lastChar = key[key.length - 1];
  const openAngleCount = (key.match(/</g) || []).length;
  const closeAngleCount = (key.match(/>/g) || []).length;

  if (lastChar === '!' && openAngleCount === closeAngleCount) {
    forceOverwrite = true;
    actualKey = key.slice(0, -1);
  }

  // 2. 解析 <> 包裹的键名和 + 操作符
  // 支持的模式：
  // +<key>   → prepend, key
  // <key>+   → append, key
  // <+key>   → 无操作, 实际键名是 +key
  // +<+key>  → prepend, 实际键名是 +key
  // <+key>+  → append, 实际键名是 +key

  const wrappedMatch = actualKey.match(/^(\+)?(<[^>]+>)(\+)?$/);
  if (wrappedMatch) {
    const prefixPlus = wrappedMatch[1] === '+';
    const wrappedPart = wrappedMatch[2];
    const suffixPlus = wrappedMatch[3] === '+';

    // 提取 <> 内的内容作为实际键名
    const unwrapped = wrappedPart.slice(1, -1);

    if (prefixPlus || suffixPlus) {
      // 有 + 操作符，<> 内是实际键名
      actualKey = unwrapped;
      if (prefixPlus) arrayPrepend = true;
      if (suffixPlus) arrayAppend = true;
    } else {
      // 没有 + 操作符，<key> 形式本身就是为了表示键名含特殊字符
      // 这种情况下不需要额外处理，actualKey 已经是 wrappedPart，但我们需要 unwrap
      // 例如：<+.google.cn> 的实际键名就是 +.google.cn
      actualKey = unwrapped;
    }
  } else {
    // 没有被 <> 完整包裹，检查开头和结尾的 +
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

/**
 * 深度合并带覆写规则
 */
function deepMergeWithOverrides(target, override) {
  if (target === null || target === undefined) {
    target = Array.isArray(override) ? [] : {};
  }

  if (override === null || override === undefined) {
    return target;
  }

  // 如果 override 不是对象，直接返回 override（覆盖）
  if (typeof override !== 'object') {
    return override;
  }

  // 如果 override 是数组，target 也必须是数组
  if (Array.isArray(override)) {
    return override;
  }

  // 此时 override 是普通对象

  const result = { ...target };

  for (const [rawKey, value] of Object.entries(override)) {
    const { key, forceOverwrite, arrayPrepend, arrayAppend } = parseOverrideKey(rawKey);

    const existingValue = result[key];

    // 处理数组操作
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

    // 处理强制覆盖
    if (forceOverwrite) {
      result[key] = value;
      continue;
    }

    // 递归合并对象
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existingValue !== null &&
      typeof existingValue === 'object' &&
      !Array.isArray(existingValue)
    ) {
      result[key] = deepMergeWithOverrides(existingValue, value);
      continue;
    }

    // 其他情况直接覆盖
    result[key] = value;
  }

  return result;
}

/**
 * 检查覆写功能是否启用
 */
function isOverwriteEnabled() {
  const settings = config.readSettings();
  return settings.overwrite_enabled !== false; // 默认启用
}

/**
 * 启用/禁用覆写功能
 */
function setOverwriteEnabled(enabled) {
  config.writeSettings({ overwrite_enabled: enabled });
}

/**
 * 读取根目录下的覆写文件
 * 匹配 overwrite.yaml 和 overwrite.*.yaml，按文件名排序
 * overwrite.yaml 始终第一
 */
function loadOverwriteFile() {
  const dir = config.USER_DATA_DIR;

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs
    .readdirSync(dir)
    .filter(f => f === 'overwrite.yaml' || /^overwrite\..+\.ya?ml$/.test(f))
    .sort((a, b) => {
      if (a === 'overwrite.yaml') return -1;
      if (b === 'overwrite.yaml') return 1;
      return a.localeCompare(b);
    });

  const results = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = yaml.load(content);
      if (parsed && typeof parsed === 'object') {
        results.push({
          name: file,
          path: filePath,
          config: parsed,
        });
      }
    } catch (e) {
      console.warn('警告: 覆写文件 "' + file + '" 解析失败: ' + e.message);
    }
  }

  return results;
}

/**
 * 应用所有覆写配置到基础配置
 */
function applyOverwrite(baseConfig) {
  if (!isOverwriteEnabled()) {
    return baseConfig;
  }

  const overwriteFiles = loadOverwriteFile();

  if (overwriteFiles.length === 0) {
    return baseConfig;
  }

  let result = { ...baseConfig };

  for (const file of overwriteFiles) {
    result = deepMergeWithOverrides(result, file.config);
  }

  return result;
}

/**
 * 列出覆写文件信息
 */
function listOverwriteFile() {
  const files = loadOverwriteFile();
  const enabled = isOverwriteEnabled();

  return {
    enabled,
    dir: config.USER_DATA_DIR,
    files: files.map(f => ({
      name: f.name,
      path: f.path,
      keys: Object.keys(f.config || {}),
    })),
  };
}

module.exports = {
  isOverwriteEnabled,
  setOverwriteEnabled,
  applyOverwrite,
  listOverwriteFile,
  loadOverwriteFile,
};
