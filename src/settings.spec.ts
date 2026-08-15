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
