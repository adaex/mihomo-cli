import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError } from './errors.js';
import { parseIntArg, suggestSimilar } from './utils.js';

const TOKENS = ['start', 'stop', 'status', 'subscription', 'sub', 'test', 'clean', 'ui'];

describe('suggestSimilar', () => {
  it('前缀匹配命中（含别名），按相似度排序', () => {
    assert.deepEqual(suggestSimilar('su', TOKENS), ['sub', 'subscription']);
  });

  it('编辑距离 <= 2 命中拼错的命令', () => {
    assert.ok(suggestSimilar('strt', TOKENS).includes('start'));
    assert.ok(suggestSimilar('stats', TOKENS).includes('status'));
  });

  it('大小写不敏感', () => {
    assert.ok(suggestSimilar('START', TOKENS).includes('start'));
  });

  it('完全一致不返回（调用方仅在未命中时使用）', () => {
    assert.ok(!suggestSimilar('start', TOKENS).includes('start'));
  });

  it('无相近词返回空数组', () => {
    assert.deepEqual(suggestSimilar('zzzzzzzz', TOKENS), []);
  });

  it('至多返回 3 个候选', () => {
    const many = ['abc', 'abd', 'abe', 'abf', 'abg'];
    assert.ok(suggestSimilar('abx', many).length <= 3);
  });
});

describe('parseIntArg 范围与格式校验', () => {
  const T = (args: string[]) => parseIntArg(args, '-t', '--timeout', 2000);

  it('合法正整数（空格形式）', () => {
    assert.equal(T(['x', '-t', '3000']), 3000);
  });

  it('合法正整数（= 形式）', () => {
    assert.equal(T(['x', '--timeout=3000']), 3000);
  });

  it('缺省返回默认值', () => {
    assert.equal(T(['x']), 2000);
  });

  it('无关 flag 不受影响', () => {
    assert.equal(T(['x', '-o', '-s']), 2000);
  });

  // 以下此前会静默取到危险值：0 让测速起 0 个 worker 报「全部失败」，'5s' 静默取 5ms
  for (const bad of ['0', '-1', '5s', 'abc', '', '1.5', ' ']) {
    it(`拒绝非法值 ${JSON.stringify(bad)}`, () => {
      assert.throws(
        () => T(['x', '-t', bad]),
        (e: unknown) => e instanceof CliError,
      );
    });
  }

  it('缺少值时报错', () => {
    assert.throws(
      () => T(['x', '-t']),
      (e: unknown) => e instanceof CliError,
    );
  });
});
