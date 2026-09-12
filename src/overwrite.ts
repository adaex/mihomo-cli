import fs from 'node:fs';
import path from 'node:path';

import * as yaml from 'js-yaml';
import { CliError } from './errors.js';
import { USER_DATA_DIR } from './paths.js';
import { readSettings, writeSettings } from './settings.js';
import type { OperatorShapedKey, OverwriteFileEntry, OverwriteListResult, OverwriteMatch, OverwriteScope, ParsedOverrideKey, SkippedMerge } from './types.js';

export function parseOverrideKey(key: string): ParsedOverrideKey {
  let actualKey = key;
  let forceOverwrite = false;
  let arrayPrepend = false;
  let arrayAppend = false;
  let arrayMergeByName = false;
  let arrayMergeOnly = false;

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
    // `~?key`：匹配不到同名元素就忽略该补丁，不追加。放在剥掉 `~` 之后判断，
    // 故真以 `?` 开头的键名仍可用 `<~?key>` 转义（走上面的尖括号分支，不进这里）
    if (actualKey.startsWith('?')) {
      arrayMergeOnly = true;
      actualKey = actualKey.slice(1);
    }
    // `~<key>` / `~?<key>`：操作符与尖括号转义的组合。解包必须在剥掉 `~`/`?` 之后
    // 再试一次——此前只在剥 `~` 之前匹配过，`~<weird>` 会残留尖括号成键名 `<weird>`，
    // 与 `+<+dns>` / `<+dns>+` / `<+dns>!` 的组合形态不自洽
    if (/^<[^>]+>$/.test(actualKey)) {
      actualKey = actualKey.slice(1, -1);
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

  return { key: actualKey, forceOverwrite, arrayPrepend, arrayAppend, arrayMergeByName, arrayMergeOnly };
}

/**
 * 深度合并覆写到目标配置（顶层入口：DSL 操作符**只在本层解析**）。
 *
 * `skipped` 是可选的收集器：`~?key` 匹配不到同名元素时把跳过的项记进去，由调用方
 * （applyOverwrite → buildConfig）汇总成告警。用出参而非改返回类型——合并会递归进
 * 嵌套映射，改成返回 `{result, skipped}` 会让每个递归点都得拆包再合并。
 * 嵌套层形似操作符键的告警同理走 applyOverwrite（其内部直接调 mergeConfigLevel，
 * 每文件各建一份收集器）；本入口仅供单次合并与测试使用，不收集该类告警。
 */
export function deepMergeWithOverrides(target: unknown, override: unknown, skipped?: SkippedMerge[]): Record<string, unknown> {
  return mergeConfigLevel(target, override, { skipped: skipped ?? [], operatorShapedKeys: [] }, true);
}

/**
 * 单层合并。`parseOperators` 仅顶层（覆写文件直接键）为 true，递归点一律传 false：
 *
 * 嵌套层的键**按字面处理**，`+x`/`~x`/`x!`/`x+`/`<x>` 不再是操作符。此前内层键随
 * 订阅形态漂移——目标已有同名映射时递归进下一层、内层键继续被当 DSL 解析，mihomo
 * 原生通配键（如 nameserver-policy/hosts 的 `+.corp.example.com`）会被剥成
 * `.corp.example.com` 并把标量包成数组，`-t` 照样通过、通配匹配静默失效；目标没有
 * 该键时整棵值移植、内层键又是字面。同一文件在不同订阅上行为不同不可接受，故收口
 * 为「字面」，与移植路径一致、语义可预测。嵌套数组要改就写全量值（整组覆盖）。
 *
 * 字面层形似操作符的键（不太可能是 mihomo 原生键的形态）记入 operatorShapedKeys，
 * 由 applyOverwrite → buildConfig 汇总成告警，每文件每键只记一次。
 */
function mergeConfigLevel(target: unknown, override: unknown, collectors: MergeCollectors, parseOperators: boolean): Record<string, unknown> {
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
    let key = rawKey;
    let forceOverwrite = false;
    let arrayPrepend = false;
    let arrayAppend = false;
    let arrayMergeByName = false;
    let arrayMergeOnly = false;

    if (parseOperators) {
      ({ key, forceOverwrite, arrayPrepend, arrayAppend, arrayMergeByName, arrayMergeOnly } = parseOverrideKey(rawKey));
    } else if (isOperatorShapedNestedKey(rawKey)) {
      noteOperatorShapedKey(collectors, rawKey);
    }

    const existingValue = result[key];

    if (arrayMergeByName) {
      // ~key 只对「按 name 索引的数组」有意义。目标已存在且不是数组时，此前会静默包成
      // 单元素数组（`~dns: {enable: true}` 把映射 dns 变成 [{enable:true}]，丢掉原有字段，
      // 且 mihomo 要求 dns 是映射 → 生成非法配置）。改为报错，避免静默损坏。
      // 目标不存在（undefined）时放行：那是「新增数组」的正常用法。
      if (existingValue !== undefined && !Array.isArray(existingValue)) {
        throw new CliError(
          `覆写键 "${rawKey}" 的 ~ 语义只适用于数组，但 "${key}" 当前是${existingValue === null ? ' null' : typeof existingValue === 'object' ? '映射' : `标量（${typeof existingValue}）`}`,
          {
            label: '覆写配置错误',
            hint: [
              `~${key} 用于按 name 就地合并数组元素（如 ~proxy-groups）。`,
              `若要覆盖非数组的 ${key}，请用 ${key}!（强制覆盖）或直接写 ${key}（深度合并）。`,
            ],
          },
        );
      }
      // 按 name 就地 patch：在已有数组里找同名元素只合并其字段（保留其余字段与其余元素）。
      // 找不到同名时：`~key` 追加（ssh 出口靠它新增节点），`~?key` 跳过并告警。
      // 必须复制数组，禁止原地改写 target（否则会污染 subscriptionConfig）。
      const existingArr = Array.isArray(existingValue) ? existingValue : [];
      const overrideArr = Array.isArray(value) ? value : [value];
      const merged = [...existingArr];
      for (const item of overrideArr) {
        const name = item && typeof item === 'object' && !Array.isArray(item) ? (item as { name?: unknown }).name : undefined;
        const idx = name != null ? merged.findIndex(e => e && typeof e === 'object' && (e as { name?: unknown }).name === name) : -1;
        if (idx >= 0) {
          // 元素字段同属嵌套层：字面合并（`~key` 本身是顶层操作符，补丁字段不是）
          merged[idx] = mergeConfigLevel(merged[idx], item, collectors, false);
        } else if (arrayMergeOnly) {
          // 静默跳过会变成「写了覆写却没生效」，与分组名拼错难以区分，故记一条供调用方告警
          collectors.skipped.push({ key, name: name == null ? '(无 name)' : String(name) });
        } else {
          merged.push(item);
        }
      }
      result[key] = merged;
      continue;
    }

    if (arrayPrepend || arrayAppend) {
      // 同 ~key：+key/key+ 是数组拼接语义，目标已存在且非数组时报错而非静默包成数组
      // （`log-level+: debug` 曾把字符串 log-level 变成 ["debug"]，mihomo 无法解析）
      if (existingValue !== undefined && !Array.isArray(existingValue)) {
        throw new CliError(
          `覆写键 "${rawKey}" 的数组拼接语义只适用于数组，但 "${key}" 当前是${existingValue === null ? ' null' : typeof existingValue === 'object' ? '映射' : `标量（${typeof existingValue}）`}`,
          {
            label: '覆写配置错误',
            hint: [`+${key} / ${key}+ 用于向数组前置/追加元素（如 rules+）。`, `若要替换非数组的 ${key}，请直接写 ${key}: <值>。`],
          },
        );
      }
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
      // 目标已有同名映射 → 逐键深度合并（deep merge 语义不变），进入字面层
      result[key] = mergeConfigLevel(existingValue as Record<string, unknown>, value, collectors, false);
      continue;
    }

    result[key] = value;
  }

  return result;
}

/** 合并过程中的告警收集器（出参模式，理由见 deepMergeWithOverrides 注释）。 */
interface MergeCollectors {
  /** `~?key` 未命中同名元素而跳过的补丁 */
  skipped: SkippedMerge[];
  /** 嵌套层形似操作符、已按字面处理的键（每文件每键一次，applyOverwrite 按文件各建一份） */
  operatorShapedKeys: OperatorShapedKey[];
}

/**
 * 嵌套层「形似操作符」的键：只挑不太可能是 mihomo 原生键的形态——`~x`/`~?x`、`x!`、
 * `x+`、`<...>` 尖括号包裹、`+x`。`+.` 开头除外：那是 nameserver-policy/hosts 等
 * 原生通配域名的常见形态，对它告警只会骚扰合法写法。命中仅用于提示，键一律按字面处理。
 */
function isOperatorShapedNestedKey(key: string): boolean {
  if (key.startsWith('+.')) return false;
  return key.startsWith('~') || key.startsWith('+') || key.endsWith('!') || key.endsWith('+') || /^<[^>]+>$/.test(key);
}

/** 记一条字面层形似操作符的键，同一文件内每键只记一次（同一键出现在多个嵌套映射不刷屏）。 */
function noteOperatorShapedKey(collectors: MergeCollectors, key: string): void {
  if (collectors.operatorShapedKeys.some(note => note.key === key)) return;
  collectors.operatorShapedKeys.push({ key });
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

/**
 * 判断文件名是否「形似覆写文件却不被 isOverwriteFilename 认」（整体近失）。
 * 只认小写化后与某个合法形态完全一致、仅大小写或主文件扩展名不同的名字——最典型是
 * `overwrite.yml`（主文件只认 .yaml；.yml 只在扩展文件 `overwrite.*.yml` 形态下合法）。
 * 误报零容忍：宁可漏报（overwrit.yaml、overwrite.json、overwrite.yaml.bak 这类
 * 故意改名或意图不明的文件），也不把用户目录里自己的无关文件报出来。
 */
function isOverwriteFilenameTypo(filename: string): boolean {
  if (isOverwriteFilename(filename)) return false;
  const lower = filename.toLowerCase();
  // 大小写变体（如 Overwrite.YAML）在大小写不敏感的 APFS 上与合法名同名，
  // 但 readdirSync 返回的是存储大小写、按原样匹配不上，同样静默不加载
  return lower === 'overwrite.yml' || lower === 'overwrite.yaml' || /^overwrite\..+\.ya?ml$/.test(lower);
}

/** match 块支持的匹配键（作用域限定）。 */
const MATCH_KEYS = new Set(['subscription', 'url-domain']);

/**
 * 校验并规整 match 块。仅接受对象；每个键值收敛为 string[]。
 * 返回 undefined 表示无 match 块（默认全局生效）。
 *
 * **fail closed**：match 块存在（哪怕写错）而解析不出任何有效条件时抛错，
 * 不能静默降级成「全局生效」——用户写了 match 显然想限定作用域，键名打错
 * （`subscripton:`）或值全被滤空（`subscription: []`）后文件反而应用到**所有**订阅，
 * 是比「报错挡住启动」严重得多的静默失效。运行时侧的 matchesScope 同为 fail-closed
 * （scope 缺字段则不应用），此处把加载侧补齐。
 */
export function normalizeMatch(raw: unknown, fileName: string): OverwriteMatch | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`覆写文件 "${fileName}" 的 match 必须是对象（subscription / url-domain）`, { label: '覆写配置错误' });
  }

  const result: OverwriteMatch = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!MATCH_KEYS.has(key)) {
      problems.push(`未知键 "${key}"`);
      continue;
    }
    const arr = (Array.isArray(value) ? value : [value]).filter(v => typeof v === 'string' && v.length > 0) as string[];
    if (arr.length === 0) {
      problems.push(`键 "${key}" 的值为空或无有效字符串`);
      continue;
    }
    (result as Record<string, string[]>)[key] = arr;
  }

  if (problems.length > 0) {
    throw new CliError(`覆写文件 "${fileName}" 的 match 存在无效条件: ${problems.join('、')}`, {
      label: '覆写配置错误',
      hint: [
        'match 写错时该文件不会限定作用域、而是对所有订阅生效，故直接报错而非忽略。',
        `可用键: ${[...MATCH_KEYS].join(', ')}`,
        '示例: match: {subscription: work} 或 match: {url-domain: [corp.com, github.com]}',
      ],
    });
  }

  if (Object.keys(result).length === 0) {
    // 空 match 块：matchesScope 对空条件恒真（= 全局生效），同样必须挡下
    throw new CliError(`覆写文件 "${fileName}" 的 match 为空（没有任何条件）`, {
      label: '覆写配置错误',
      hint: [`可用键: ${[...MATCH_KEYS].join(', ')}`, '示例: match: {subscription: work}'],
    });
  }

  return result;
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

/**
 * 一行描述某个覆写文件「叫什么、管哪些订阅」，供内核校验失败时列出生效覆写。
 * 无 match 显式写成「全局」而非留空：这里是错误诊断，读者要判断「这个文件为什么会
 * 作用到当前订阅」，`ow list` 那种「没作用域就不打印该行」的省略在此会让人以为漏了信息。
 * 「全局」与 CLAUDE.md「无 match 全局应用」同一措辞。
 */
export function describeOverwriteScope(file: OverwriteFileEntry): string {
  return `${file.name} (${summarizeMatch(file.match) ?? '全局'})`;
}

/** hostname 后缀匹配：host 完全等于 domain，或为其子域（.domain 结尾）。 */
function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * 判断单个覆写文件在给定作用域下是否应用。
 * - 无 match → 默认全局应用。
 * - 有 match → 所列条件全部满足（AND）；条件值数组内为 OR。
 * - fail closed：scope 缺少评估该条件所需字段时，该文件不应用。
 */
function matchesScope(match: OverwriteMatch | undefined, scope?: OverwriteScope): boolean {
  if (!match) return true;

  if (match.subscription) {
    const names = Array.isArray(match.subscription) ? match.subscription : [match.subscription];
    // 大小写不敏感：与 findSubscriptionFuzzy（sub use/test/... 的解析口径）一致。
    // 订阅名允许大写（SAFE_NAME_RE 含 \w），此前精确比对会让 `match: {subscription: home}`
    // 匹配不上订阅 Home，而 `sub use home` 却能切过去——同一名称两套规则，是配置陷阱
    if (!scope?.subName) return false;
    const subName = scope.subName.toLowerCase();
    if (!names.some(n => n.toLowerCase() === subName)) return false;
  }

  if (match['url-domain']) {
    const domains = Array.isArray(match['url-domain']) ? match['url-domain'] : [match['url-domain']];
    if (!scope?.subUrl) return false;
    let host: string;
    try {
      host = new URL(scope.subUrl.trim()).hostname;
    } catch {
      return false; // 非法 URL：fail closed，该文件不应用
    }
    if (!domains.some(d => hostMatchesDomain(host, d))) return false;
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

  const entries = fs.readdirSync(dir);
  const files = entries.filter(isOverwriteFilename).sort((a, b) => {
    if (a === 'overwrite.yaml') return -1;
    if (b === 'overwrite.yaml') return 1;
    return a.localeCompare(b);
  });

  // 近失文件名：意图明显是覆写文件却不被任何合法模式认（最典型：主文件写成 overwrite.yml）。
  // 静默不加载 = 用户以为覆写生效了、`ow` 列表里也看不见，故打一行警告；与解析失败
  // 共用同一出口。只认整体近失（见 isOverwriteFilenameTypo），不扫全部「形近」文件
  for (const typo of entries.filter(e => isOverwriteFilenameTypo(e))) {
    console.warn(
      `警告: "${typo}" 不会被当作覆写文件加载（合法文件名: overwrite.yaml 主文件、overwrite.*.yaml / overwrite.*.yml 扩展文件；主文件不支持 .yml）；若是笔误请改名`,
    );
  }

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
      // normalizeMatch 抛的 CliError 必须上抛到 main().catch 统一渲染：
      // 吞成 warn + 跳过文件虽然也是 fail-closed，但用户只看到一行「解析失败」，
      // 看不见哪个键错了、该怎么改
      if (e instanceof CliError) throw e;
      console.warn(`警告: 覆写文件 "${file}" 解析失败: ${(e as Error).message}`);
    }
  }

  return results;
}

/**
 * 应用已按开关与作用域筛选的覆写；不额外读取设置或改变节点池。
 *
 * 告警出参两个，均带文件名、供调用方（buildConfig → warnings）汇总：
 * - `skipped`：`~?key` 因匹配不到同名元素而跳过的补丁——静默跳过与「分组名拼错」
 *   无法区分，用户会以为覆写生效了。
 * - `operatorShapedKeys`：嵌套层形似操作符、已按字面处理的键——大概率是把顶层
 *   语法写进了嵌套层（以为 `+`/`~` 会生效），每文件每键只记一次。
 */
export function applyOverwrite(
  baseConfig: Record<string, unknown>,
  files: OverwriteFileEntry[],
): { config: Record<string, unknown>; skipped: SkippedMerge[]; operatorShapedKeys: OperatorShapedKey[] } {
  let result = { ...baseConfig };
  const skipped: SkippedMerge[] = [];
  const operatorShapedKeys: OperatorShapedKey[] = [];
  for (const file of files) {
    const collectors: MergeCollectors = { skipped: [], operatorShapedKeys: [] };
    result = mergeConfigLevel(result, file.config, collectors, true);
    for (const s of collectors.skipped) skipped.push({ ...s, file: file.name });
    for (const k of collectors.operatorShapedKeys) operatorShapedKeys.push({ ...k, file: file.name });
  }
  return { config: result, skipped, operatorShapedKeys };
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
