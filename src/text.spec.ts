import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeRegExp, sanitizeTerminal, shellQuote } from './text.js';

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
