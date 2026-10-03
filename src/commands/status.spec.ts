import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { colors } from '../colors.js';
import type { SubscriptionUrgency } from '../types.js';
import { trafficColor } from './status.js';

/**
 * trafficColor：手改缓存写入字符串时 90% 黄色阈值不能失效。
 * 非 TTY 测试进程里 colors 是恒等函数，黄/无色输出无法区分，故桩掉
 * colors.yellow/red 观测分支选择（status.ts 与本测试引用同一 colors 单例）。
 */
const dirtyNumber = (v: unknown) => v as unknown as number;

describe('trafficColor', () => {
  it('数字字符串按数值相加：合法数值 used/total >= 90% 仍着黄（防过度修正把字符串一概忽略）', () => {
    const yellow = mock.method(colors, 'yellow', (s: unknown) => `Y[${s}]`);
    try {
      assert.match(trafficColor('流量行', null, 100, dirtyNumber('60'), dirtyNumber('30')), /^Y\[/);
    } finally {
      yellow.mock.restore();
    }
  });

  it('未到 90% 的字符串值不着黄；非有限值不抛也不着黄', () => {
    // 核心回归：裸相加把 "12"+"34" 拼成 "1234"，1234/200 >= 0.9 误着黄；
    // "oops" 一侧挡 NaN 口径漂移（硬化后该分片不参与，不抛不黄）
    const yellow = mock.method(colors, 'yellow', (s: unknown) => `Y[${s}]`);
    try {
      assert.equal(trafficColor('流量行', null, 200, dirtyNumber('12'), dirtyNumber('34')), '流量行');
      assert.equal(trafficColor('流量行', null, 100, dirtyNumber('oops'), 0), '流量行');
      assert.equal(yellow.mock.callCount(), 0);
    } finally {
      yellow.mock.restore();
    }
  });

  it('traffic-exhausted 优先红，不受脏值影响', () => {
    const red = mock.method(colors, 'red', (s: unknown) => `R[${s}]`);
    try {
      assert.match(trafficColor('流量行', 'traffic-exhausted' satisfies SubscriptionUrgency, 200, dirtyNumber('1'), dirtyNumber('2')), /^R\[/);
    } finally {
      red.mock.restore();
    }
  });
});
