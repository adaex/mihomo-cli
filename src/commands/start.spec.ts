import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError } from '../errors.js';
import { resolveStartMode } from './start.js';

describe('resolveStartMode：模式 token 不受 flag 位置影响', () => {
  // 曾经只读 args[1]：`start -s tun` 的模式被当成 flag 丢掉，静默按 Mixed 启动，
  // 而用户以为已切到 TUN（全局路由没生效却毫无提示）。flag 在前是自然写法，
  // 且 sub remove 也接受，start 不能是唯一的例外。
  it('flag 在模式之前仍识别为 tun', () => {
    assert.equal(resolveStartMode(['start', '-s', 'tun']), 'tun');
    assert.equal(resolveStartMode(['start', '--no-update', 'tun']), 'tun');
  });

  it('带值选项的值不会被误当模式', () => {
    // -u 的值 30000 是 VALUE_FLAGS 覆盖的，getNonFlagArg 应跳过它继续找
    assert.equal(resolveStartMode(['start', '-u', '30000', 'tun']), 'tun');
    assert.equal(resolveStartMode(['start', '-u', '30000']), 'mixed');
  });

  it('模式在前（原有写法）不受影响', () => {
    assert.equal(resolveStartMode(['start', 'tun', '-s']), 'tun');
    assert.equal(resolveStartMode(['start', 'mixed']), 'mixed');
  });

  it('缺省为 mixed', () => {
    assert.equal(resolveStartMode(['start']), 'mixed');
    assert.equal(resolveStartMode(['start', '-s']), 'mixed');
  });

  it('大小写不敏感', () => {
    assert.equal(resolveStartMode(['start', 'TUN']), 'tun');
  });

  it('拼错模式名抛错，不静默降级为 mixed', () => {
    // 静默降级正是这条校验存在的理由：用户会误以为已切到 TUN
    assert.throws(() => resolveStartMode(['start', 'tn']), CliError);
    assert.throws(() => resolveStartMode(['start', '-s', 'tn']), CliError);
  });
});
