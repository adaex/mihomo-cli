import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CliError } from './errors.js';
import type { OverwriteFileEntry, OverwriteMatch, SkippedMerge } from './types.js';

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
      arrayMergeByName: false,
      arrayMergeOnly: false,
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

  it('~key 按 name 就地合并', () => {
    const r = parseOverrideKey('~proxies');
    assert.equal(r.key, 'proxies');
    assert.equal(r.arrayMergeByName, true);
    assert.equal(r.arrayMergeOnly, false);
  });

  it('~?key 按 name 合并且不新增', () => {
    const r = parseOverrideKey('~?proxy-groups');
    assert.equal(r.key, 'proxy-groups');
    assert.equal(r.arrayMergeByName, true);
    assert.equal(r.arrayMergeOnly, true);
  });

  it('<~?key> 转义：键名本身以 ~? 开头', () => {
    const r = parseOverrideKey('<~?weird>');
    assert.equal(r.key, '~?weird');
    assert.equal(r.arrayMergeByName, false);
    assert.equal(r.arrayMergeOnly, false);
  });

  it('<+key> 转义：键名本身以 + 开头', () => {
    const r = parseOverrideKey('<+dns>');
    assert.equal(r.key, '+dns');
    assert.equal(r.arrayPrepend, false);
    assert.equal(r.arrayAppend, false);
  });

  it('+<+key> 转义键名 + 前置语义', () => {
    const r = parseOverrideKey('+<+dns>');
    assert.equal(r.key, '+dns');
    assert.equal(r.arrayPrepend, true);
  });

  it('<key>+ 转义键名 + 追加语义', () => {
    const r = parseOverrideKey('<+dns>+');
    assert.equal(r.key, '+dns');
    assert.equal(r.arrayAppend, true);
  });

  it('key!（含尖括号转义）仍识别 forceOverwrite', () => {
    const r = parseOverrideKey('<+dns>!');
    assert.equal(r.key, '+dns');
    assert.equal(r.forceOverwrite, true);
  });

  // 回归：尖括号解包此前只在剥 ~ 之前尝试一次，~<weird> 会解析成 mergeByName + 键名 <weird>
  //（尖括号残留），与 +<+dns> / <+dns>+ / <+dns>! 的组合形态不自洽
  it('~<key> 组合：按 name 合并 + 解包尖括号，键名不再残留尖括号', () => {
    const r = parseOverrideKey('~<weird>');
    assert.equal(r.key, 'weird');
    assert.equal(r.arrayMergeByName, true);
    assert.equal(r.arrayMergeOnly, false);
  });

  it('~?<key> 组合：按 name 合并 + 不新增 + 解包尖括号', () => {
    const r = parseOverrideKey('~?<weird>');
    assert.equal(r.key, 'weird');
    assert.equal(r.arrayMergeByName, true);
    assert.equal(r.arrayMergeOnly, true);
  });

  it('~<+key> 组合：转义以 + 开头的键名再按 name 合并', () => {
    const r = parseOverrideKey('~<+dns>');
    assert.equal(r.key, '+dns');
    assert.equal(r.arrayMergeByName, true);
  });

  it('互斥修饰的解析形态（报错在合并层，这里锁住各组合确实置出多个位）', () => {
    // 这些组合是否报错由 deepMergeWithOverrides 的断言锁；这里确认解析结果本身
    assert.equal(parseOverrideKey('+rules+').arrayPrepend && parseOverrideKey('+rules+').arrayAppend, true);
    assert.equal(parseOverrideKey('~dns!').arrayMergeByName && parseOverrideKey('~dns!').forceOverwrite, true);
  });
});

describe('互斥操作符与空键：合并层显式报错，不静默按分支优先级取其一', () => {
  for (const key of ['+rules+', '~dns!', '~?dns!', '<dns>+!', '~<dns>!', 'rules+!']) {
    it(`"${key}" 含互斥操作符 → CliError`, () => {
      assert.throws(
        () => deepMergeWithOverrides({ rules: ['A'], dns: {} }, { [key]: ['x'] }),
        e => e instanceof CliError && /互斥的操作符/.test(e.message),
      );
    });
  }

  it('合法的单一操作符组合不被误伤（~?、尖括号转义、+<+key> 等）', () => {
    assert.doesNotThrow(() => deepMergeWithOverrides({}, { '~?proxy-groups': [{ name: 'G' }] }));
    // ~<dns> 对不存在的目标走「新增数组」，不与既有映射冲突
    assert.doesNotThrow(() => deepMergeWithOverrides({}, { '~<dns>': [{ name: 'x' }] }));
    assert.doesNotThrow(() => deepMergeWithOverrides({ rules: [] }, { '+<+rules>': ['x'] }));
    assert.doesNotThrow(() => deepMergeWithOverrides({ rules: [] }, { '<+rules>!': ['x'] }));
  });

  for (const key of ['+', '~', '!', '~?']) {
    it(`裸操作符 "${key}" 解析出空键名 → CliError`, () => {
      assert.throws(
        () => deepMergeWithOverrides({}, { [key]: 'x' }),
        e => e instanceof CliError && /键名不能为空/.test(e.message),
      );
    });
  }
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

  it('~key 就地 patch 同名元素、追加新元素', () => {
    const target = {
      proxies: [
        { name: 'a', server: '1.1.1.1', port: 1 },
        { name: 'b', port: 2 },
      ],
    };
    const override = {
      '~proxies': [
        { name: 'a', port: 99 },
        { name: 'c', port: 3 },
      ],
    };
    const r = deepMergeWithOverrides(target, override);
    assert.deepEqual(r.proxies, [
      { name: 'a', server: '1.1.1.1', port: 99 },
      { name: 'b', port: 2 },
      { name: 'c', port: 3 },
    ]);
  });

  it('~key 不得污染原 target 数组（禁止原地改写）', () => {
    const original = [{ name: 'a', port: 1 }];
    const target = { proxies: original };
    deepMergeWithOverrides(target, { '~proxies': [{ name: 'a', port: 2 }] });
    // 原数组元素必须保持不变
    assert.deepEqual(original, [{ name: 'a', port: 1 }]);
  });

  // ~?key：只改已有、不新增。真实事故：机场的两条订阅 URL 同域名，覆写按 url-domain 生效，
  // 其中一条没有 Developer 分组，~proxy-groups 的补丁被追加成缺 type 的残缺分组，
  // 内核拒绝加载整份配置。用 ~? 表达「订阅下发了我才改」
  it('~?key 命中同名元素时与 ~key 行为一致', () => {
    const target = { 'proxy-groups': [{ name: 'Developer', type: 'select', proxies: ['A'] }] };
    const r = deepMergeWithOverrides(target, { '~?proxy-groups': [{ name: 'Developer', 'default-selected': 'TW' }] });
    assert.deepEqual(r['proxy-groups'], [{ name: 'Developer', type: 'select', proxies: ['A'], 'default-selected': 'TW' }]);
  });

  it('~?key 未命中同名元素时跳过，不追加残缺元素', () => {
    const target = { 'proxy-groups': [{ name: 'Auto', type: 'url-test' }] };
    const skipped: SkippedMerge[] = [];
    const r = deepMergeWithOverrides(target, { '~?proxy-groups': [{ name: 'Developer', 'default-selected': 'TW' }] }, skipped);
    assert.deepEqual(r['proxy-groups'], [{ name: 'Auto', type: 'url-test' }]);
    assert.deepEqual(skipped, [{ key: 'proxy-groups', name: 'Developer' }]);
  });

  it('~?key 的目标键整体不存在时也跳过（不凭空造出数组）', () => {
    const skipped: SkippedMerge[] = [];
    const r = deepMergeWithOverrides({}, { '~?proxy-groups': [{ name: 'Developer' }] }, skipped);
    assert.deepEqual(r['proxy-groups'], []);
    assert.equal(skipped.length, 1);
  });

  it('~key 未命中仍追加（ssh 出口靠它新增节点，语义不受 ~? 影响）', () => {
    const skipped: SkippedMerge[] = [];
    const r = deepMergeWithOverrides({ proxies: [] }, { '~proxies': [{ name: 'SSH-work', type: 'socks5' }] }, skipped);
    assert.deepEqual(r.proxies, [{ name: 'SSH-work', type: 'socks5' }]);
    assert.deepEqual(skipped, []);
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

  it('~key 元素补丁的字段同样字面（元素字段不再当操作符解析）', () => {
    const target = { 'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'] }] };
    const r = deepMergeWithOverrides(target, { '~proxy-groups': [{ name: 'G', 'x+': [1] }] });
    assert.deepEqual(r['proxy-groups'], [{ name: 'G', type: 'select', proxies: ['A'], 'x+': [1] }]);
  });

  it('~<key> 顶层组合在合并中生效：按 name 合并且键名不带尖括号', () => {
    const target = { weird: [{ name: 'a', port: 1 }] };
    const r = deepMergeWithOverrides(target, { '~<weird>': [{ name: 'a', port: 2 }] });
    assert.deepEqual(r.weird, [{ name: 'a', port: 2 }]);
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

  it('subscription 命中订阅名', () => {
    const files = [mk({ subscription: ['home', 'work'] })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'work' }).length, 1);
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'other' }).length, 0);
  });

  it('subscription fail-closed：scope 缺 subName 不应用', () => {
    const files = [mk({ subscription: ['home'] })];
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
    const files = [mk({ subscription: ['home'], 'url-domain': ['example.com'] })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home', subUrl: 'https://example.com' }).length, 1);
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home', subUrl: 'https://other.com' }).length, 0);
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'work', subUrl: 'https://example.com' }).length, 0);
  });
});

describe('deepMergeWithOverrides 数组语义误用（~key / +key 作用于非数组）', () => {
  // 此前会静默包成单元素数组：~dns 把映射变成 [{...}] 并丢掉原字段，生成 mihomo 无法解析的配置
  const misuse: { label: string; base: Record<string, unknown>; override: Record<string, unknown> }[] = [
    { label: '~key 作用于映射', base: { dns: { enable: false, listen: 'x' } }, override: { '~dns': { enable: true } } },
    { label: '~key 作用于标量', base: { mode: 'rule' }, override: { '~mode': 'global' } },
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

  it('~key 目标不存在时放行（新增数组的正常用法）', () => {
    assert.deepEqual(deepMergeWithOverrides({}, { '~proxies': [{ name: 'A' }] }), { proxies: [{ name: 'A' }] });
  });

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
    const files = [file({ subscription: 'home' })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'Home' }).length, 1);
  });

  it('match 值大写命中小写订阅名', () => {
    const files = [file({ subscription: 'HOME' })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home' }).length, 1);
  });

  it('名称不同仍不命中', () => {
    const files = [file({ subscription: 'work' })];
    assert.equal(selectActiveOverwriteFiles(files, { subName: 'home' }).length, 0);
  });

  it('数组形式逐项大小写不敏感', () => {
    const files = [file({ subscription: ['Work', 'home'] })];
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

  it('无 match 块返回 undefined（默认全局生效）', () => {
    assert.equal(normalizeMatch(undefined, 'overwrite.yaml'), undefined);
    assert.equal(normalizeMatch(null, 'overwrite.yaml'), undefined);
  });

  it('正常 match 块解析为条件', () => {
    const match = normalizeMatch({ subscription: 'work', 'url-domain': ['corp.com', 'github.com'] }, 'overwrite.yaml');
    // subscriptionKey 是展示用的原键名标记，不是条件（见 OverwriteMatch 注释）
    assert.deepEqual(match, { subscription: ['work'], subscriptionKey: 'subscription', 'url-domain': ['corp.com', 'github.com'] });
  });

  it('name 归一到 subscription 字段并记下原键名', () => {
    assert.deepEqual(normalizeMatch({ name: 'edu*' }, 'overwrite.yaml'), { subscription: ['edu*'], subscriptionKey: 'name' });
  });

  it('键名打错（subscripton）抛错而非静默全局生效', () => {
    // 回归：旧实现 warn + 忽略未知键 → 返回 undefined → 该文件对所有订阅生效。
    // 用户写了 match 显然想限定作用域，fail-open 是比报错严重得多的静默失效
    assertConfigError(() => normalizeMatch({ subscripton: 'work' }, 'overwrite.yaml'));
  });

  it('多条件里部分键打错同样抛错（否则 AND 条件被弱化、作用域放宽）', () => {
    assertConfigError(() => normalizeMatch({ subscription: 'work', 'url-domian': 'corp.com' }, 'overwrite.yaml'));
  });

  it('值滤空（空数组/非字符串）抛错', () => {
    assertConfigError(() => normalizeMatch({ subscription: [] }, 'overwrite.yaml'));
    assertConfigError(() => normalizeMatch({ subscription: 123 }, 'overwrite.yaml'));
  });

  it('match 为数组/标量抛错', () => {
    assertConfigError(() => normalizeMatch(['subscription'], 'overwrite.yaml'));
    assertConfigError(() => normalizeMatch('work', 'overwrite.yaml'));
  });

  it('空 match 块抛错（写了 match 即显式要求限定作用域）', () => {
    assertConfigError(() => normalizeMatch({}, 'overwrite.yaml'));
  });
});

describe('applyOverwrite：嵌套层形似操作符键的告警', () => {
  const file = (config: Record<string, unknown>): OverwriteFileEntry => ({ name: 'overwrite.yaml', path: '/tmp/overwrite.yaml', config });

  it('嵌套层形似操作符的键按字面保留并逐键告警（带文件名）', () => {
    const r = applyOverwrite({ dns: { enable: true } }, [file({ dns: { '~x': 1, 'y+': 2, 'z!': 3, '+a': 4, '<+.b>': 5 } })]);
    assert.deepEqual(r.config.dns, { enable: true, '~x': 1, 'y+': 2, 'z!': 3, '+a': 4, '<+.b>': 5 });
    assert.deepEqual(
      r.operatorShapedKeys.map(k => k.key),
      ['~x', 'y+', 'z!', '+a', '<+.b>'],
    );
    assert.ok(r.operatorShapedKeys.every(k => k.file === 'overwrite.yaml'));
  });

  it('同一文件同一键出现在多个嵌套映射只告警一次（每文件每键一次）', () => {
    const target = { dns: { enable: true }, hosts: { 'a.com': '1.1.1.1' } };
    const r = applyOverwrite(target, [file({ dns: { '~x': 1 }, hosts: { '~x': 2 } })]);
    assert.deepEqual(r.operatorShapedKeys, [{ key: '~x', file: 'overwrite.yaml' }]);
  });

  it('+. 开头的嵌套键是 mihomo 原生通配域名形态，字面保留且不告警', () => {
    const target = { dns: { 'nameserver-policy': { 'geosite:cn': 'https://doh.pub/dns-query' } } };
    const r = applyOverwrite(target, [file({ dns: { 'nameserver-policy': { '+.corp.example.com': 'https://x' } } })]);
    assert.deepEqual(r.operatorShapedKeys, []);
    assert.deepEqual((r.config.dns as Record<string, unknown>)['nameserver-policy'], {
      'geosite:cn': 'https://doh.pub/dns-query',
      '+.corp.example.com': 'https://x',
    });
  });

  it('顶层操作符键是正常用法，不告警', () => {
    const r = applyOverwrite({ rules: ['A'] }, [file({ 'rules+': ['B'], '~proxies': [{ name: 'p', type: 'socks5' }] })]);
    assert.deepEqual(r.operatorShapedKeys, []);
    assert.deepEqual(r.config.rules, ['A', 'B']);
  });

  it('~key 元素补丁里的形似操作符字段同样告警', () => {
    const target = { 'proxy-groups': [{ name: 'G', type: 'select' }] };
    const r = applyOverwrite(target, [file({ '~proxy-groups': [{ name: 'G', 'x+': [1] }] })]);
    assert.deepEqual(r.operatorShapedKeys, [{ key: 'x+', file: 'overwrite.yaml' }]);
  });

  it('移植路径的值不解析也不告警（移植本就字面，目标无该键时不产生告警）', () => {
    const r = applyOverwrite({}, [file({ hosts: { '<+.google.cn>': '8.8.8.8' } })]);
    assert.deepEqual(r.config.hosts, { '<+.google.cn>': '8.8.8.8' });
    assert.deepEqual(r.operatorShapedKeys, []);
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

describe('match name 别名与订阅名 glob', () => {
  const file = (match: OverwriteMatch): OverwriteFileEntry => ({ name: 'overwrite.x.yaml', path: '/x', config: {}, match });
  /** 经 normalizeMatch 走一遍，验证的是「用户写的 YAML」而非手搓的内部结构 */
  const fromYaml = (match: Record<string, unknown>): OverwriteFileEntry => ({
    name: 'overwrite.x.yaml',
    path: '/x',
    config: {},
    match: normalizeMatch(match, 'overwrite.x.yaml'),
  });
  const hits = (entry: OverwriteFileEntry, subName: string): boolean => selectActiveOverwriteFiles([entry], { subName }).length === 1;

  it('name 是 subscription 的同义键，归一到同一判据', () => {
    assert.equal(hits(fromYaml({ name: 'edu1' }), 'edu1'), true);
    assert.equal(hits(fromYaml({ subscription: 'edu1' }), 'edu1'), true);
    assert.equal(hits(fromYaml({ name: 'edu1' }), 'mini1'), false);
  });

  it('name: edu* 命中同前缀的多条订阅，不命中其他机场套餐', () => {
    const entry = fromYaml({ name: 'edu*' });
    for (const name of ['edu1', 'edu2', 'edu-hk']) {
      assert.equal(hits(entry, name), true, `${name} 应命中 edu*`);
    }
    assert.equal(hits(entry, 'mini1'), false);
  });

  it('? 只匹配单个字符', () => {
    const entry = fromYaml({ name: 'edu?' });
    assert.equal(hits(entry, 'edu1'), true);
    assert.equal(hits(entry, 'edu-hk'), false);
  });

  it('无通配字符时退化为精确匹配（旧写法行为不变）', () => {
    // 若实现成 startsWith/includes，edu1 会命中 edu10——作用域悄悄放宽
    const entry = fromYaml({ name: 'edu1' });
    assert.equal(hits(entry, 'edu1'), true);
    assert.equal(hits(entry, 'edu10'), false);
  });

  it('全串匹配：通配不在两端时不产生半匹配', () => {
    assert.equal(hits(fromYaml({ name: 'edu*' }), 'xedu1'), false);
    assert.equal(hits(fromYaml({ name: '*edu' }), 'edu1'), false);
    assert.equal(hits(fromYaml({ name: '*edu*' }), 'xedu1'), true);
  });

  it('除 * 与 ? 外的字符一律字面，不当通配或正则', () => {
    // 无通配字符的模式走精确比对快路径；含通配时走匹配器主循环，
    // 两条路径都要覆盖。实现换成双指针后这些字符不再有特殊含义，
    // 本组用例同时锁住「不许有人图省事换回正则拼接」
    assert.equal(hits(fromYaml({ name: 'a.c' }), 'abc'), false);
    assert.equal(hits(fromYaml({ name: 'a.c' }), 'a.c'), true);
    assert.equal(hits(fromYaml({ name: 'a.c*' }), 'abcd'), false);
    assert.equal(hits(fromYaml({ name: 'a.c*' }), 'a.cd'), true);
    assert.equal(hits(fromYaml({ name: 'a+b*' }), 'aab'), false);
    assert.equal(hits(fromYaml({ name: 'a+b*' }), 'a+bc'), true);
    assert.equal(hits(fromYaml({ name: 'x(y)*' }), 'xy'), false);
    assert.equal(hits(fromYaml({ name: 'x(y)*' }), 'x(y)z'), true);
    // 这些形态在正则实现里会让 new RegExp 抛未捕获异常（而非 CliError）
    for (const pattern of ['[*', '(*', '*)', '{*', '|*', '[a-*', '(?*', 'a\\*']) {
      assert.doesNotThrow(() => hits(fromYaml({ name: pattern }), 'edu1'), `pattern ${pattern} 不得抛异常`);
    }
    assert.equal(hits(fromYaml({ name: 'a\\b*' }), 'a\\bc'), true);
    assert.equal(hits(fromYaml({ name: '[x]*' }), '[x]y'), true);
    assert.equal(hits(fromYaml({ name: '[x]*' }), 'x'), false);
  });

  it('glob 大小写不敏感（与 sub use 口径一致）', () => {
    assert.equal(hits(fromYaml({ name: 'EDU*' }), 'edu1'), true);
    assert.equal(hits(fromYaml({ name: 'edu*' }), 'EDU1'), true);
  });

  it('数组内每项各自可带 glob', () => {
    const entry = fromYaml({ name: ['edu*', 'hk-?'] });
    assert.equal(hits(entry, 'edu2'), true);
    assert.equal(hits(entry, 'hk-1'), true);
    assert.equal(hits(entry, 'hk-tokyo'), false);
    assert.equal(hits(entry, 'mini1'), false);
  });

  it('subscription 旧键名同样享有通配（两键同义，不能只给 name 开）', () => {
    assert.equal(hits(fromYaml({ subscription: 'edu*' }), 'edu2'), true);
  });

  it('连续 * 等价于单个 *', () => {
    assert.equal(hits(fromYaml({ name: 'e**1' }), 'edu1'), true);
    assert.equal(hits(fromYaml({ name: '**' }), 'anything'), true);
  });

  it('多星 pattern 不产生灾难性回溯（合法长度内即可挂死 CLI）', () => {
    // 回归：最初用「转义成正则再 test」，这组输入实测跑 70 秒——64 正是 SAFE_NAME_RE
    // 的长度上限，即完全合法的订阅名就能触发。现用双指针贪心回溯，O(n×m) 上界
    const evil = { name: `${'*a'.repeat(20)}*b` };
    const longName = 'a'.repeat(64);
    const started = Date.now();
    assert.equal(hits(fromYaml(evil), longName), false);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `多星匹配应在毫秒级完成，实际 ${elapsed}ms`);
  });

  it('贪心回溯的正确性：* 需要回退让后续字面段命中', () => {
    // 双指针实现的关键路径——第一个 * 贪心吃太多时必须能回退
    assert.equal(hits(fromYaml({ name: '*b' }), 'abcb'), true);
    assert.equal(hits(fromYaml({ name: '*b*c' }), 'abxc'), true);
    assert.equal(hits(fromYaml({ name: 'a*b*c' }), 'axbyc'), true);
    assert.equal(hits(fromYaml({ name: 'a*b*c' }), 'axbyd'), false);
    assert.equal(hits(fromYaml({ name: '*a*a*b' }), 'aab'), true);
    assert.equal(hits(fromYaml({ name: '*a*a*b' }), 'ab'), false);
  });

  it('? 与 * 混用及尾部通配的边界', () => {
    assert.equal(hits(fromYaml({ name: '?*' }), 'a'), true);
    assert.equal(hits(fromYaml({ name: '?*' }), ''), false);
    assert.equal(hits(fromYaml({ name: '*?' }), 'ab'), true);
    assert.equal(hits(fromYaml({ name: 'a*' }), 'a'), true, '* 可匹配空串');
    assert.equal(hits(fromYaml({ name: 'a?' }), 'a'), false, '? 必须吃掉一个字符');
  });

  it('中文订阅名可用通配（SAFE_NAME_RE 允许中文）', () => {
    assert.equal(hits(fromYaml({ name: '教育*' }), '教育1'), true);
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

  it('name 与 subscription 同时出现 → CliError（同义键无法判断以谁为准）', () => {
    assert.throws(
      () => normalizeMatch({ name: 'edu1', subscription: 'mini1' }, 'overwrite.x.yaml'),
      (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.equal((e as CliError).label, '覆写配置错误');
        assert.match((e as Error).message, /同时写了 name 与 subscription/);
        return true;
      },
    );
  });

  it('两者同时出现即报错，值相同也不放行（不猜测意图）', () => {
    assert.throws(() => normalizeMatch({ name: 'edu1', subscription: 'edu1' }, 'overwrite.x.yaml'), CliError);
  });

  it('内部归一后仍只有一处判据：直接构造 subscription 字段行为一致', () => {
    assert.equal(hits(file({ subscription: ['edu*'] }), 'edu9'), true);
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
      assert.deepEqual(Object.keys(files[0].config), ['log-level']);
      // 内核对未知顶层键宽松（实测 mihomo -t 放行 enabled: false），剥离只能靠这里
      const merged = applyOverwrite({}, files).config;
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
    // 又会被规范成键 enabled 写进最终配置——正是本功能要消灭的静默失效
    for (const key of ['enabled!', 'match!', '+enabled', 'match+', '<enabled>', '~enabled']) {
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
      assert.deepEqual(Object.keys(files[0].config).sort(), ['enabled-by', 'log-level', 'matcher', 'matches']);
      assert.equal(files[0].enabled, true);
    } finally {
      cleanup('overwrite.ok.yaml');
    }
  });

  it('名为 enabled 的普通嵌套键不受影响（只拦顶层元数据键的操作符形式）', () => {
    write('overwrite.nested.yaml', 'dns:\n  enabled: true\nlog-level: debug\n');
    try {
      const files = loadOverwriteFile();
      assert.deepEqual(files[0].config.dns, { enabled: true });
      assert.equal(files[0].enabled, true, '嵌套的 enabled 不该被当成文件开关');
    } finally {
      cleanup('overwrite.nested.yaml');
    }
  });

  it('YAML 别名陷阱：* 开头的值解析失败时提示加引号', () => {
    // name: *edu 是 YAML 别名语法而非通配，整个文件会被跳过；
    // 推广 glob 后前缀通配是自然写法，只说「解析失败」用户想不到是引号问题
    write('overwrite.alias.yaml', 'match:\n  name: *edu\nlog-level: debug\n');
    const original = console.warn;
    const lines: string[] = [];
    console.warn = (m?: unknown) => {
      lines.push(String(m));
    };
    try {
      assert.deepEqual(loadOverwriteFile(), []);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /解析失败/);
      assert.match(lines[0], /加引号/);
      assert.match(lines[0], /name: "\*edu"/);
    } finally {
      console.warn = original;
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

describe('summarizeMatch 回显用户写的原键名（经 listOverwriteFile）', () => {
  const write = (name: string, content: string) => fs.writeFileSync(path.join(tmpDir, name), content);
  const cleanup = (name: string) => fs.rmSync(path.join(tmpDir, name), { force: true });

  it('写 name 显示 name=，写 subscription 显示 subscription=', () => {
    // 内部归一到 subscription，但展示回显原键名——否则用户拿显示的键名回文件里搜不到
    write('overwrite.a.yaml', 'match:\n  name: edu*\nlog-level: debug\n');
    try {
      assert.equal(listOverwriteFile().files[0].scope, 'name=edu*');
    } finally {
      cleanup('overwrite.a.yaml');
    }
    write('overwrite.a.yaml', 'match:\n  subscription: edu1\nlog-level: debug\n');
    try {
      assert.equal(listOverwriteFile().files[0].scope, 'subscription=edu1');
    } finally {
      cleanup('overwrite.a.yaml');
    }
  });

  it('多条件与数组值的摘要形态', () => {
    write('overwrite.a.yaml', 'match:\n  name: [edu*, hk-1]\n  url-domain: glados-config.com\nlog-level: debug\n');
    try {
      assert.equal(listOverwriteFile().files[0].scope, 'name=edu*/hk-1, url-domain=glados-config.com');
    } finally {
      cleanup('overwrite.a.yaml');
    }
  });

  it('subscriptionKey 是展示元数据，不当作条件输出', () => {
    write('overwrite.a.yaml', 'match:\n  name: edu1\nlog-level: debug\n');
    try {
      const scope = listOverwriteFile().files[0].scope ?? '';
      assert.ok(!scope.includes('subscriptionKey'), `摘要不应含 subscriptionKey，实际: ${scope}`);
    } finally {
      cleanup('overwrite.a.yaml');
    }
  });
});
