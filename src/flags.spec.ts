import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { VALUE_FLAGS } from './flags.js';
import { extractStartOptions } from './utils.js';

describe('flags 单一登记表派生', () => {
  it('VALUE_FLAGS 恰好包含全部带值选项的各形式', () => {
    assert.deepEqual([...VALUE_FLAGS].sort(), ['--lines', '--update-timeout', '-n', '-u']);
  });

  it('可选值选项 --mirror 不在 VALUE_FLAGS（只走 parseMirrorArg）', () => {
    // 登记了反而会让 getNonFlagArg 把它的值吞掉
    assert.ok(!VALUE_FLAGS.has('--mirror'));
  });
});

describe('extractStartOptions：重启透传从登记表派生', () => {
  it('透传 start 的布尔选项', () => {
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '-s']), ['-s']);
    assert.deepEqual(extractStartOptions(['ow', 'on', '--no-update']), ['--no-update']);
  });

  it('透传带值选项及其值', () => {
    assert.deepEqual(extractStartOptions(['start', '-u', '30000', 'tun']), ['-u', '30000']);
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '--update-timeout', '5000']), ['--update-timeout', '5000']);
  });

  it('等号形式整体透传，不再吞掉下一个 token', () => {
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '--update-timeout=30000']), ['--update-timeout=30000']);
  });

  it('丢弃非 start 选项（含其他命令的布尔/带值选项）', () => {
    assert.deepEqual(extractStartOptions(['logs', '-n', '200', '-f']), []);
    assert.deepEqual(extractStartOptions(['sub', 'remove', 'foo', '-y']), []);
  });

  it('undefined 与空数组返回空', () => {
    assert.deepEqual(extractStartOptions(undefined), []);
    assert.deepEqual(extractStartOptions([]), []);
  });
});
