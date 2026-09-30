import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { displayWidth, formatRelativeTime, padEndDisplay } from './format.js';

describe('formatRelativeTime', () => {
  const now = Date.now();
  it('刚刚 / 分钟 / 小时 / 天', () => {
    assert.equal(formatRelativeTime(new Date(now - 5_000), now), '刚刚');
    assert.equal(formatRelativeTime(new Date(now - 3 * 60_000), now), '3 分钟前');
    assert.equal(formatRelativeTime(new Date(now - 5 * 3_600_000), now), '5 小时前');
    assert.equal(formatRelativeTime(new Date(now - 3 * 86_400_000), now), '3 天前');
  });

  it('ISO 字符串与 Date 都接受', () => {
    assert.equal(formatRelativeTime(new Date(now - 60_000).toISOString(), now), '1 分钟前');
  });

  it('未来时间（时钟偏移）与非法值返回 null，由调用方回退绝对时间', () => {
    assert.equal(formatRelativeTime(new Date(now + 60_000), now), null);
    assert.equal(formatRelativeTime(undefined, now), null);
    assert.equal(formatRelativeTime('not-a-date', now), null);
  });
});

/**
 * 帮助文本的说明列靠 padEndDisplay 对齐。用 `.length` 的话含中文占位符的签名
 * （`logs [编号]`、`--mirror [镜像]`、`reset [目标...]`）会少缩进 2~3 格，
 * 正是要修的错位本身，故对宽度口径加锁。
 */
describe('displayWidth：CJK 占两列', () => {
  it('纯 ASCII 等于码点数', () => {
    assert.equal(displayWidth('install'), 7);
    assert.equal(displayWidth('start [tun|mixed] [-s] [-u ms]'), 30);
  });

  it('中文字符按两列计', () => {
    assert.equal(displayWidth('编号'), 4);
    assert.equal(displayWidth('logs [-f] [-n N] [编号] [-o]'), 28);
  });

  it('全角标点同样按两列计', () => {
    assert.equal(displayWidth('（默认）'), 8);
  });

  it('空串为 0', () => {
    assert.equal(displayWidth(''), 0);
  });
});

describe('padEndDisplay：按显示宽度补齐', () => {
  it('含中文的签名补到与纯 ASCII 签名相同的显示宽度', () => {
    const a = padEndDisplay('logs [-f] [-n N] [编号] [-o]', 30);
    const b = padEndDisplay('start [tun|mixed] [-s] [-u ms]', 30);
    assert.equal(displayWidth(a), displayWidth(b), '两者显示宽度应一致');
    assert.equal(displayWidth(a), 30);
  });

  it('已超出目标宽度时原样返回，不截断', () => {
    assert.equal(padEndDisplay('subscription remove <name>', 5), 'subscription remove <name>');
  });
});
