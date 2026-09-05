import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withSpinner } from './spinner.js';

// 测试环境 stdout 非 TTY，withSpinner 走「开始一行」降级路径：
// 这里锁住的是它的控制流语义（返回值/异常透传），动画行为只在 TTY 下存在。

describe('withSpinner（非 TTY 降级路径）', () => {
  it('透传 fn 的返回值', async () => {
    const result = await withSpinner('测试', async () => 42);
    assert.equal(result, 42);
  });

  it('fn 抛错时向上抛（不吞异常、不假成功）', async () => {
    await assert.rejects(
      withSpinner('测试', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
  });

  it('fn 同步抛错同样向上抛', async () => {
    await assert.rejects(
      withSpinner('测试', () => Promise.reject(new Error('sync boom'))),
      /sync boom/,
    );
  });
});
