import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { maskUrl } from './settings.js';

describe('maskUrl', () => {
  it('遮蔽 query 中的 token 类参数', () => {
    const r = maskUrl('https://example.com/sub?token=secret123&foo=bar');
    assert.ok(r.includes('token=***'));
    assert.ok(r.includes('foo=bar'));
    assert.ok(!r.includes('secret123'));
  });

  it('遮蔽 userinfo（用户名/密码）', () => {
    const r = maskUrl('https://user:pass@example.com/sub');
    assert.ok(!r.includes('user'));
    assert.ok(!r.includes('pass'));
    assert.ok(r.includes('***'));
  });

  it('遮蔽长路径段（疑似路径型 token），保留首尾便于辨认', () => {
    const longSeg = 'abcd1234567890efgh';
    const r = maskUrl(`https://example.com/api/v1/client/subscribe/${longSeg}`);
    assert.ok(!r.includes(longSeg));
    assert.ok(r.includes('abcd***efgh'));
  });

  it('短路径段不遮蔽', () => {
    const r = maskUrl('https://example.com/api/v1/sub');
    assert.equal(r, 'https://example.com/api/v1/sub');
  });

  it('多 URL（逗号分隔）逐个遮蔽', () => {
    const r = maskUrl('https://a.com/s?token=aaa, https://b.com/s?key=bbb');
    assert.ok(!r.includes('aaa'));
    assert.ok(!r.includes('bbb'));
    assert.ok(r.includes('token=***'));
    assert.ok(r.includes('key=***'));
  });

  it('非法 URL 且较长时截断', () => {
    const r = maskUrl('not-a-url-but-a-very-long-string-here-xyz');
    assert.ok(r.includes('...'));
  });

  it('空字符串原样返回', () => {
    assert.equal(maskUrl(''), '');
  });
});

describe('maskUrl 逗号：区分「多源订阅」与「query 含逗号的单条 URL」', () => {
  it('query 含逗号的单条 URL 不切分，token 正确遮蔽（此前明文泄漏）', () => {
    // 旧行为按逗号无条件切分 → token= 落到第二段，两段都识别不出 token 参数 → 明文输出
    const masked = maskUrl('https://x.com/api?nodes=us,hk&token=SUPERSECRET1');
    assert.ok(!masked.includes('SUPERSECRET1'), `token 不应明文出现: ${masked}`);
    assert.ok(masked.includes('token=***'));
  });

  it('真多源仍逐段遮蔽（不能只看整体可解析——逗号是合法 path 字符）', () => {
    const masked = maskUrl('https://a.com/s?token=AAA111,https://b.com/s?key=BBB222');
    assert.ok(!masked.includes('AAA111'), `第一段 token 应遮蔽: ${masked}`);
    assert.ok(!masked.includes('BBB222'), `第二段 key 应遮蔽: ${masked}`);
  });

  it('三源逐段处理', () => {
    const masked = maskUrl('https://a.com/s?token=T1,https://b.com/s?token=T2,https://c.com/s?token=T3');
    for (const t of ['T1', 'T2', 'T3']) assert.ok(!masked.includes(`token=${t}`), `${t} 应遮蔽: ${masked}`);
  });
});
