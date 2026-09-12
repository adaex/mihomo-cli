import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError, errorMessage } from './errors.js';

/**
 * errorMessage 的口径回归：uncaughtException / unhandledRejection / main().catch
 * 共用。此前 uncaughtException 把参数假定成 Error，`throw 'boom'` 之类非 Error
 * 抛出渲染成「未捕获的异常: undefined」，唯一的线索（抛了什么）反而丢了。
 */
describe('errorMessage：任意抛出物的消息文本', () => {
  it('Error 取 message', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom');
    assert.equal(errorMessage(new CliError('预期内错误', { label: '参数错误' })), '预期内错误');
  });

  it('非 Error 按 String() 兜底，不再渲染成 undefined', () => {
    assert.equal(errorMessage('boom'), 'boom');
    assert.equal(errorMessage(42), '42');
    assert.equal(errorMessage(null), 'null');
    assert.equal(errorMessage(undefined), 'undefined');
    assert.equal(errorMessage({ key: 'v' }), '[object Object]');
  });
});
