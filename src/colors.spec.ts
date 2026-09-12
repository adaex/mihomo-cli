import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { colorEnabled } from './colors.js';

/**
 * 设色判定的口径回归（no-color.org）：
 * - NO_COLOR 此前用 `!== undefined` 判定，空串 `NO_COLOR=` 也会关色，与规范相悖
 *   （规范：存在**且非空**才关色）
 * - 错误渲染走 stderr，设色必须按 stderr.isTTY 独立判定——`mihomo status | grep x`
 *   时 stdout 是管道而 stderr 仍是终端，跟着 stdout 判会把错误输出一并剥色。
 *   判定已纯函数化（colorEnabled），stdout/stderr 两路只是传入的 isTTY 不同。
 */
describe('colorEnabled：NO_COLOR 与 TTY 的联合判定', () => {
  it('未设 NO_COLOR 且为终端：开色', () => {
    assert.equal(colorEnabled(undefined, true), true);
  });

  it('NO_COLOR 为空串不关色（no-color.org：存在且非空才关）', () => {
    assert.equal(colorEnabled('', true), true);
  });

  it('NO_COLOR 非空即关色（值本身不解释，0/false 也算）', () => {
    assert.equal(colorEnabled('1', true), false);
    assert.equal(colorEnabled('0', true), false);
    assert.equal(colorEnabled('false', true), false);
    assert.equal(colorEnabled(' ', true), false);
  });

  it('非终端（管道/重定向，isTTY 缺省或 false）：无论 NO_COLOR 一律无色', () => {
    assert.equal(colorEnabled(undefined, false), false);
    assert.equal(colorEnabled(undefined, undefined), false);
    assert.equal(colorEnabled('', undefined), false);
  });

  it('NO_COLOR 关色优先于 TTY（两路判定共用同一 NO_COLOR 语义）', () => {
    // stdout 与 stderr 只是 isTTY 传入不同，NO_COLOR 口径必须一致
    assert.equal(colorEnabled('1', false), false);
  });
});
