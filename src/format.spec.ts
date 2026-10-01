import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { displayWidth, formatBytes, formatRelativeTime, formatTimestamp, formatTraffic, padEndDisplay } from './format.js';

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
describe('formatTimestamp：到期时间戳', () => {
  it('0 特判为永久', () => {
    assert.equal(formatTimestamp(0), '永久');
  });

  it('正常正数按本地时间展示，远期时间戳不误伤', () => {
    assert.match(formatTimestamp(1_900_000_000), /2030/);
    assert.notEqual(formatTimestamp(9_999_999_999), '未知');
  });

  it('非有限值返回「未知」，不漏出字面 Invalid Date', () => {
    for (const v of ['abc', NaN, Infinity, 1e15 + 1e15, undefined, null]) {
      assert.equal(formatTimestamp(v), '未知', `value ${String(v)}`);
      assert.ok(formatTimestamp(v) !== 'Invalid Date');
    }
  });

  it('负数返回「未知」，不显示成 1970 日期', () => {
    assert.equal(formatTimestamp(-100), '未知');
  });
});

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

describe('formatTraffic：流量行对类型混淆的防护（手改缓存场景）', () => {
  it('字符串 download 不与数字相加：已用显示「未知」，百分比分片不挂（不漏 NaN%）', () => {
    const line = formatTraffic(0, 'oops' as unknown as number, 100);
    assert.equal(line, '未知 / 100 B');
    assert.ok(!line.includes('NaN'), `不得漏出 NaN: ${line}`);
  });

  it('数字形态字符串经 Number 化正常参与（total: "100" → 正常百分比）', () => {
    assert.equal(formatTraffic(10, 20, '100' as unknown as number), '30 B / 100 B (30.0%)');
  });

  it('total 为非法字符串时不挂百分比', () => {
    const line = formatTraffic(10, 20, 'oops' as unknown as number);
    assert.equal(line, '30 B / 未知');
    assert.ok(!line.includes('('), 'total 非数字时不挂百分比分片');
  });

  it('正常数字行为不变：百分比封顶 100%', () => {
    assert.equal(formatTraffic(60, 60, 100), '120 B / 100 B (100.0%)');
    assert.equal(formatTraffic(1, 1, 10), '2 B / 10 B (20.0%)');
  });

  it('download 与 total 都缺失返回 null（调用方跳过整行）', () => {
    assert.equal(formatTraffic(undefined, undefined, undefined), null);
  });

  it('只缺 total：仍展示已用，无百分比', () => {
    assert.equal(formatTraffic(1, 2, undefined), '3 B / 未知');
  });

  it('formatBytes 对字符串/NaN/负数统一「未知」（同族口径对照）', () => {
    assert.equal(formatBytes('oops'), '未知');
    assert.equal(formatBytes(NaN), '未知');
    assert.equal(formatBytes(-5), '未知');
  });
});
