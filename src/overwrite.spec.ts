import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deepMergeWithOverrides, filterOverwriteFilesByScope, parseOverrideKey } from './overwrite.js';
import type { OverwriteFileEntry, OverwriteMatch } from './types.js';

describe('parseOverrideKey', () => {
  it('普通键无任何修饰', () => {
    assert.deepEqual(parseOverrideKey('dns'), {
      key: 'dns',
      forceOverwrite: false,
      arrayPrepend: false,
      arrayAppend: false,
      arrayMergeByName: false,
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

describe('matchesScope (经 filterOverwriteFilesByScope)', () => {
  const mk = (match: OverwriteMatch | undefined): OverwriteFileEntry => ({
    name: 'overwrite.yaml',
    path: '/tmp/overwrite.yaml',
    config: {},
    match,
  });

  it('无 match 全局生效', () => {
    const files = [mk(undefined)];
    assert.equal(filterOverwriteFilesByScope(files, { subName: 'x' }).length, 1);
  });

  it('subscription 命中订阅名', () => {
    const files = [mk({ subscription: ['home', 'work'] })];
    assert.equal(filterOverwriteFilesByScope(files, { subName: 'work' }).length, 1);
    assert.equal(filterOverwriteFilesByScope(files, { subName: 'other' }).length, 0);
  });

  it('subscription fail-closed：scope 缺 subName 不应用', () => {
    const files = [mk({ subscription: ['home'] })];
    assert.equal(filterOverwriteFilesByScope(files, {}).length, 0);
  });

  it('url-domain 后缀匹配 hostname 与子域', () => {
    const files = [mk({ 'url-domain': ['example.com'] })];
    assert.equal(filterOverwriteFilesByScope(files, { subUrl: 'https://sub.example.com/x' }).length, 1);
    assert.equal(filterOverwriteFilesByScope(files, { subUrl: 'https://example.com/x' }).length, 1);
    assert.equal(filterOverwriteFilesByScope(files, { subUrl: 'https://evil.com/x' }).length, 0);
  });

  it('url-domain fail-closed：scope 缺 subUrl 不应用', () => {
    const files = [mk({ 'url-domain': ['example.com'] })];
    assert.equal(filterOverwriteFilesByScope(files, {}).length, 0);
  });

  it('多条件 AND：全部满足才应用', () => {
    const files = [mk({ subscription: ['home'], 'url-domain': ['example.com'] })];
    assert.equal(filterOverwriteFilesByScope(files, { subName: 'home', subUrl: 'https://example.com' }).length, 1);
    assert.equal(filterOverwriteFilesByScope(files, { subName: 'home', subUrl: 'https://other.com' }).length, 0);
    assert.equal(filterOverwriteFilesByScope(files, { subName: 'work', subUrl: 'https://example.com' }).length, 0);
  });
});
