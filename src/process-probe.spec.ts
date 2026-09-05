import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { MAIN_INSTANCE_PATTERN } from './process-probe.js';

/**
 * MAIN_INSTANCE_PATTERN 的语法回归。
 *
 * 这里锁的是一个「静默失效」缺陷：pattern 曾用 JS 的非捕获组 `(?:a|b)`，而 pgrep/pkill 走
 * POSIX ERE（`regcomp(REG_EXTENDED)`），ERE 里 `(` 后紧跟 `?` 是语法错误。后果不是报错而是
 * **全线静默失效**——pgrep 退出码 2、无输出，getMihomoPids 返回空；pkill 一个进程都不杀却
 * 照常返回。于是 `mihomo stop` 打印「已停止」，内核仍在跑。
 *
 * 断言直接调真实 pgrep 编译该 pattern，不做字符串匹配：字符串断言（如「不含 `(?:`」）
 * 只能挡住已知的这一种写法，而任何 JS-only 的正则语法（`\d`、`(?=)`、`{,n}`）都会以同样的
 * 方式失效。让 libc 的 regcomp 当裁判才是真的把关。
 */
describe('MAIN_INSTANCE_PATTERN', () => {
  it('能被 pgrep 的 POSIX ERE 编译（退出码只允许 0/1，2 = 正则编译失败）', () => {
    const result = spawnSync('pgrep', ['-f', MAIN_INSTANCE_PATTERN], { encoding: 'utf8', timeout: 10_000 });

    assert.notEqual(result.status, 2, `pgrep 无法编译该 pattern，进程探测会全线静默失效:\n${result.stderr}`);
    assert.ok(result.status === 0 || result.status === 1, `pgrep 异常退出 (${result.status}): ${result.stderr}`);
  });

  it('两种内核路径分支都在（服务经符号链启动，tun 经真实二进制）', () => {
    assert.match(MAIN_INSTANCE_PATTERN, /mihomo-cli-service/);
    assert.match(MAIN_INSTANCE_PATTERN, /\|/);
  });
});
