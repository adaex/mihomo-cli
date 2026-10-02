import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeRegExp, maskUrl, sanitizeTerminal, shellQuote, TOKEN_KEY_NAMES } from './text.js';

describe('sanitizeTerminal', () => {
  it('剥除 \\r（回行首覆盖是终端伪造的经典手段）', () => {
    assert.equal(sanitizeTerminal('a\rb'), 'ab');
    assert.equal(sanitizeTerminal('✗ 校验失败\r✓ 校验通过'), '✗ 校验失败✓ 校验通过');
  });

  it('剥除其余 C0 控制字符（\\x00-\\x08、\\x0b、\\x0c、\\x0e-\\x1f）', () => {
    for (const code of [0x00, 0x01, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f]) {
      const ch = String.fromCharCode(code);
      assert.equal(sanitizeTerminal(`a${ch}b`), 'ab', `\\x${code.toString(16)} 应被剥除`);
    }
  });

  it('保留 \\t 与 \\n（排版与换行是合法内容）', () => {
    assert.equal(sanitizeTerminal('a\tb\nc'), 'a\tb\nc');
  });

  it('剥除 ANSI CSI 转义序列（清屏/光标移动）', () => {
    assert.equal(sanitizeTerminal('a\x1b[2Jb'), 'ab');
    assert.equal(sanitizeTerminal('a\x1b[1;31mred\x1b[0m'), 'ared');
  });

  it('剥除孤立的 ESC（不构成 CSI 序列的）', () => {
    assert.equal(sanitizeTerminal('a\x1bb'), 'ab');
  });

  it('普通内容与中文不受影响', () => {
    assert.equal(sanitizeTerminal('节点 TW 延迟 120ms'), '节点 TW 延迟 120ms');
  });
});

describe('escapeRegExp', () => {
  it('转义全部正则元字符', () => {
    assert.equal(escapeRegExp('a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o'), 'a\\.b\\*c\\+d\\?e\\^f\\$g\\{h\\}i\\(j\\)k\\|l\\[m\\]n\\\\o');
  });

  it('转义后的串作为正则只匹配字面量', () => {
    const pattern = escapeRegExp('127.0.0.1:7890');
    assert.ok(new RegExp(pattern).test('127.0.0.1:7890'));
    assert.ok(!new RegExp(pattern).test('127x0x0x1:7890'));
  });
});

describe('shellQuote', () => {
  it('单引号包裹并转义内嵌单引号', () => {
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
    assert.equal(shellQuote('plain'), "'plain'");
  });

  it('含 shell 注入字符的串被整体引号化（特殊字符不逃出引号）', () => {
    const quoted = shellQuote('$(rm -rf /) `id` "x" $HOME');
    // 首尾必须是引号；内嵌单引号已转义为 '\''，串内不再有「裸露」的引号边界
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"));
    assert.equal(quoted, '\'$(rm -rf /) `id` "x" $HOME\'');
  });
});

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

  it('token 参数名黑名单无重复登记（重复键是登记事故，挡在结构层）', () => {
    assert.equal(new Set(TOKEN_KEY_NAMES).size, TOKEN_KEY_NAMES.length);
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

describe('maskUrl：畸形输入的降级路径（fuzz 抓出的尾部泄漏）', () => {
  it('无法解析的长串只保留前缀——token 位于尾部（query），不得带进截断窗口', () => {
    const bad = 'broken url with token=ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
    const masked = maskUrl(bad);
    assert.ok(!masked.includes(bad.slice(-10)), '尾部 10 字符不得出现');
    assert.match(masked, /^broken url with\.\.\.$/);
  });

  it('短畸形串（≤15）原样返回：无害短串完整保留，泄漏上限与前缀截断等量', () => {
    assert.equal(maskUrl('short-bad-url'), 'short-bad-url');
  });

  it('16–30 的短串同样截断：误把整条 token 当 URL 粘入时不得原样进错误消息', () => {
    // 真实形态：sub add 只粘了 token（无 scheme/host，fetch 报 invalid URL，
    // 降级分支渲染错误消息）——「短就安全」不成立，这整条串就是凭据
    const token = 'a9f8b7c6d5e4f3a2b1c0d0';
    const masked = maskUrl(token);
    assert.notEqual(masked, token, '不得原样返回');
    assert.match(masked, /^a9f8b7c6d5e4f3a\.\.\.$/);
  });
});
