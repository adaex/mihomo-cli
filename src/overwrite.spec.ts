import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CliError } from './errors.js';
import type { OverwriteFileEntry, OverwriteMatch } from './types.js';

// paths.ts 在 import 期求值 MIHOMO_CLI_DIR，故必须先设环境变量再动态 import（同 config.spec.ts）；
// 本文件的 loadOverwriteFile 用例需要在受控数据目录里摆放覆写文件。
// errors.ts 零依赖、不受数据目录影响，保持静态导入
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-overwrite-'));
process.env.MIHOMO_CLI_DIR = tmpDir;
const { applyOverwrite, deepMergeWithOverrides, listOverwriteFile, loadOverwriteFile, normalizeMatch, parseOverrideKey, selectActiveOverwriteFiles } =
  await import('./overwrite.js');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('parseOverrideKey', () => {
  it('普通键无任何修饰', () => {
    assert.deepEqual(parseOverrideKey('dns'), {
      key: 'dns',
      forceOverwrite: false,
      arrayPrepend: false,
      arrayAppend: false,
    });
  });

  it('key! 强制覆盖', () => {
    const r = parseOverrideKey('proxies!');
    assert.equal(r.key, 'proxies');
    assert.equal(r.forceOverwrite, true);
  });

  it('+key 数组前置', () => {
    const r = parseOverrideKey('+rules');
    assert.equal(r.key, 'rules');
    assert.equal(r.arrayPrepend, true);
    assert.equal(r.arrayAppend, false);
  });

  it('key+ 数组追加', () => {
    const r = parseOverrideKey('rules+');
    assert.equal(r.key, 'rules');
    assert.equal(r.arrayAppend, true);
    assert.equal(r.arrayPrepend, false);
  });

  it('互斥修饰的解析形态（报错在合并层，这里锁住各组合确实置出多个位）', () => {
    // 这些组合是否报错由 deepMergeWithOverrides 的断言锁；这里确认解析结果本身。
    // 注意 `rules!+` 不在列：`!` 只在结尾识别，该形态解析为「追加到字面键 rules!」（历史行为）
    assert.equal(parseOverrideKey('+rules+').arrayPrepend && parseOverrideKey('+rules+').arrayAppend, true);
    assert.equal(parseOverrideKey('rules+!').arrayAppend && parseOverrideKey('rules+!').forceOverwrite, true);
  });
});

describe('互斥操作符与空键：合并层显式报错，不静默按分支优先级取其一', () => {
  for (const key of ['+rules+', '+rules!', 'rules+!']) {
    it(`"${key}" 含互斥操作符 → CliError`, () => {
      assert.throws(
        () => deepMergeWithOverrides({ rules: ['A'], dns: {} }, { [key]: ['x'] }),
        e => e instanceof CliError && /互斥的操作符/.test(e.message),
      );
    });
  }

  it('合法的单一操作符不被误伤', () => {
    assert.doesNotThrow(() => deepMergeWithOverrides({ rules: [] }, { '+rules': ['x'] }));
    assert.doesNotThrow(() => deepMergeWithOverrides({ rules: [] }, { 'rules+': ['x'] }));
    assert.doesNotThrow(() => deepMergeWithOverrides({ dns: { a: 1 } }, { 'dns!': { b: 2 } }));
  });

  for (const key of ['+', '!']) {
    it(`裸操作符 "${key}" 解析出空键名 → CliError`, () => {
      assert.throws(
        () => deepMergeWithOverrides({}, { [key]: 'x' }),
        e => e instanceof CliError && /键名不能为空/.test(e.message),
      );
    });
  }
});

describe('已移除的操作符形态：显式报错给迁移指引，不当字面键静默落进配置', () => {
  // ~（按 name 合并）与 <x>（尖括号转义）已随 DSL 裁剪移除。内核对未知顶层键宽容，
  // 没有专属报错的话老写法会被当字面键静默写进运行配置——零反馈的语义消失
  for (const key of ['~proxies', '~?proxy-groups', '~<weird>']) {
    it(`"${key}" → 报已移除的 ~ 操作符并指向 JS 脚本`, () => {
      assert.throws(
        () => deepMergeWithOverrides({}, { [key]: [{ name: 'x' }] }),
        e => e instanceof CliError && /已移除的 ~ 操作符/.test(e.message) && /JS 覆写脚本/.test((e as CliError).hint.join('\n')),
      );
    });
  }

  for (const key of ['<rules>', '<+dns>', '+<+dns>']) {
    it(`"${key}" → 报已移除的尖括号转义`, () => {
      assert.throws(
        () => deepMergeWithOverrides({}, { [key]: ['x'] }),
        e => e instanceof CliError && /已移除的尖括号转义/.test(e.message),
      );
    });
  }

  it('裸 ~ / ~? 同样被拦（不再走空键名分支）', () => {
    assert.throws(
      () => deepMergeWithOverrides({}, { '~': 'x' }),
      e => e instanceof CliError && /已移除的 ~ 操作符/.test(e.message),
    );
  });
});

describe('deepMergeWithOverrides', () => {
  it('对象深合并保留未覆盖字段', () => {
    const target = { dns: { enable: true, listen: '0.0.0.0:53' } };
    const override = { dns: { enable: false } };
    const r = deepMergeWithOverrides(target, override);
    assert.deepEqual(r.dns, { enable: false, listen: '0.0.0.0:53' });
  });

  it('key! 强制整体覆盖对象', () => {
    const target = { dns: { enable: true, listen: '0.0.0.0:53' } };
    const override = { 'dns!': { enable: false } };
    const r = deepMergeWithOverrides(target, override);
    assert.deepEqual(r.dns, { enable: false });
  });

  it('+key 数组前置', () => {
    const target = { rules: ['A', 'B'] };
    const override = { '+rules': ['X'] };
    const r = deepMergeWithOverrides(target, override);
    assert.deepEqual(r.rules, ['X', 'A', 'B']);
  });

  it('key+ 数组追加', () => {
    const target = { rules: ['A', 'B'] };
    const override = { 'rules+': ['X'] };
    const r = deepMergeWithOverrides(target, override);
    assert.deepEqual(r.rules, ['A', 'B', 'X']);
  });

  it('标量覆盖', () => {
    const r = deepMergeWithOverrides({ mode: 'rule' }, { mode: 'global' });
    assert.equal(r.mode, 'global');
  });

  it('override 为数组时整体替换', () => {
    const r = deepMergeWithOverrides({ rules: ['A'] }, { rules: ['X', 'Y'] });
    assert.deepEqual(r.rules, ['X', 'Y']);
  });

  it('target 为 null 时按 override 形态初始化', () => {
    const r = deepMergeWithOverrides(null, { a: 1 });
    assert.deepEqual(r, { a: 1 });
  });
});

// 操作符只在覆写文件顶层生效；嵌套层的键一律字面。此前内层键语义随订阅形态漂移：
// 目标已有同名映射 → 递归进下一层、内层键继续被当 DSL 解析；目标没有该键 → 整棵移植、
// 内层键字面。同一文件在不同订阅上行为不同，mihomo 原生通配键（+.域名）在递归路径
// 被静默剥损、`-t` 照样通过、通配匹配悄悄失效
describe('deepMergeWithOverrides 嵌套键一律字面（操作符只在顶层生效）', () => {
  it('原生通配键在递归路径（目标已有同名映射）下字面保留，+ 不再被剥掉', () => {
    const target = { dns: { 'nameserver-policy': { 'geosite:cn': 'https://doh.pub/dns-query' } } };
    const override = { dns: { 'nameserver-policy': { '+.corp.example.com': 'https://dns.corp.example.com/dns-query' } } };
    const r = deepMergeWithOverrides(target, override);
    // 旧语义把 +.corp.example.com 当「数组前置」：键剥成 .corp.example.com、标量值被包成数组
    assert.deepEqual(r.dns, {
      'nameserver-policy': {
        'geosite:cn': 'https://doh.pub/dns-query',
        '+.corp.example.com': 'https://dns.corp.example.com/dns-query',
      },
    });
  });

  it('原生通配键在移植路径（目标无该段）下字面保留（行为不变）', () => {
    const r = deepMergeWithOverrides({}, { dns: { 'nameserver-policy': { '+.corp.example.com': 'https://x' } } });
    assert.deepEqual(r.dns, { 'nameserver-policy': { '+.corp.example.com': 'https://x' } });
  });

  it('<+.google.cn> 转义在嵌套层按字面保留（含尖括号），不再被解包', () => {
    const target = { hosts: { 'a.com': '1.1.1.1' } };
    const r = deepMergeWithOverrides(target, { hosts: { '<+.google.cn>': '8.8.8.8' } });
    assert.deepEqual(r.hosts, { 'a.com': '1.1.1.1', '<+.google.cn>': '8.8.8.8' });
  });

  it('顶层 deep merge 语义不变：内层普通键仍逐键合并', () => {
    const r = deepMergeWithOverrides({ dns: { a: 1 } }, { dns: { b: 2 } });
    assert.deepEqual(r.dns, { a: 1, b: 2 });
  });

  it('嵌套 +x / ~x / x! / x+ 一律字面键名，不做数组插入或按 name 合并', () => {
    const target = { dns: { enable: true } };
    const override = { dns: { '+x': [1], '~x': [2], 'x!': [3], 'x+': [4] } };
    const r = deepMergeWithOverrides(target, override);
    assert.deepEqual(r.dns, { enable: true, '+x': [1], '~x': [2], 'x!': [3], 'x+': [4] });
  });
});

describe('matchesScope (经 selectActiveOverwriteFiles)', () => {
  const mk = (match: OverwriteMatch | undefined): OverwriteFileEntry => ({
    name: 'overwrite.yaml',
    path: '/tmp/overwrite.yaml',
    config: {},
    match,
  });

  it('无 match 全局生效', () => {
    const files = [mk(undefined)];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'x' }).length, 1);
  });

  it('name 命中订阅名', () => {
    const files = [mk({ name: ['home', 'work'] })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'work' }).length, 1);
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'other' }).length, 0);
  });

  it('name fail-closed：scope 缺 subName 不应用', () => {
    const files = [mk({ name: ['home'] })];
    assert.equal(selectActiveOverwriteFiles(files, {}).length, 0);
  });

  it('url-domain 后缀匹配 hostname 与子域', () => {
    const files = [mk({ 'url-domain': ['example.com'] })];
    assert.equal(selectActiveOverwriteFiles(files, { subUrl: 'https://sub.example.com/x' }).length, 1);
    assert.equal(selectActiveOverwriteFiles(files, { subUrl: 'https://example.com/x' }).length, 1);
    assert.equal(selectActiveOverwriteFiles(files, { subUrl: 'https://evil.com/x' }).length, 0);
  });

  it('url-domain fail-closed：scope 缺 subUrl 不应用', () => {
    const files = [mk({ 'url-domain': ['example.com'] })];
    assert.equal(selectActiveOverwriteFiles(files, {}).length, 0);
  });

  it('多条件 AND：全部满足才应用', () => {
    const files = [mk({ name: ['home'], 'url-domain': ['example.com'] })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home', subUrl: 'https://example.com' }).length, 1);
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home', subUrl: 'https://other.com' }).length, 0);
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'work', subUrl: 'https://example.com' }).length, 0);
  });
});

describe('deepMergeWithOverrides 数组语义误用（+key / key+ 作用于非数组）', () => {
  // 此前会静默包成单元素数组：log-level+ 把标量变成 ["debug"]，生成 mihomo 无法解析的配置
  const misuse: { label: string; base: Record<string, unknown>; override: Record<string, unknown> }[] = [
    { label: 'key+ 作用于标量', base: { 'log-level': 'info' }, override: { 'log-level+': 'debug' } },
    { label: '+key 作用于映射', base: { dns: { a: 1 } }, override: { '+dns': [1] } },
  ];

  for (const { label, base, override } of misuse) {
    it(`${label} → CliError 而非静默包成数组`, () => {
      assert.throws(
        () => deepMergeWithOverrides(base, override),
        (e: unknown) => {
          assert.ok(e instanceof CliError, `应为 CliError，实际 ${(e as Error).constructor.name}`);
          assert.equal((e as CliError).label, '覆写配置错误');
          return true;
        },
      );
    });
  }

  it('+key 目标不存在时放行', () => {
    assert.deepEqual(deepMergeWithOverrides({}, { 'rules+': ['MATCH,DIRECT'] }), { rules: ['MATCH,DIRECT'] });
  });

  it('key! 仍可强制覆盖非数组', () => {
    assert.deepEqual(deepMergeWithOverrides({ dns: { a: 1 } }, { 'dns!': { b: 2 } }), { dns: { b: 2 } });
  });

  it('普通键仍走深度合并', () => {
    assert.deepEqual(deepMergeWithOverrides({ dns: { a: 1 } }, { dns: { b: 2 } }), { dns: { a: 1, b: 2 } });
  });
});

describe('matchesScope 订阅名大小写不敏感', () => {
  const file = (match: OverwriteMatch): OverwriteFileEntry => ({ name: 'overwrite.x.yaml', path: '/x', config: {}, match });

  it('match 值小写命中大写订阅名（与 sub use 的解析口径一致）', () => {
    const files = [file({ name: 'home' })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'Home' }).length, 1);
  });

  it('match 值大写命中小写订阅名', () => {
    const files = [file({ name: 'HOME' })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home' }).length, 1);
  });

  it('名称不同仍不命中', () => {
    const files = [file({ name: 'work' })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home' }).length, 0);
  });

  it('数组形式逐项大小写不敏感', () => {
    const files = [file({ name: ['Work', 'home'] })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'HOME' }).length, 1);
  });
});

describe('normalizeMatch（match 块 fail-closed）', () => {
  const assertConfigError = (fn: () => unknown) => {
    assert.throws(fn, (e: unknown) => {
      assert.ok(e instanceof CliError, `应为 CliError，实际 ${(e as Error).constructor.name}`);
      assert.equal((e as CliError).label, '覆写配置错误');
      return true;
    });
  };

  it('无 match 键返回 undefined（默认全局生效）', () => {
    assert.equal(normalizeMatch(undefined, 'overwrite.yaml'), undefined);
  });

  it('写了 match 但值为空（缩进笔误解析成 null）抛错而非静默全局生效', () => {
    // 回归：旧实现把 null 与「未写」一并当全局生效——`match:` 下面的 `name: edu*`
    // 顶了格时文件反而应用到所有订阅，垃圾键还进最终配置
    assert.throws(() => normalizeMatch(null, 'overwrite.yaml'), /match 为空/);
  });

  it('正常 match 块解析为条件', () => {
    const match = normalizeMatch({ name: 'work', 'url-domain': ['corp.com', 'github.com'] }, 'overwrite.yaml');
    assert.deepEqual(match, { name: ['work'], 'url-domain': ['corp.com', 'github.com'] });
  });

  it('subscription 键已收掉：报错指明改写 name，不静默当未知键', () => {
    // 同义双键留一套；当未知键报错会让人摸不着头脑，文案直接给改法
    assert.throws(
      () => normalizeMatch({ subscription: 'edu1' }, 'overwrite.yaml'),
      (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.match((e as Error).message, /用了 subscription 键/);
        assert.match((e as CliError).hint.join('\n'), /name: edu\*/);
        return true;
      },
    );
  });

  it('键名打错（subscripton）抛错而非静默全局生效', () => {
    // 回归：旧实现 warn + 忽略未知键 → 返回 undefined → 该文件对所有订阅生效。
    // 用户写了 match 显然想限定作用域，fail-open 是比报错严重得多的静默失效
    assertConfigError(() => normalizeMatch({ subscripton: 'work' }, 'overwrite.yaml'));
  });

  it('多条件里部分键打错同样抛错（否则 AND 条件被弱化、作用域放宽）', () => {
    assertConfigError(() => normalizeMatch({ name: 'work', 'url-domian': 'corp.com' }, 'overwrite.yaml'));
  });

  it('值滤空（空数组/非字符串）抛错', () => {
    assertConfigError(() => normalizeMatch({ name: [] }, 'overwrite.yaml'));
    assertConfigError(() => normalizeMatch({ name: 123 }, 'overwrite.yaml'));
  });

  it('match 为数组/标量抛错', () => {
    assertConfigError(() => normalizeMatch(['name'], 'overwrite.yaml'));
    assertConfigError(() => normalizeMatch('work', 'overwrite.yaml'));
  });

  it('空 match 块抛错（写了 match 即显式要求限定作用域）', () => {
    assertConfigError(() => normalizeMatch({}, 'overwrite.yaml'));
  });
});

describe('match name 通配：尾部 *（前缀）与头部 *（后缀），其余报错', () => {
  /** 经 normalizeMatch 走一遍，验证的是「用户写的 YAML」而非手搓的内部结构 */
  const fromYaml = (match: Record<string, unknown>): OverwriteFileEntry => ({
    name: 'overwrite.x.yaml',
    path: '/x',
    config: {},
    match: normalizeMatch(match, 'overwrite.x.yaml'),
  });
  const hits = (entry: OverwriteFileEntry, subName: string): boolean => selectActiveOverwriteFiles([entry], { subName }).length === 1;

  it('name: edu* 命中同前缀的多条订阅，不命中其他机场套餐', () => {
    const entry = fromYaml({ name: 'edu*' });
    for (const name of ['edu1', 'edu2', 'edu-hk']) {
      assert.equal(hits(entry, name), true, `${name} 应命中 edu*`);
    }
    assert.equal(hits(entry, 'mini1'), false);
  });

  it('前缀是全串前缀语义：edu* 不命中 xedu1（半匹配会让作用域悄悄放宽）', () => {
    assert.equal(hits(fromYaml({ name: 'edu*' }), 'xedu1'), false);
  });

  it('name: *edu 后缀匹配（YAML 源文件里前导 * 需加引号，别名语法）', () => {
    const entry = fromYaml({ name: '*1' });
    assert.equal(hits(entry, 'edu1'), true);
    assert.equal(hits(entry, 'edu10'), false);
    assert.equal(hits(entry, 'edu'), false);
  });

  it('无通配字符时是精确匹配：edu1 不命中 edu10', () => {
    // 若实现成 startsWith/includes，edu1 会命中 edu10——作用域悄悄放宽
    const entry = fromYaml({ name: 'edu1' });
    assert.equal(hits(entry, 'edu1'), true);
    assert.equal(hits(entry, 'edu10'), false);
  });

  it('前缀/后缀大小写不敏感（与 sub use 口径一致）', () => {
    assert.equal(hits(fromYaml({ name: 'EDU*' }), 'edu1'), true);
    assert.equal(hits(fromYaml({ name: 'edu*' }), 'EDU1'), true);
    assert.equal(hits(fromYaml({ name: '*HK' }), 'edu-HK'), true);
  });

  it('数组内每项可各自带前缀/后缀通配', () => {
    const entry = fromYaml({ name: ['edu*', '*hk'] });
    assert.equal(hits(entry, 'edu2'), true);
    assert.equal(hits(entry, 'tokyo-hk'), true);
    assert.equal(hits(entry, 'hk-tokyo'), false);
    assert.equal(hits(entry, 'mini1'), false);
  });

  it('中文订阅名可用通配（SAFE_NAME_RE 允许中文）', () => {
    assert.equal(hits(fromYaml({ name: '教育*' }), '教育1'), true);
  });

  it('其余通配形态加载时报错：中间 *、多 *、?、单独 *（恒真）', () => {
    // 通用 glob 匹配器已删（正则转义实现曾有灾难性回溯），只保留字面前缀/后缀两种形态；
    // 单独 * 等于不限订阅，与「写了 match 想限定作用域」的意图相反
    for (const bad of ['e*1', '**', 'edu?', '?edu', '*']) {
      assert.throws(
        () => normalizeMatch({ name: bad }, 'overwrite.yaml'),
        (e: unknown) => {
          assert.ok(e instanceof CliError, `name: ${bad} 应抛 CliError`);
          assert.match((e as Error).message, /通配写法不支持/);
          return true;
        },
        `name: ${bad} 应被拒绝`,
      );
    }
  });

  it('fail-closed：scope 缺 subName 时带通配的 name 同样不应用', () => {
    assert.equal(selectActiveOverwriteFiles([fromYaml({ name: 'edu*' })], {}).length, 0);
  });

  it('name 与 url-domain 仍是 AND', () => {
    const entry = fromYaml({ name: 'edu*', 'url-domain': 'glados-config.com' });
    assert.equal(selectActiveOverwriteFiles([entry], { subName: 'edu1', subUrl: 'https://update.glados-config.com/x' }).length, 1);
    assert.equal(selectActiveOverwriteFiles([entry], { subName: 'edu1', subUrl: 'https://other.com/x' }).length, 0);
    assert.equal(selectActiveOverwriteFiles([entry], { subName: 'mini1', subUrl: 'https://update.glados-config.com/x' }).length, 0);
  });
});

describe('loadOverwriteFile：match 笔误形态', () => {
  it('`match:` 空值（条件块缩进笔误）→ 合并路径硬失败，不静默全局生效', () => {
    // 端到端回归：`match:` 下面的条件顶了格 → js-yaml 解析出 match: null + 顶层垃圾键。
    // 旧实现把 null 当「未写 match」→ 文件对所有订阅生效且垃圾键进最终配置
    const content = ['match:', 'name: edu*', 'log-level: debug'].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'overwrite.yaml'), content);
    try {
      assert.throws(() => loadOverwriteFile(), /match 为空/);
    } finally {
      fs.rmSync(path.join(tmpDir, 'overwrite.yaml'));
    }
  });
});

describe('loadOverwriteFile：近失文件名提示', () => {
  /** 收集 console.warn 输出，避免污染测试输出；loadOverwriteFile 的警告走 stderr 直出 */
  const captureWarn = (fn: () => void): string[] => {
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      lines.push(String(message));
    };
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return lines;
  };

  it('overwrite.yml 不被加载并打一行警告（主文件只认 overwrite.yaml）', () => {
    fs.writeFileSync(path.join(tmpDir, 'overwrite.yml'), 'log-level: debug\n');
    try {
      const warns = captureWarn(() => {
        const files = loadOverwriteFile();
        assert.deepEqual(
          files.map(f => f.name),
          [],
        );
      });
      assert.equal(warns.length, 1);
      assert.match(warns[0], /overwrite\.yml/);
      assert.match(warns[0], /overwrite\.yaml/);
    } finally {
      fs.rmSync(path.join(tmpDir, 'overwrite.yml'));
    }
  });

  it('合法扩展文件（overwrite.glados.yaml 与 .yml）正常加载且不警告', () => {
    fs.writeFileSync(path.join(tmpDir, 'overwrite.glados.yaml'), 'log-level: info\n');
    fs.writeFileSync(path.join(tmpDir, 'overwrite.glados.yml'), 'log-level: debug\n');
    try {
      const warns = captureWarn(() => {
        const files = loadOverwriteFile();
        assert.deepEqual(
          files.map(f => f.name),
          ['overwrite.glados.yaml', 'overwrite.glados.yml'],
        );
      });
      assert.deepEqual(warns, []);
    } finally {
      fs.rmSync(path.join(tmpDir, 'overwrite.glados.yaml'));
      fs.rmSync(path.join(tmpDir, 'overwrite.glados.yml'));
    }
  });

  it('无关与意图不明的文件不警告（误报零容忍，宁可漏报）', () => {
    // overwrite.yaml.bak 是用户故意改名禁用/编辑器备份；overwrit.yaml 拼写意图不明
    for (const name of ['overwrite.yaml.bak', 'notes.txt', 'overwrit.yaml']) {
      fs.writeFileSync(path.join(tmpDir, name), 'x: 1\n');
    }
    try {
      const warns = captureWarn(() => {
        const files = loadOverwriteFile();
        assert.deepEqual(files, []);
      });
      assert.deepEqual(warns, []);
    } finally {
      for (const name of ['overwrite.yaml.bak', 'notes.txt', 'overwrit.yaml']) {
        fs.rmSync(path.join(tmpDir, name));
      }
    }
  });
});

describe('覆写文件 enabled 开关', () => {
  const write = (name: string, content: string) => fs.writeFileSync(path.join(tmpDir, name), content);
  const cleanup = (...names: string[]) => {
    for (const n of names) fs.rmSync(path.join(tmpDir, n), { force: true });
  };

  it('enabled: false 的文件不参与合并，但仍被加载', () => {
    write('overwrite.off.yaml', 'enabled: false\nlog-level: debug\n');
    try {
      const files = loadOverwriteFile();
      assert.equal(files.length, 1);
      assert.equal(files[0].enabled, false);
      assert.deepEqual(selectActiveOverwriteFiles(files, {}), []);
    } finally {
      cleanup('overwrite.off.yaml');
    }
  });

  it('enabled: true 与缺省都生效', () => {
    write('overwrite.on.yaml', 'enabled: true\nlog-level: debug\n');
    write('overwrite.plain.yaml', 'log-level: info\n');
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(
        selectActiveOverwriteFiles(files, {}).map(f => f.name),
        ['overwrite.on.yaml', 'overwrite.plain.yaml'],
      );
      assert.deepEqual(
        files.map(f => f.enabled),
        [true, true],
      );
    } finally {
      cleanup('overwrite.on.yaml', 'overwrite.plain.yaml');
    }
  });

  it('enabled 是元数据键，不进最终配置', () => {
    write('overwrite.meta.yaml', 'enabled: true\nlog-level: debug\n');
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(Object.keys(files[0].config ?? {}), ['log-level']);
      // 内核对未知顶层键宽松（实测 mihomo -t 放行 enabled: false），剥离只能靠这里
      const merged = applyOverwrite({}, files, { mode: 'mixed' }).config;
      assert.ok(!('enabled' in merged), 'enabled 不得出现在合并结果中');
    } finally {
      cleanup('overwrite.meta.yaml');
    }
  });

  it('非布尔值报错：YAML 的 no/off 是字符串，按真值处理会让停用静默失效', () => {
    // js-yaml 5.x：no → "no"、off → "off"、空值 → null、0 → 数字，全都不是布尔
    for (const value of ['no', 'off', '"false"', '', '0']) {
      write('overwrite.bad.yaml', `enabled: ${value}\nlog-level: debug\n`);
      try {
        assert.throws(
          () => loadOverwriteFile(),
          (e: unknown) => {
            assert.ok(e instanceof CliError, `enabled: ${value} 应抛 CliError`);
            assert.equal((e as CliError).label, '覆写配置错误');
            assert.ok(
              (e as CliError).hint.some(h => h.includes('enabled: false')),
              'hint 应指明正确写法 enabled: false',
            );
            return true;
          },
        );
      } finally {
        cleanup('overwrite.bad.yaml');
      }
    }
  });

  it('禁用的文件仍出现在 ow 列表里并标注 enabled: false', () => {
    write('overwrite.listed.yaml', 'enabled: false\nmatch:\n  name: edu*\nlog-level: debug\n');
    try {
      const info = listOverwriteFile();
      assert.deepEqual(
        info.files.map(f => f.name),
        ['overwrite.listed.yaml'],
      );
      assert.equal(info.files[0].enabled, false);
      // 作用域照常展示：停用不等于看不见它管哪些订阅
      assert.equal(info.files[0].scope, 'name=edu*');
    } finally {
      cleanup('overwrite.listed.yaml');
    }
  });

  it('停用不掩盖 match 错误（避免一启用就炸）', () => {
    write('overwrite.badmatch.yaml', 'enabled: false\nmatch:\n  subscripton: edu1\nlog-level: debug\n');
    try {
      assert.throws(() => loadOverwriteFile(), CliError);
    } finally {
      cleanup('overwrite.badmatch.yaml');
    }
  });

  it('enabled 与 match 两道过滤在同一出口：启用但未命中同样不生效', () => {
    write('overwrite.both.yaml', 'match:\n  name: edu*\nlog-level: debug\n');
    try {
      const files = loadOverwriteFile();
      assert.equal(selectActiveOverwriteFiles(files, { subName: 'edu1' }).length, 1);
      assert.equal(selectActiveOverwriteFiles(files, { subName: 'mini1' }).length, 0);
    } finally {
      cleanup('overwrite.both.yaml');
    }
  });

  it('元数据键带操作符报错，不得绕过剥离落进配置', () => {
    // 剥离发生在解构、早于操作符解析：enabled!: false 既不停用文件，
    // 又会被规范成键 enabled 写进最终配置——正是本功能要消灭的静默失效。
    // <enabled> / ~enabled 走合并层的「已移除操作符」报错（下一用例），不在本列表
    for (const key of ['enabled!', 'match!', '+enabled', 'match+']) {
      write('overwrite.op.yaml', `${key}: false\nlog-level: debug\n`);
      try {
        assert.throws(
          () => loadOverwriteFile(),
          (e: unknown) => {
            assert.ok(e instanceof CliError, `${key} 应抛 CliError`);
            assert.equal((e as CliError).label, '覆写配置错误');
            assert.match((e as Error).message, /不支持操作符/);
            return true;
          },
          `${key} 应被拒绝`,
        );
      } finally {
        cleanup('overwrite.op.yaml');
      }
    }
  });

  it('<enabled> / ~enabled 在加载时是普通字面键，合并时报「已移除的操作符」', () => {
    // 尖括号转义与 ~ 已删：这两种元数据键变体不再是可解包形态，加载侧的
    // assertNoMetadataKeyLookalikes 认不出它们（parse 后键名不同），由合并层拦截
    for (const key of ['<enabled>', '~enabled']) {
      write('overwrite.op.yaml', `${key}: false\nlog-level: debug\n`);
      try {
        const files = loadOverwriteFile();
        assert.throws(
          () => applyOverwrite({}, selectActiveOverwriteFiles(files, {}), { mode: 'mixed' }),
          (e: unknown) => {
            assert.ok(e instanceof CliError, `${key} 合并时应抛 CliError`);
            assert.match((e as Error).message, /已移除/);
            return true;
          },
          `${key} 合并时应被拒绝`,
        );
      } finally {
        cleanup('overwrite.op.yaml');
      }
    }
  });

  it('元数据键的大小写/空白近失报错，不静默当普通配置键', () => {
    // YAML 键大小写敏感：`Enabled: false` 既不停用文件（剥离用精确键名），
    // 又会原样写进运行配置，而内核对未知顶层键不报错——用户零反馈。
    // 与操作符形态是同一种静默失效，只是走大小写这条路
    for (const key of ['Enabled', 'ENABLED', 'Match', 'MATCH', 'enabled ', ' enabled']) {
      write('overwrite.cap.yaml', `"${key}": false\nlog-level: debug\n`);
      try {
        assert.throws(
          () => loadOverwriteFile(),
          (e: unknown) => {
            assert.ok(e instanceof CliError, `${key} 应抛 CliError`);
            assert.equal((e as CliError).label, '覆写配置错误');
            assert.match((e as Error).message, /疑似想写元数据键/);
            return true;
          },
          `"${key}" 应被拒绝`,
        );
      } finally {
        cleanup('overwrite.cap.yaml');
      }
    }
  });

  it('与元数据键无关的键不被误伤（含形近但语义无关的）', () => {
    // 误报零容忍：只认「小写去空白后完全等于元数据键」，不做模糊猜测
    write('overwrite.ok.yaml', 'enabled-by: me\nmatcher: x\nmatches: [a]\nlog-level: debug\n');
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(Object.keys(files[0].config ?? {}).sort(), ['enabled-by', 'log-level', 'matcher', 'matches']);
      assert.equal(files[0].enabled, true);
    } finally {
      cleanup('overwrite.ok.yaml');
    }
  });

  it('名为 enabled 的普通嵌套键不受影响（只拦顶层元数据键的操作符形式）', () => {
    write('overwrite.nested.yaml', 'dns:\n  enabled: true\nlog-level: debug\n');
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(files[0].config?.dns, { enabled: true });
      assert.equal(files[0].enabled, true, '嵌套的 enabled 不该被当成文件开关');
    } finally {
      cleanup('overwrite.nested.yaml');
    }
  });

  it('YAML 别名陷阱：合并路径硬失败，诊断路径带加引号提示', () => {
    // name: *edu 是 YAML 别名语法而非通配。曾只 warn 一行就跳过文件、退出码 0，
    // 启动成功但覆写没生效；现合并路径硬失败，诊断路径（listOverwriteFile）红字可见
    write('overwrite.alias.yaml', 'match:\n  name: *edu\nlog-level: debug\n');
    try {
      assert.throws(
        () => loadOverwriteFile(),
        (e: unknown) => e instanceof CliError && /解析失败/.test((e as Error).message),
        '合并路径必须硬失败，不能 warn 后照常启动',
      );

      const info = listOverwriteFile();
      assert.equal(info.files.length, 0);
      assert.equal(info.broken.length, 1);
      assert.match(info.broken[0].message, /解析失败/);
      // 推广 glob 后前缀通配是自然写法，只说「解析失败」用户想不到是引号问题
      assert.match(info.broken[0].hint.join('\n'), /加引号/);
      assert.match(info.broken[0].hint.join('\n'), /name: "\*edu"/);
    } finally {
      cleanup('overwrite.alias.yaml');
    }
  });

  it('加引号后 * 开头的通配正常工作', () => {
    write('overwrite.quoted.yaml', 'match:\n  name: "*1"\nlog-level: debug\n');
    try {
      const files = loadOverwriteFile();
      assert.equal(selectActiveOverwriteFiles(files, { subName: 'edu1' }).length, 1);
      assert.equal(selectActiveOverwriteFiles(files, { subName: 'edu2' }).length, 0);
    } finally {
      cleanup('overwrite.quoted.yaml');
    }
  });
});

describe('summarizeMatch 作用域摘要（经 listOverwriteFile）', () => {
  const write = (name: string, content: string) => fs.writeFileSync(path.join(tmpDir, name), content);
  const cleanup = (name: string) => fs.rmSync(path.join(tmpDir, name), { force: true });

  it('name 与多条件的摘要形态', () => {
    write('overwrite.a.yaml', 'match:\n  name: edu*\nlog-level: debug\n');
    try {
      assert.equal(listOverwriteFile().files[0].scope, 'name=edu*');
    } finally {
      cleanup('overwrite.a.yaml');
    }
    write('overwrite.a.yaml', 'match:\n  name: [edu*, hk-1]\n  url-domain: glados-config.com\nlog-level: debug\n');
    try {
      assert.equal(listOverwriteFile().files[0].scope, 'name=edu*/hk-1, url-domain=glados-config.com');
    } finally {
      cleanup('overwrite.a.yaml');
    }
  });
});

describe('match 的 url-domain 通配符拦截', () => {
  // 回归：url-domain 只做字面后缀比对，值含通配符恒不命中——文件静默对任何订阅
  // 都不生效且零提示。订阅名 glob 推广后这是自然的误写方向
  it('url-domain 值含 * 或 ? → 报错并说明只做字面后缀比对', () => {
    assert.throws(() => normalizeMatch({ 'url-domain': '*.example.com' }, 'overwrite.yaml'), /url-domain 不支持通配符/);
    assert.throws(() => normalizeMatch({ 'url-domain': ['corp.com', 'gh?.com'] }, 'overwrite.yaml'), /gh\?\.com/);
  });

  it('纯字面 url-domain 不受影响', () => {
    assert.deepEqual(normalizeMatch({ 'url-domain': 'corp.com' }, 'overwrite.yaml'), { 'url-domain': ['corp.com'] });
  });
});

describe('覆写扩展文件加载顺序', () => {
  // 回归：排序曾用 localeCompare，同一组文件在不同 LANG 的机器上顺序不同（实测
  // ['dns','工作','机场'] en/zh_CN/ja 三种序），而排序即合并顺序——同一套覆写经
  // dotfiles 同步到不同机器会合并出不同运行配置。修复为码点序。
  // 用 B/a 这组文件名：任何 ICU locale 的 localeCompare 都排 a 先（字母序），
  // 码点序 B(0x42) 先——与测试机的 LANG 无关，旧实现此用例必红
  it('按码点序加载，与系统 locale 无关', () => {
    const names = ['overwrite.B.yaml', 'overwrite.a.yaml'];
    for (const name of names) {
      fs.writeFileSync(path.join(tmpDir, name), 'log-level: debug\n');
    }
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(
        files.map(f => f.name),
        names,
      );
    } finally {
      for (const name of names) {
        fs.rmSync(path.join(tmpDir, name));
      }
    }
  });

  it('YAML 全部在前、JS 脚本在后（声明式基底，程序化后处理）', () => {
    // z.yaml 码点序在 a.js 之后，但段序优先：YAML 段先于脚本段
    const names = ['overwrite.z.yaml', 'overwrite.a.js', 'overwrite.y.yaml'];
    fs.writeFileSync(path.join(tmpDir, 'overwrite.z.yaml'), 'log-level: debug\n');
    fs.writeFileSync(path.join(tmpDir, 'overwrite.y.yaml'), 'log-level: info\n');
    fs.writeFileSync(path.join(tmpDir, 'overwrite.a.js'), 'export default function () {}\n');
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(
        files.map(f => f.name),
        ['overwrite.y.yaml', 'overwrite.z.yaml', 'overwrite.a.js'],
      );
    } finally {
      for (const name of names) {
        fs.rmSync(path.join(tmpDir, name));
      }
    }
  });
});

describe('JS 覆写脚本', () => {
  const write = (name: string, content: string) => fs.writeFileSync(path.join(tmpDir, name), content);
  const cleanup = (name: string) => fs.rmSync(path.join(tmpDir, name), { force: true });
  // 每个用例用独立文件名：require 模块缓存按路径键控，CLI 短进程内文件不会变、
  // 生产无此问题，但测试会改写同一路径的内容，复用名字会命中缓存的旧模块

  it('.js 的 ESM 默认导出被加载（无 package.json 的数据目录里靠模块语法探测）', () => {
    write('overwrite.esm.js', 'export default function (config) { config.touched = true; }\n');
    try {
      const files = loadOverwriteFile();
      assert.equal(files.length, 1);
      assert.equal(typeof files[0].transform, 'function');
    } finally {
      cleanup('overwrite.esm.js');
    }
  });

  it('.mjs 与 .cjs（module.exports = fn）同样认', () => {
    write('overwrite.m.mjs', 'export default function (config) { config.a = 1; }\n');
    write('overwrite.c.cjs', 'module.exports = function (config) { config.b = 2; }\n');
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(
        files.map(f => f.name),
        ['overwrite.c.cjs', 'overwrite.m.mjs'],
      );
      assert.ok(files.every(f => typeof f.transform === 'function'));
    } finally {
      cleanup('overwrite.m.mjs');
      cleanup('overwrite.c.cjs');
    }
  });

  it('主脚本三形态 overwrite.js / overwrite.mjs / overwrite.cjs 都被认（主文件不限于 .js）', () => {
    // 只认 .js 的话，写 overwrite.mjs 的用户会静默不加载（typo 检测也不覆盖）——
    // README 承诺「或 .mjs / .cjs」，主文件与扩展文件必须同宽
    write('overwrite.mjs', 'export default function (config) { config.m = 1; }\n');
    write('overwrite.c.cjs', 'module.exports = function (config) { config.c = 1; }\n');
    try {
      const files = loadOverwriteFile();
      // 主脚本（overwrite.mjs）先于扩展脚本（码点序），与 YAML 的主文件优先同构
      assert.deepEqual(
        files.map(f => f.name),
        ['overwrite.mjs', 'overwrite.c.cjs'],
      );
    } finally {
      cleanup('overwrite.mjs');
      cleanup('overwrite.c.cjs');
    }
  });

  it('语法错误 → 加载失败进 broken（合并路径硬失败、诊断路径可见）', () => {
    write('overwrite.broken.js', 'export default function ( { }\n');
    try {
      assert.throws(
        () => loadOverwriteFile(),
        e => e instanceof CliError && /加载失败/.test((e as Error).message),
      );
      assert.equal(listOverwriteFile().broken.length, 1);
      assert.match(listOverwriteFile().broken[0].name, /overwrite\.broken\.js/);
    } finally {
      cleanup('overwrite.broken.js');
    }
  });

  it('缺少默认导出函数 → 加载失败并给出写法提示', () => {
    write('overwrite.nofn.js', 'export const x = 1;\n');
    try {
      assert.throws(
        () => loadOverwriteFile(),
        e => e instanceof CliError && /缺少变换函数/.test((e as Error).message),
      );
    } finally {
      cleanup('overwrite.nofn.js');
    }
  });

  it('执行：就地修改 config、返回值忽略、ctx 带订阅信息与 mode', () => {
    write(
      'overwrite.run.js',
      [
        'export default function (config, ctx) {',
        '  config["log-level"] = "debug";',
        '  config.seen = `${ctx.subscription.name}|${ctx.subscription.url}|${ctx.subscription.host}|${ctx.mode}`;',
        '  return { ignored: true };',
        '}',
      ].join('\n'),
    );
    try {
      const files = loadOverwriteFile();
      const scope = { subName: 'edu1', subUrl: 'https://sub.glados-config.com/x' };
      const r = applyOverwrite({}, selectActiveOverwriteFiles(files, scope), { mode: 'tun', scope });
      assert.equal(r.config['log-level'], 'debug');
      // host 是预解析 hostname；返回的对象被忽略（契约：就地修改）
      assert.equal(r.config.seen, 'edu1|https://sub.glados-config.com/x|sub.glados-config.com|tun');
    } finally {
      cleanup('overwrite.run.js');
    }
  });

  it('ctx.warn 的消息进 scriptWarnings 并带脚本名', () => {
    write('overwrite.warn.js', 'export default function (config, ctx) { ctx.warn("分组不存在，跳过"); }\n');
    try {
      const files = loadOverwriteFile();
      const r = applyOverwrite({}, files, { mode: 'mixed' });
      assert.deepEqual(r.scriptWarnings, ['分组不存在，跳过（脚本 overwrite.warn.js）']);
    } finally {
      cleanup('overwrite.warn.js');
    }
  });

  it('脚本无 match/enabled 概念，selectActiveOverwriteFiles 恒命中', () => {
    write('overwrite.scope.js', 'export default function () {}\n');
    try {
      const files = loadOverwriteFile();
      assert.equal(selectActiveOverwriteFiles(files, {}).length, 1);
      assert.equal(selectActiveOverwriteFiles(files, { subName: 'x' }).length, 1);
    } finally {
      cleanup('overwrite.scope.js');
    }
  });

  it('脚本执行抛错 → CliError 带文件名（与 YAML 解析失败同姿态）', () => {
    write('overwrite.throw.js', 'export default function () { throw new Error("boom"); }\n');
    try {
      assert.throws(
        () => applyOverwrite({}, loadOverwriteFile(), { mode: 'mixed' }),
        e => e instanceof CliError && /overwrite\.throw\.js/.test((e as Error).message) && /boom/.test((e as Error).message),
      );
    } finally {
      cleanup('overwrite.throw.js');
    }
  });

  it('async 函数返回 Promise → 报错（脚本必须是同步函数）', () => {
    write('overwrite.async.js', 'export default async function (config) { config.x = 1; }\n');
    try {
      assert.throws(
        () => applyOverwrite({}, loadOverwriteFile(), { mode: 'mixed' }),
        e => e instanceof CliError && /返回了 Promise/.test((e as Error).message),
      );
    } finally {
      cleanup('overwrite.async.js');
    }
  });

  it('脚本设置的锁定键经前后快照检出（剥除在 buildConfig，告警不静默）', () => {
    write('overwrite.lock.js', 'export default function (config) { config["allow-lan"] = true; config.tls = { a: 1 }; }\n');
    try {
      const r = applyOverwrite({ secret: 'old' }, loadOverwriteFile(), { mode: 'mixed' });
      // tls 与 LOCKED_CONFIG_KEYS 都在探针集里
      assert.deepEqual(
        r.scriptLockedHits.map(h => ({ file: h.file, keys: h.keys.sort() })),
        [{ file: 'overwrite.lock.js', keys: ['allow-lan', 'tls'] }],
      );
    } finally {
      cleanup('overwrite.lock.js');
    }
  });

  it('脚本改非锁定键不产生命中；嵌套内部的锁定键改动检不出（浅层快照，与 YAML 侧键级检测同粒度）', () => {
    write(
      'overwrite.nolock.js',
      'export default function (config) { config.dns = { ...(config.dns || {}), enable: true }; config["listeners"] = [{ type: "x" }]; }',
    );
    try {
      // listeners 是顶层锁定键（新设置会被检出）——把它拆出来：先验证顶层新设置检出
      const r = applyOverwrite({}, loadOverwriteFile(), { mode: 'mixed' });
      assert.deepEqual(
        r.scriptLockedHits.map(h => h.keys),
        [['listeners']],
      );
    } finally {
      cleanup('overwrite.nolock.js');
    }
  });

  it('YAML 合并结果先于脚本执行（脚本看到并修改的是合并后的配置）', () => {
    write('overwrite.base.yaml', 'log-level: info\nmode: rule\n');
    write('overwrite.after.js', 'export default function (config) { config["log-level"] = config.mode === "rule" ? "saw-rule" : "no"; }\n');
    try {
      const r = applyOverwrite({}, loadOverwriteFile(), { mode: 'mixed' });
      assert.equal(r.config['log-level'], 'saw-rule');
    } finally {
      cleanup('overwrite.base.yaml');
      cleanup('overwrite.after.js');
    }
  });

  it('ow 列表：脚本条目 kind=script、无字段清单', () => {
    write('overwrite.list.js', 'export default function () {}\n');
    try {
      const info = listOverwriteFile();
      assert.equal(info.files[0].kind, 'script');
      assert.deepEqual(info.files[0].keys, []);
    } finally {
      cleanup('overwrite.list.js');
    }
  });

  it('overwrite.ts 不被加载并提示改用 .js（TypeScript 不能直接执行）', () => {
    write('overwrite.ts', 'export default function () {}\n');
    write('overwrite.x.ts', 'export default function () {}\n');
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (message?: unknown) => {
      warns.push(String(message));
    };
    try {
      const files = loadOverwriteFile();
      assert.equal(files.length, 0);
      assert.equal(warns.length, 2);
      assert.ok(warns.every(w => /不会被当作覆写文件加载/.test(w)));
    } finally {
      console.warn = original;
      cleanup('overwrite.ts');
      cleanup('overwrite.x.ts');
    }
  });
});
