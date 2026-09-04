import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError } from './errors.js';
import { assertNoRemovedSshFlag, parseIntArg, parseMirrorArg, suggestSimilar } from './utils.js';

const TOKENS = ['start', 'stop', 'status', 'subscription', 'sub', 'kernel', 'ui'];

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

  // 以下此前会静默取到危险值：'5s' 被 parseInt 静默取成 5（ms）
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

describe('parseMirrorArg：--mirror-all 已移除（v3.10.0）', () => {
  it('显式报错，不静默按直连继续', () => {
    // 静默忽略会让用户以为 API 仍走镜像 —— 「不报错但行为不对」的失效方式
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror-all']),
      (e: unknown) => e instanceof CliError && /已移除/.test((e as CliError).message),
    );
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror-all=hk.gh-proxy.org']),
      (e: unknown) => e instanceof CliError,
    );
  });

  it('--mirror 仍正常工作（仅作用于产物下载）', () => {
    assert.equal(parseMirrorArg(['kernel', '--mirror']).mirror, 'https://v6.gh-proxy.org/');
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'gh.example.com']).mirror, 'https://gh.example.com/');
  });

  it('--no-mirror 显式直连', () => {
    assert.deepEqual(parseMirrorArg(['kernel', '--no-mirror']), { mirror: null, isOverride: true });
  });

  it('无镜像选项时不覆盖', () => {
    assert.deepEqual(parseMirrorArg(['kernel']), { mirror: null, isOverride: false });
  });
});

describe('assertNoRemovedSshFlag：--no-ssh 已移除（v4.0.0）', () => {
  it('显式报错，不静默忽略', () => {
    // 静默通过会让 `stop --no-ssh`（原意「停代理但留隧道」）变成「停代理」而用户不知情
    assert.throws(
      () => assertNoRemovedSshFlag(['stop', '--no-ssh']),
      (e: unknown) => e instanceof CliError,
    );
    assert.throws(
      () => assertNoRemovedSshFlag(['start', '--no-ssh=true']),
      (e: unknown) => e instanceof CliError,
    );
  });

  it('不含该选项时放行', () => {
    assert.doesNotThrow(() => assertNoRemovedSshFlag(['start', 'tun', '-s']));
    assert.doesNotThrow(() => assertNoRemovedSshFlag(undefined));
  });
});
