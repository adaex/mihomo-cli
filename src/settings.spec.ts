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

  it('非法 URL 且较长时截断', () => {
    const r = maskUrl('not-a-url-but-a-very-long-string-here-xyz');
    assert.ok(r.includes('...'));
  });

  it('空字符串原样返回', () => {
    assert.equal(maskUrl(''), '');
  });
});

describe('maskUrl 逗号：URL 整体处理，不做任何切分', () => {
  it('query 含逗号时 token 正确遮蔽', () => {
    // 逗号在 query 中合法。按逗号切分会让 token= 落到第二段而识别不出 → 明文输出
    const masked = maskUrl('https://x.com/api?nodes=us,hk&token=SUPERSECRET1');
    assert.ok(!masked.includes('SUPERSECRET1'), `token 不应明文出现: ${masked}`);
    assert.ok(masked.includes('token=***'));
  });

  it('逗号后拼接的内容落进 token 值，随之一并遮蔽', () => {
    const masked = maskUrl('https://a.com/s?token=AAA111,https://b.com/s?key=BBB222');
    assert.ok(!masked.includes('AAA111'), `token 应遮蔽: ${masked}`);
    assert.ok(!masked.includes('BBB222'), `token 值内的尾随内容应一并遮蔽: ${masked}`);
  });

  it('逗号落在 path 时，其后的长路径段仍按路径型令牌遮蔽', () => {
    const masked = maskUrl('https://a.com/s,https://b.com/sub/abcd1234567890efgh');
    assert.ok(!masked.includes('abcd1234567890efgh'), `路径型令牌应遮蔽: ${masked}`);
  });
});
