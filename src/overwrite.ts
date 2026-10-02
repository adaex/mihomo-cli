import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import * as yaml from 'js-yaml';
import { BASE_CONFIG, LOCKED_CONFIG_KEYS, YAML_MAX_ALIASES } from './constants.js';
import { CliError } from './errors.js';
import { USER_DATA_DIR } from './paths.js';
import { readSettings, SAFE_NAME_RE, writeSettings } from './settings.js';
import type {
  BrokenOverwriteFile,
  OverwriteFileEntry,
  OverwriteListResult,
  OverwriteMatch,
  OverwriteScope,
  OverwriteScriptContext,
  OverwriteTransform,
  ParsedOverrideKey,
  ScriptMatch,
} from './types.js';

export function parseOverrideKey(key: string): ParsedOverrideKey {
  let actualKey = key;
  let forceOverwrite = false;
  let arrayPrepend = false;
  let arrayAppend = false;

  if (key.endsWith('!')) {
    forceOverwrite = true;
    actualKey = key.slice(0, -1);
  }
  if (actualKey.startsWith('+')) {
    arrayPrepend = true;
    actualKey = actualKey.slice(1);
  }
  if (actualKey.endsWith('+')) {
    arrayAppend = true;
    actualKey = actualKey.slice(0, -1);
  }

  return { key: actualKey, forceOverwrite, arrayPrepend, arrayAppend };
}

/**
 * 校验解析结果：操作符修饰互斥、键名非空、已移除的操作符形态显式报错。
 * 互斥组合（`+rules+`）解析器不报错、静默按分支处理，用户无法预期结果——矛盾输入一律显式报错。
 * 裸 `+:` / `!:` 解析出空键名，不能产出空字符串顶层键（内核静默忽略，笔误零反馈）。
 * `~`（按 name 合并）与 `<x>`（尖括号转义）已随 DSL 裁剪移除：没有专属报错的话，
 * 这两种老写法会被当**字面键名**静默落进配置（内核对未知顶层键宽容），老用户无从得知要迁移。
 */
function assertValidParsedKey(rawKey: string, parsed: ParsedOverrideKey): void {
  // 不只看 rawKey 开头：`+~rules` 的 ~ 被前缀 + 遮挡，剥完操作符后 parsed.key 仍是 ~rules
  if (rawKey.startsWith('~') || parsed.key.includes('~')) {
    throw new CliError(`覆写键 "${rawKey}" 用了已移除的 ~ 操作符`, {
      label: '覆写配置错误',
      hint: ['按 name 合并/追加数组元素的 ~ 与 ~? 已移除，改用 JS 覆写脚本（README「覆写配置」章节的脚本一节）。'],
    });
  }
  if (rawKey.includes('<') || rawKey.includes('>')) {
    throw new CliError(`覆写键 "${rawKey}" 用了已移除的尖括号转义`, {
      label: '覆写配置错误',
      hint: ['<key> 转义已随 ~ 操作符移除——mihomo-cli 顶层键不含尖括号，直接写键名即可。'],
    });
  }
  if (parsed.key === '') {
    throw new CliError(`覆写键名不能为空: "${rawKey}"`, {
      label: '覆写配置错误',
      hint: ['操作符（!、+）必须修饰一个真实的键名，如 rules+、dns!。'],
    });
  }
  // 剥完合法操作符后仍残留 `!`：解析顺序的漏网形态 `rules!+`（! 在末位 + 之前、没被识别），
  // 不能静默当字面键 rules!，矛盾输入与互斥组合同族
  if (parsed.key.includes('!')) {
    throw new CliError(`覆写键 "${rawKey}" 的操作符位置矛盾`, {
      label: '覆写配置错误',
      hint: ['整体覆盖的 ! 只能写在键名末尾、且不能与其他操作符同用（key!）。', '想向数组追加请只用 key+。'],
    });
  }
  const ops: string[] = [];
  if (parsed.forceOverwrite) ops.push('!（整体覆盖）');
  if (parsed.arrayPrepend) ops.push('+前缀（数组前插）');
  if (parsed.arrayAppend) ops.push('+后缀（数组追加）');
  if (ops.length > 1) {
    throw new CliError(`覆写键 "${rawKey}" 含互斥的操作符: ${ops.join(' 与 ')}`, {
      label: '覆写配置错误',
      hint: ['一个键只能使用一种操作符：整体覆盖 key!、数组前插 +key、数组追加 key+。'],
    });
  }
}

/**
 * 数组拼接误用报错里的目标值类型描述。文件级（BASE_CONFIG 默认值）与合并级
 * （订阅/前序覆写写入的现值）两处检查共用——各写一份会漂移出两种报错口径
 */
function describeValueKind(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return '映射';
  return `标量（${typeof value}）`;
}

/** `__proto__` 键错误：文件级校验与合并期检查共用一份，两处口径不许漂移 */
function protoKeyInOverwriteError(): CliError {
  return new CliError('覆写里出现了 "__proto__" 键', {
    label: '覆写配置错误',
    hint: ['正常 mihomo-cli 配置没有这个键，请检查覆写文件的内容与来源。'],
  });
}

/**
 * 单层合并。`parseOperators` 仅顶层（覆写文件直接键）为 true，递归点一律传 false：
 * 嵌套层的键**按字面处理**（`+x`/`x!`/`x+` 不再是操作符），语义可预测——内层键若随
 * 操作符解析，mihomo 原生通配键（如 nameserver-policy 的 `+.corp.example.com`）
 * 会被剥成 `.corp.example.com`，通配匹配静默失效。嵌套数组要改就写全量值（整组覆盖）。
 */
function mergeConfigLevel(target: unknown, override: unknown, parseOperators: boolean): Record<string, unknown> {
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

    if (parseOperators) {
      ({ key, forceOverwrite, arrayPrepend, arrayAppend } = parseOverrideKey(rawKey));
      assertValidParsedKey(rawKey, { key, forceOverwrite, arrayPrepend, arrayAppend });
    }

    // `__proto__` 键在对象字面赋值（下方所有 result[key] = ...）里走的是原型 setter
    // 而非建键：合并结果的原型被静默换掉，随后 dumpYaml 抛裸异常按程序 bug 渲染
    // （实测：`dns: {__proto__: {evil: true}, enable: true}` 覆写进任何带 dns 的订阅即炸），
    // 用户无从知道源头是覆写。在操作符解析之后拦，顺带覆盖 `__proto__!` 等操作符形态。
    // 订阅侧解析出的 own `__proto__` 不经本函数（无赋值动作），原样透传、内核按未知键忽略
    if (key === '__proto__') {
      throw protoKeyInOverwriteError();
    }

    const existingValue = result[key];

    if (arrayPrepend || arrayAppend) {
      // +key/key+ 是数组拼接语义，目标已存在且非数组时报错而非静默包成数组
      // （`log-level+: debug` 会把字符串 log-level 变成 ["debug"]，mihomo-cli 无法解析）。
      // 这里判的是**合并期才看得见的目标值**：订阅自带的同键标量、前一个覆写文件
      // 刚写入的非数组值。系统默认值（BASE_CONFIG）里的非数组键在文件加载阶段由
      // assertFileLevelOperatorRules 静态拦截——BASE_CONFIG 在合并之后才注入，
      // 这里读不到它
      if (existingValue !== undefined && !Array.isArray(existingValue)) {
        throw new CliError(`覆写键 "${rawKey}" 的数组拼接语义只适用于数组，但 "${key}" 当前是 ${describeValueKind(existingValue)}`, {
          label: '覆写配置错误',
          hint: [`+${key} / ${key}+ 用于向数组前置/追加元素（如 rules+）。`, `若要替换非数组的 ${key}，请直接写 ${key}: <值>。`],
        });
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
      result[key] = mergeConfigLevel(existingValue as Record<string, unknown>, value, false);
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

/** 判断文件名是否为 YAML 覆写文件：主文件 overwrite.yaml 或扩展文件 overwrite.*.ya?ml。 */
function isYamlOverwriteFilename(filename: string): boolean {
  return filename === 'overwrite.yaml' || /^overwrite\..+\.ya?ml$/.test(filename);
}

/**
 * 判断文件名是否为 JS 覆写脚本：主脚本 overwrite.{js,mjs,cjs} 或扩展脚本
 * overwrite.*.{js,mjs,cjs}。三种主文件形态都认——只认 .js 的话，写 overwrite.mjs
 * 的用户会得到静默不加载（typo 检测也不覆盖），正是本仓要消灭的那类零提示失效。
 * .mjs/.cjs 显式声明模块格式；.js 在数据目录（无 package.json）下靠 Node 的模块语法
 * 探测判 ESM/CJS（本仓 Node 下界 22.22.1，探测自 22.7 起默认启用），两种写法都认。
 */
const SCRIPT_EXTENSIONS = ['js', 'mjs', 'cjs'] as const;
/** 主脚本文件名（overwrite.js / overwrite.mjs / overwrite.cjs），与 YAML 主文件同理最先加载 */
function isPrimaryScriptFilename(filename: string): boolean {
  return (SCRIPT_EXTENSIONS as readonly string[]).some(ext => filename === `overwrite.${ext}`);
}

function isScriptOverwriteFilename(filename: string): boolean {
  return isPrimaryScriptFilename(filename) || /^overwrite\..+\.(js|mjs|cjs)$/.test(filename);
}

/** 覆写文件 = YAML 声明式覆写 + JS 脚本两类；reset overwrites 等消费点据此枚举删除 */
export function isOverwriteFilename(filename: string): boolean {
  return isYamlOverwriteFilename(filename) || isScriptOverwriteFilename(filename);
}

/**
 * 判断文件名是否「形似覆写文件却不被 isOverwriteFilename 认」（整体近失）。
 * 只认小写化后与某个合法形态完全一致、仅大小写或主文件扩展名不同的名字——最典型是
 * `overwrite.yml`（主文件只认 .yaml；.yml 只在扩展文件 `overwrite.*.yml` 形态下合法）。
 * `.ts` 单列：TypeScript 脚本不能直接加载，静默跳过会让用户以为脚本生效了。
 * 误报零容忍：宁可漏报（overwrit.yaml、overwrite.json、overwrite.yaml.bak 这类
 * 故意改名或意图不明的文件），也不把用户目录里自己的无关文件报出来。
 */
function isOverwriteFilenameTypo(filename: string): boolean {
  if (isOverwriteFilename(filename)) return false;
  const lower = filename.toLowerCase();
  // 大小写变体（如 Overwrite.YAML）在大小写不敏感的 APFS 上与合法名同名，
  // 但 readdirSync 返回的是存储大小写、按原样匹配不上，同样静默不加载
  return (
    lower === 'overwrite.yml' ||
    lower === 'overwrite.yaml' ||
    /^overwrite\..+\.ya?ml$/.test(lower) ||
    lower === 'overwrite.ts' ||
    /^overwrite\..+\.ts$/.test(lower)
  );
}

/**
 * 数据目录里「形似覆写文件却不会被加载」的近失文件名（overwrite.yml、overwrite.ts、
 * 大小写变体）。加载时的警告与 reset overwrites 的残留提示共用这一个出口
 */
export function listTypoOverwriteFiles(): string[] {
  try {
    return fs.readdirSync(USER_DATA_DIR).filter(isOverwriteFilenameTypo);
  } catch {
    return [];
  }
}

/**
 * match 块支持的匹配键（作用域限定）。历史写法 `subscription` 已收掉（与 name 同义、
 * 两套写法留一套），写它直接报错指明改名。
 */
const MATCH_KEYS = new Set(['name', 'url-domain']);

/**
 * 校验并规整 match 块。仅接受对象；每个键值收敛为 string[]。
 * 返回 undefined 表示无 match 块（默认全局生效）。
 *
 * **fail closed**：match 块存在（哪怕写错）而解析不出任何有效条件时抛错，
 * 不能静默降级成「全局生效」——用户写了 match 显然想限定作用域，键名打错
 * （`subscripton:`）或值全被滤空（`name: []`）后文件反而应用到**所有**订阅，
 * 是比「报错挡住启动」严重得多的静默失效。运行时侧的 matchesScope 同为 fail-closed
 * （scope 缺字段则不应用），此处把加载侧补齐。
 */
export function normalizeMatch(raw: unknown, fileName: string): OverwriteMatch | undefined {
  // undefined = 没写 match 键，全局生效是文档承诺的默认行为。
  // null = **写了 `match:` 但值为空**——最常见成因是条件块缩进笔误（`match:` 下面的
  // `name: edu*` 顶了格，js-yaml 解析成 match: null + 顶层垃圾键）。与键名打错同族，
  // 按本函数 fail-closed 的承诺必须报错。YAML 层不会产出 undefined，两种形态天然可区分。
  if (raw === undefined) return undefined;
  if (raw === null) {
    throw new CliError(`覆写文件 "${fileName}" 的 match 为空`, {
      label: '覆写配置错误',
      hint: ['match: 后面要跟条件块（检查缩进），如:', '  match:', '    name: edu*'],
    });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`覆写文件 "${fileName}" 的 match 必须是对象（name / url-domain）`, { label: '覆写配置错误' });
  }

  const rawEntries = raw as Record<string, unknown>;
  if ('subscription' in rawEntries) {
    throw new CliError(`覆写文件 "${fileName}" 的 match 用了 subscription 键`, {
      label: '覆写配置错误',
      hint: ['subscription 键已收掉（与 name 同义但两套写法），请改写 name，匹配语义不变:', '  match:', '    name: edu*'],
    });
  }

  const result: OverwriteMatch = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(rawEntries)) {
    if (!MATCH_KEYS.has(key)) {
      problems.push(`未知键 "${key}"`);
      continue;
    }
    // 先 trim 再过滤：`" corp.com"` 不规整会在后缀比对里恒不命中
    const arr = (Array.isArray(value) ? value : [value])
      .map(v => (typeof v === 'string' ? v.trim() : v))
      .filter(v => typeof v === 'string' && v.length > 0) as string[];
    if (arr.length === 0) {
      problems.push(`键 "${key}" 的值为空或无有效字符串`);
      continue;
    }
    // url-domain 只做字面后缀比对——通配符、协议、路径、端口、空格都会让值恒不命中，
    // 文件静默对任何订阅都不生效，零提示的静默全不命中会被当成 bug，故显式报错
    if (key === 'url-domain') {
      const badEntry = arr.map(v => [v, urlDomainValueProblem(v)] as const).find(([, p]) => p !== undefined);
      if (badEntry) {
        problems.push(badEntry[1] as string);
        continue;
      }
    }
    if (key === 'name') {
      const badWildcard = arr.find(v => !isValidNamePattern(v));
      if (badWildcard !== undefined) {
        throw new CliError(`覆写文件 "${fileName}" 的 name 通配写法不支持: "${badWildcard}"`, {
          label: '覆写配置错误',
          hint: [
            '订阅名匹配只支持两种通配：尾部 *（前缀，edu* 命中 edu1、不命中 xedu1）与头部 *（后缀，*edu）。',
            '单独一个 * 等于不限订阅（恒真），请删掉 match；更复杂的匹配写 JS 覆写脚本（README「覆写配置」章节）。',
          ],
        });
      }
      // 无通配的精确值按订阅名字符集预检：`edu1/`、`~x` 不可能命中任何订阅
      const impossible = arr.find(v => !v.includes('*') && !SAFE_NAME_RE.test(v));
      if (impossible !== undefined) {
        throw new CliError(`覆写文件 "${fileName}" 的 name 值不可能匹配任何订阅: "${impossible}"`, {
          label: '覆写配置错误',
          hint: [
            '订阅名只能含字母数字、下划线、连字符与中文（1-64 字符），请检查是否误带了 /、~、空格、点号等字符。',
            '更复杂的匹配写 JS 覆写脚本（README「覆写配置」章节）。',
          ],
        });
      }
    }
    (result as Record<string, string[]>)[key] = arr;
  }

  if (problems.length > 0) {
    throw new CliError(`覆写文件 "${fileName}" 的 match 存在无效条件: ${problems.join('、')}`, {
      label: '覆写配置错误',
      hint: [
        'match 写错时该文件不会限定作用域、而是对所有订阅生效，故直接报错而非忽略。',
        `可用键: ${[...MATCH_KEYS].join(', ')}`,
        '示例: match: {name: edu*} 或 match: {url-domain: [corp.com, github.com]}',
      ],
    });
  }

  if (Object.keys(result).length === 0) {
    // 空 match 块：matchesScope 对空条件恒真（= 全局生效），同样必须挡下
    throw new CliError(`覆写文件 "${fileName}" 的 match 为空（没有任何条件）`, {
      label: '覆写配置错误',
      hint: [`可用键: ${[...MATCH_KEYS].join(', ')}`, '示例: match: {name: work}'],
    });
  }

  return result;
}

/**
 * name 值的合法通配形态：无 `*`（精确）、或恰好一个 `*` 且在最前/最后。
 * 单独一个 `*` 判非法——它等于恒真（不限订阅），与「写了 match 想限定作用域」的意图相反，
 * 与空 match 块报错是同一族判定。`?` 一律不支持（通用匹配器已删，见 nameMatchesPattern）。
 */
function isValidNamePattern(value: string): boolean {
  if (value === '*' || value.includes('?')) return false;
  const star = value.indexOf('*');
  if (star === -1) return true;
  if (value.indexOf('*', star + 1) !== -1) return false;
  return star === 0 || star === value.length - 1;
}

/**
 * 校验 url-domain 的单个值是否可能命中。返回 undefined 即合法。
 * 匹配是 hostname 对裸域名的字面后缀比对，故凡 hostname 中不可能出现、或根本不是
 * 裸域名的形态（从浏览器地址栏复制的完整 URL、尾斜杠、端口、内部空格）一律在加载
 * 期报错，不能让文件静默永不生效
 */
function urlDomainValueProblem(value: string): string | undefined {
  if (value.includes('*') || value.includes('?')) {
    return `url-domain 不支持通配符（当前值 "${value}"），只做字面后缀比对`;
  }
  if (/[:/]/.test(value)) {
    return `url-domain 只要裸域名（当前值 "${value}"）：不要带协议、路径或端口，请去掉 https://、尾斜杠与端口`;
  }
  if (/\s/.test(value)) {
    return `url-domain 只要裸域名（当前值 "${value}"）：值中不能含空格`;
  }
  return undefined;
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
 * 订阅名匹配：精确值、尾部单个 `*`（前缀 `edu*`）、头部单个 `*`（后缀 `*edu`），
 * 大小写不敏感（与 findSubscriptionFuzzy / `sub use` 口径一致——同一名称不能有两套
 * 匹配规则）。只做字面前缀/后缀比对、**无通用匹配器**：glob 转正则的实现曾在合法输入
 * 内灾难性回溯（`*a`×20 配 64 字符订阅名实测 70 秒，64 正是 SAFE_NAME_RE 的上限），
 * 而真实使用面只有前缀区分（同机场套餐系列 edu1/edu2）——复杂匹配走 JS 覆写脚本。
 * `edu*` 是全串前缀语义，不命中 `xedu1`（半匹配会让作用域悄悄放宽）。
 */
function nameMatchesPattern(name: string, pattern: string): boolean {
  const n = name.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*')) return n.endsWith(p.slice(1));
  if (p.endsWith('*')) return n.startsWith(p.slice(0, -1));
  return n === p;
}

/**
 * 判断单个覆写文件在给定作用域下是否应用。
 * - 无 match → 默认全局应用（JS 脚本无 match 机制，作用域判断写在脚本里）。
 * - 有 match → 所列条件全部满足（AND）；条件值数组内为 OR。
 * - fail closed：scope 缺少评估该条件所需字段时，该文件不应用。
 */
function matchesScope(match: OverwriteMatch | undefined, scope?: OverwriteScope): boolean {
  if (!match) return true;

  if (match.name) {
    const names = Array.isArray(match.name) ? match.name : [match.name];
    if (!scope?.subName) return false;
    const subName = scope.subName;
    if (!names.some(n => nameMatchesPattern(subName, n))) return false;
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

/**
 * 挑出「本次真正参与合并」的覆写文件：文件自身未被 `enabled: false` 停用，且 match
 * 命中当前订阅作用域（无 match 即全局）。
 *
 * 两道过滤**刻意合在一个出口**，不拆成并列的两个导出函数：调用方只要漏调其中一个，
 * 被停用的文件就会照常合并进配置、还会出现在「当前生效的覆写文件」清单里——
 * 消费点不止一处的防线，历史上反复出现「只补了当时那条路径」的缺口。
 * 新增筛选维度请继续加在本函数内。
 */
export function selectActiveOverwriteFiles(files: OverwriteFileEntry[], scope?: OverwriteScope): OverwriteFileEntry[] {
  return files.filter(f => f.enabled !== false && matchesScope(f.match, scope));
}

/** 元数据键：在合并前被剥离，绝不进入最终 mihomo-cli 配置。 */
const METADATA_KEYS = new Set(['match', 'enabled']);

/**
 * 元数据键不接受操作符修饰，也不接受大小写/空白变体。两类都会造成同一种静默失效——
 * 文件没被停用、键被当普通配置写进运行配置，而内核对未知顶层键宽松、`-t` 不会拦下：
 *
 * - **操作符**：剥离发生在解构（早于 mergeConfigLevel 的操作符解析），`enabled!: false`
 *   会被 parseOverrideKey 规范成键 `enabled` 落进最终配置。代价是没有「写真名为
 *   enabled 的配置键」的逃生口，但 mihomo-cli 顶层没有这个键，暂无实际影响
 *   （尖括号转义已随 DSL 裁剪移除，`<enabled>` 在合并层报「已移除的尖括号转义」）。
 * - **大小写/空白**：YAML 键大小写敏感，`Enabled: false` 既不是元数据键（不停用文件）
 *   又不是任何 mihomo-cli 原生键（纯噪音）。判据是「小写去空白后等于元数据键、但原样不等于」——
 *   与 isOverwriteFilenameTypo 同一思路（只认整体近失，不做模糊猜测）。
 */
function assertNoMetadataKeyLookalikes(config: Record<string, unknown>, fileName: string): void {
  for (const rawKey of Object.keys(config)) {
    const parsed = parseOverrideKey(rawKey).key;
    if (parsed !== rawKey && METADATA_KEYS.has(parsed)) {
      throw new CliError(`覆写文件 "${fileName}" 的元数据键 "${rawKey}" 不支持操作符`, {
        label: '覆写配置错误',
        hint: [
          `match 与 enabled 是本 CLI 的元数据键，在合并前就被剥离，带操作符写法（如 ${rawKey}）不会生效，反而会把 ${parsed} 当普通配置键写进运行配置。`,
          `请直接写 ${parsed}: <值>。`,
        ],
      });
    }
    // 大小写/空白近失：剥离用的是精确键名，`Enabled:` 既不停用文件也不是 mihomo 原生键
    const normalized = rawKey.trim().toLowerCase();
    if (normalized !== rawKey && METADATA_KEYS.has(normalized)) {
      throw new CliError(`覆写文件 "${fileName}" 的 "${rawKey}" 疑似想写元数据键 ${normalized}`, {
        label: '覆写配置错误',
        hint: [
          `YAML 键区分大小写与空白，"${rawKey}" 不会被识别为 ${normalized}——文件不会被停用/限定作用域，该键反而会当普通配置写进运行配置（内核对未知顶层键不报错，不会有任何提示）。`,
          `请写成 ${normalized}: <值>。`,
        ],
      });
    }
  }
}

/**
 * 文件级（不依赖订阅内容）的操作符校验，在 readOverwriteFiles 加载阶段执行一次，
 * 让诊断路径（ow/status）与合并路径（start/config/doctor）看到同一份坏文件：
 *
 * - **操作符形态**（`~`/尖括号/空键/互斥修饰）：只在合并期抛的话，诊断旁路根本不合并，
 *   坏文件会被当成「已生效」列在 status/applied 里，而启动硬失败——同一文件两处结论
 * - **数组操作符命中系统默认的非数组键**（如 `log-level+`）：BASE_CONFIG 在合并
 *   **之后**才注入，合并期看不到它，`log-level+: x` 会先产出 `log-level: [x]`，
 *   随后标量默认值又因「键已存在」被跳过，非法数组一路存活到内核 `-t`——README
 *   承诺的「作用于标量直接报错」在这个最常见的反例上恰好不生效
 *
 * 依赖订阅当前值才能判的冲突（订阅自带同键标量、跨文件的同键冲突）仍由
 * mergeConfigLevel 的运行时检查兜底——`ow` 列表不绑定订阅，静态判不了。
 */
function assertFileLevelOperatorRules(config: Record<string, unknown>, fileName: string): void {
  for (const rawKey of Object.keys(config)) {
    const parsed = parseOverrideKey(rawKey);
    assertValidParsedKey(rawKey, parsed);
    // 与合并期同一个错误（protoKeyInOverwriteError）：诊断路径与合并路径必须都把
    // 该文件判坏，不能 ow/status 列正常、启动才炸
    if (parsed.key === '__proto__') throw protoKeyInOverwriteError();
    if (!parsed.arrayPrepend && !parsed.arrayAppend) continue;

    const base = BASE_CONFIG[parsed.key];
    if (base === undefined || Array.isArray(base)) continue;
    throw new CliError(`覆写文件 "${fileName}" 的键 "${rawKey}" 用了数组拼接，但系统配置 "${parsed.key}" 的默认值是 ${describeValueKind(base)}、不是数组`, {
      label: '覆写配置错误',
      hint: [
        `+${parsed.key} / ${parsed.key}+ 用于向数组前置/追加元素（如 rules+）；系统默认的 ${parsed.key} 不是数组，拼接只会产出内核无法解析的配置。`,
        `若要覆盖 ${parsed.key}，请直接写 ${parsed.key}: <值>（要整块替换可用 ${parsed.key}!: <值>）。`,
      ],
    });
  }
}

/**
 * 规整文件内的 `enabled` 元数据键：缺省（未写）即启用。
 *
 * **只认真布尔**：YAML 1.2 core schema 里 `no` / `off` 解析成**字符串**而非布尔
 * （实测 js-yaml 5.3.0：`enabled: no` → `"no"`、`enabled:` → null、`enabled: 0` → 0），
 * 按 truthy 判断会让 `enabled: no` 悄悄保持启用——用户以为停用了、配置却照常生效，
 * 故非布尔一律报错并指明要写 `false`。
 */
function normalizeEnabled(raw: unknown, fileName: string): boolean {
  if (raw === undefined) return true;
  if (typeof raw === 'boolean') return raw;
  throw new CliError(
    `覆写文件 "${fileName}" 的 enabled 必须是布尔值（true / false），当前是 ${raw === null ? 'null（空值）' : `${typeof raw}（${JSON.stringify(raw)}）`}`,
    {
      label: '覆写配置错误',
      hint: [
        'YAML 中 no / off / "false" 都不是布尔值（前两者被解析为字符串），按真值处理会让本该停用的文件继续生效。',
        '停用该文件请写 enabled: false，启用可写 enabled: true 或直接删掉这一行。',
      ],
    },
  );
}

/** 把单文件加载异常归一成纯数据的坏文件条目（诊断面渲染、合并路径重建异常共用） */
function toBrokenFile(file: string, filePath: string, e: unknown): BrokenOverwriteFile {
  if (e instanceof CliError) {
    return { name: file, path: filePath, label: e.label, message: e.message, hint: e.hint };
  }
  const message = (e as Error).message || String(e);
  // YAML 里 `*` 开头的标量是**别名语法**，`name: *edu`（后缀通配）会解析失败，
  // 光说「解析失败」用户想不到是引号问题
  const hint = ['该文件当前未参与合并，请修正后重试（mihomo-cli ow 可查看全部覆写文件）。'];
  if (/alias/i.test(message)) {
    hint.push('若写了以 * 开头的通配值（如 name: *edu），YAML 会把它当别名语法，请加引号写成 name: "*edu"');
  }
  return { name: file, path: filePath, label: '覆写配置错误', message: `覆写文件 "${file}" 解析失败: ${message}`, hint };
}

/**
 * 加载 JS 覆写脚本并校验默认导出。createRequire 以脚本自身路径为基准：脚本内
 * require/import 的相对依赖按它所在目录解析。require(esm)（Node ≥22.12，本仓下界
 * 22.22.1）同步加载 ESM——buildConfig 是同步管线，脚本契约也要求同步；.cjs 走 CJS
 * 加载，`module.exports = fn` 的写法同样认。加载即执行模块顶层代码（契约：顶层只
 * 定义函数，副作用放变换函数内——status/doctor/config 等只读命令也会执行脚本）。
 */
function loadOverwriteScript(filePath: string, fileName: string): OverwriteTransform {
  let mod: unknown;
  try {
    mod = createRequire(filePath)(filePath);
  } catch (e) {
    throw new CliError(`覆写脚本 "${fileName}" 加载失败: ${(e as Error).message?.split('\n')[0] ?? String(e)}`, {
      label: '覆写配置错误',
      hint: ['该脚本当前未参与合并。常见原因：语法错误、import/require 了不存在的模块、或使用了 top-level await（脚本必须可同步加载）。'],
    });
  }
  const fn = typeof mod === 'function' ? mod : (mod as { default?: unknown } | null | undefined)?.default;
  if (typeof fn !== 'function') {
    throw new CliError(`覆写脚本 "${fileName}" 缺少变换函数`, {
      label: '覆写配置错误',
      hint: [
        '写法（就地修改传入的 config；return true 表示命中当前订阅，其余返回值忽略）:',
        '  export default function (config, ctx) { ... }',
        'CommonJS 写法 module.exports = function (config, ctx) { ... } 同样认。',
      ],
    });
  }
  return fn as OverwriteTransform;
}

/**
 * 读取目录下全部覆写文件（YAML + JS 脚本），**不抛错、不静默**：成功的进 ok，
 * 解析/校验失败的进 broken。两条消费路径各自决定姿态：
 * - 合并路径（loadOverwriteFile → buildConfig → start/doctor）：存在 broken 即硬失败
 * - 诊断路径（listOverwriteFile → status/ow 列表）：broken 红字列出，仪表盘永远
 *   能渲染——最需要排查工具的时候工具不能先坏
 */
function readOverwriteFiles(): { ok: OverwriteFileEntry[]; broken: BrokenOverwriteFile[] } {
  const ok: OverwriteFileEntry[] = [];
  const broken: BrokenOverwriteFile[] = [];

  if (!fs.existsSync(USER_DATA_DIR)) return { ok, broken };

  const entries = fs.readdirSync(USER_DATA_DIR);
  // 两段排序：JS 脚本全部在前（主脚本最先、扩展码点序）、YAML 在后（主文件最先、
  // 扩展码点序）——「程序化结构变换在前，声明式微调兜底」（D13）。段内码点序，不用 localeCompare：
  // 后者随系统 locale 漂移（同一组中文文件名在 en/zh_CN/ja 下三种顺序），而排序即
  // 合并顺序——不同机器合并出不同运行配置，全程静默。排序是合并语义的一部分，不是展示细节。
  const files = entries
    .filter(isOverwriteFilename)
    .sort((a, b) => (overwriteSortKey(a) < overwriteSortKey(b) ? -1 : overwriteSortKey(a) > overwriteSortKey(b) ? 1 : 0));

  // 近失文件名：意图明显是覆写文件却不被任何合法模式认（最典型：主文件写成 overwrite.yml）。
  // 静默不加载 = 用户以为覆写生效了、`ow` 列表里也看不见，故打一行警告。
  // 只认整体近失（见 isOverwriteFilenameTypo），不扫全部「形近」文件
  for (const typo of entries.filter(isOverwriteFilenameTypo)) {
    console.warn(
      `警告: "${typo}" 不会被当作覆写文件加载（合法文件名: overwrite.yaml 主文件、overwrite.*.yaml / overwrite.*.yml 扩展文件、overwrite.js 主脚本、overwrite.*.js / .mjs / .cjs 扩展脚本）；若是笔误请改名`,
    );
  }

  for (const file of files) {
    const filePath = path.join(USER_DATA_DIR, file);
    try {
      if (isScriptOverwriteFilename(file)) {
        ok.push({ name: file, path: filePath, transform: loadOverwriteScript(filePath, file) });
        continue;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      // 空白/纯注释文档前置跳过：js-yaml 5 对这类输入抛「expected a document」而非
      // 返回 null（js-yaml 4 的行为，下方 parsed === null 分支的注释即按它写的），
      // 落入 catch 会让 start/config/doctor 硬失败——先建空骨架文件再编辑是自然操作顺序
      if (isBlankYamlDocument(content)) continue;
      // 别名上限防 YAML 炸弹 DoS（同 config.ts SAFE_YAML_LOAD_OPTIONS，此处内联避免与 config 循环依赖）
      const parsed = yaml.load(content, { maxAliases: YAML_MAX_ALIASES }) as Record<string, unknown> | null;
      // 顶层数组/标量不是合法覆写文件，与语法错同族的静默失效，统一收进 broken
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // match / enabled 是元数据键：抽成结构化字段并从 config 剥离，确保它们永不进入
        // 最终 mihomo-cli 配置（内核对未知顶层键宽松，剥离是本 CLI 的责任）。
        // 被停用的文件同样完整加载并校验 match：`ow` 列表要显示它的作用域，且避免
        // 「停用期间藏着错误、一启用就炸」
        const { match, enabled, ...config } = parsed;
        assertNoMetadataKeyLookalikes(config, file);
        assertFileLevelOperatorRules(config, file);
        ok.push({ name: file, path: filePath, config, match: normalizeMatch(match, file), enabled: normalizeEnabled(enabled, file) });
      } else if (parsed !== null) {
        const shape = Array.isArray(parsed) ? '数组' : typeof parsed;
        throw new CliError(`覆写文件 "${file}" 顶层必须是映射（键值对），当前是 ${shape}`, {
          label: '覆写配置错误',
          hint: ['该文件当前未参与合并。覆写文件形如:', '  +rules:', '    - DOMAIN-SUFFIX,example.com,DIRECT'],
        });
      }
      // parsed === null（字面 null/~ 或 --- 空文档）无内容可合并，不计入任何一边
    } catch (e) {
      broken.push(toBrokenFile(file, filePath, e));
    }
  }

  return { ok, broken };
}

/**
 * 空白或纯注释的覆写文档：无内容可合并，按「不计入任何一边」跳过。
 * 必须在 yaml.load 之前判断——js-yaml 5 对空文档抛异常（js-yaml 4 返回 null），
 * 落入 catch 会把空骨架文件当坏文件硬失败。判据只认行首注释：任何非注释
 * 内容行都不以 # 开头，不会误伤。
 */
function isBlankYamlDocument(content: string): boolean {
  return content.split('\n').every(line => {
    const t = line.trim();
    return t === '' || t.startsWith('#');
  });
}

/**
 * 覆写文件排序键：段序（脚本 0 / YAML 1）→ 主文件优先 → 文件名码点序。
 * 脚本先做结构变换、YAML 后做声明式微调（含 + 前插），故脚本段在前（D13）。
 */
function overwriteSortKey(filename: string): string {
  const segment = isScriptOverwriteFilename(filename) ? '0' : '1';
  const primary = filename === 'overwrite.yaml' || isPrimaryScriptFilename(filename) ? '0' : '1';
  return `${segment}${primary}${filename}`;
}

/**
 * 合并路径的加载出口：**任何坏文件都硬失败**，由 main().catch 统一渲染完整原因
 * （warn+退出 0 会让启动成功但覆写没参与合并，「以为生效了」比报错危险）。
 * 双路径的完整论证见 docs/decisions.md D7。
 */
export function loadOverwriteFile(): OverwriteFileEntry[] {
  const { ok, broken } = readOverwriteFiles();
  if (broken.length > 0) {
    const first = broken[0];
    throw new CliError(first.message, { label: first.label, hint: first.hint });
  }
  return ok;
}

/** 脚本锁定键探针集：LOCKED_CONFIG_KEYS + 顶层 tls 段（YAML 侧告警同样含 tls） */
const SCRIPT_LOCKED_PROBES: readonly string[] = [...LOCKED_CONFIG_KEYS, 'tls'];

/** 脚本执行前的锁定键浅快照：只记存在性与值，与 YAML 侧的键级检测同粒度 */
function snapshotLockedKeys(config: Record<string, unknown>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const k of SCRIPT_LOCKED_PROBES) {
    if (k in config) snap[k] = config[k];
  }
  return snap;
}

/** 检出脚本新设置或改值的锁定键；嵌套内部的改动检不出（浅层对比，与 YAML 侧同粒度） */
function diffLockedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return SCRIPT_LOCKED_PROBES.filter(k => {
    const had = k in before;
    const has = k in after;
    return had !== has ? has : had && before[k] !== after[k];
  });
}

/** applyOverwrite 的执行参数：构造脚本 ctx 所需（YAML 合并不用） */
interface ApplyOverwriteOptions {
  mode: 'mixed' | 'tun';
  scope?: OverwriteScope;
}

/** 脚本设置的锁定键命中，供 buildConfig 渲染告警（文案在 config.ts，只留一份） */
interface ScriptLockedHit {
  file: string;
  keys: string[];
}

/**
 * 应用已按开关与作用域筛选的覆写：YAML 文件按序深度合并，JS 脚本随后按序执行
 * （顺序由 readOverwriteFiles 的排序保证，两类混在同一 files 数组里按 transform 分派）。
 * 不额外读取设置或改变节点池。
 *
 * 脚本契约（README 同步承诺）：就地修改传入的 config、必须同步（返回 Promise 报错
 * ——buildConfig 是同步管线）。返回值约定：`return true` 表示命中当前订阅（脚本没有
 * YAML 的 match 声明，靠返回值向 CLI 报告「这次变换是否适用」，status/config 的
 * 生效提示据此显示）；其余返回值（undefined/其他）一律视为未命中，不影响合并本身。
 * 脚本抛错按坏文件同款姿态：CLI 包装为带文件名的 CliError，合并路径硬失败。
 * 脚本设置的锁定键经前后快照检出，由调用方渲染告警——剥除照常发生（安全边界不破），
 * 但不静默。
 */
export function applyOverwrite(
  baseConfig: Record<string, unknown>,
  files: OverwriteFileEntry[],
  opts: ApplyOverwriteOptions,
): { config: Record<string, unknown>; scriptWarnings: string[]; scriptLockedHits: ScriptLockedHit[]; scriptMatches: ScriptMatch[] } {
  let result = { ...baseConfig };
  const scriptWarnings: string[] = [];
  const scriptLockedHits: ScriptLockedHit[] = [];
  const scriptMatches: ScriptMatch[] = [];

  let host = '';
  try {
    if (opts.scope?.subUrl) host = new URL(opts.scope.subUrl.trim()).hostname;
  } catch {
    host = ''; // 非法 URL：脚本侧自己判（host 为空串）
  }
  const subscription = { name: opts.scope?.subName ?? '', url: opts.scope?.subUrl ?? '', host };

  for (const file of files) {
    if (file.transform) {
      const before = snapshotLockedKeys(result);
      const notes: string[] = [];
      const ctx: OverwriteScriptContext = { subscription, mode: opts.mode, warn: message => notes.push(message) };
      let returned: unknown;
      try {
        returned = file.transform(result, ctx);
      } catch (e) {
        throw new CliError(`覆写脚本 "${file.name}" 执行失败: ${(e as Error).message?.split('\n')[0] ?? String(e)}`, {
          label: '覆写配置错误',
          hint: ['本次构建已中止；修复脚本后重试（mihomo-cli ow 可查看全部覆写文件与脚本）。'],
        });
      }
      if (returned != null && typeof (returned as { then?: unknown }).then === 'function') {
        throw new CliError(`覆写脚本 "${file.name}" 返回了 Promise`, {
          label: '覆写配置错误',
          hint: ['脚本必须是同步函数（buildConfig 是同步管线，纯转换没有要等网络的场景）；确需异步运算，先在脚本外算好再同步写入。'],
        });
      }
      scriptWarnings.push(...notes.map(message => `${message}（脚本 ${file.name}）`));
      // 命中判据严格 === true：脚本返回 truthy 的其他值（如对象/字符串）不算——
      // 约定只有显式 return true 才宣告命中，避免「顺手 return 了 config」被误读
      scriptMatches.push({ file: file.name, matched: returned === true });
      const keys = diffLockedKeys(before, result);
      if (keys.length > 0) scriptLockedHits.push({ file: file.name, keys });
      continue;
    }
    result = mergeConfigLevel(result, file.config ?? {}, true);
  }
  return { config: result, scriptWarnings, scriptLockedHits, scriptMatches };
}

/**
 * 列出目录里的全部覆写文件（含被停用的、**含加载失败的 broken 条目**），供 `ow` 列表
 * 与 status 展示。这是刻意的旁路：诊断面绝不因坏文件抛错（合并闸门是 loadOverwriteFile，
 * start/doctor 在那里硬失败）。
 *
 * 传 `scope` 时每个正常条目附带 `matched`：该文件的 match 是否命中这个作用域。判据仍是
 * matchesScope 本身（与 selectActiveOverwriteFiles 同一个函数），**这里只是展示**——
 * 合并闸门始终是 selectActiveOverwriteFiles，不要拿 matched 去筛要合并的文件。
 * 不传 scope 则 matched 恒为 undefined（= 未判定），`ow` 列表走这条路径：它不绑定
 * 某条订阅，判不了也不该判。broken 条目不判 match（文件根本没解析出来）。
 */
export function listOverwriteFile(scope?: OverwriteScope): OverwriteListResult {
  const { ok, broken } = readOverwriteFiles();
  const enabled = isOverwriteEnabled();

  return {
    enabled,
    dir: USER_DATA_DIR,
    files: ok.map(f => ({
      name: f.name,
      path: f.path,
      kind: f.transform ? ('script' as const) : ('yaml' as const),
      keys: f.transform ? [] : Object.keys(f.config || {}),
      scope: summarizeMatch(f.match),
      enabled: f.enabled !== false,
      ...(scope ? { matched: matchesScope(f.match, scope) } : {}),
    })),
    broken,
  };
}
