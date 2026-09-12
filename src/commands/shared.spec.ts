import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { dispatchSubcommand, type SubCommand } from './shared.js';

/** 记录命中的 handler（协议约定 handler 返回 void，用副作用观察分发结果） */
let called: string[] = [];

/** 合法的分发表：命中 / fallback / onUnknown 三条路径都要照常工作 */
const TABLE: SubCommand[] = [
  {
    name: 'on',
    aliases: ['enable'],
    handler: () => {
      called.push('on');
    },
  },
  {
    name: 'off',
    handler: () => {
      called.push('off');
    },
  },
];

const OPTIONS = {
  fallback: () => {
    called.push('fallback');
  },
  onUnknown: (action: string) => {
    throw new Error(`unexpected unknown: ${action}`);
  },
};

beforeEach(() => {
  called = [];
});

/**
 * 子命令表的重复 token 防护：registry 的 COMMAND_INDEX 在构建时对重复 token 抛错，
 * 但 dispatchSubcommand 用 `table.find`，两个子命令撞主名/别名时会静默取先注册者，
 * 后者永远不可达且无提示。入口处补同款检查（表按引用记忆，每张表只校验一次）。
 */
describe('dispatchSubcommand：子命令表重复 token 防护', () => {
  it('两个子命令的主名相同时抛错，不静默取先注册者', async () => {
    const dup: SubCommand[] = [
      { name: 'add', handler: () => {} },
      { name: 'add', handler: () => {} },
    ];
    await assert.rejects(dispatchSubcommand(['x', 'add'], dup, OPTIONS), /重复 token: "add"（add 与 add）/);
  });

  it('一个子命令的别名撞另一个的主名时抛错', async () => {
    const dup: SubCommand[] = [
      { name: 'add', handler: () => {} },
      { name: 'create', aliases: ['add'], handler: () => {} },
    ];
    await assert.rejects(dispatchSubcommand(['x', 'add'], dup, OPTIONS), /重复 token: "add"（add 与 create）/);
  });

  it('同一子命令内主名与别名相同也算重复（写错的别名表）', async () => {
    const dup: SubCommand[] = [{ name: 'on', aliases: ['on'], handler: () => {} }];
    await assert.rejects(dispatchSubcommand(['x', 'on'], dup, OPTIONS), /重复 token/);
  });

  it('校验不依赖 args：无子命令（fallback 路径）同样先查表', async () => {
    const dup: SubCommand[] = [
      { name: 'on', handler: () => {} },
      { name: 'enable', aliases: ['on'], handler: () => {} },
    ];
    await assert.rejects(dispatchSubcommand(['x'], dup, OPTIONS), /重复 token/);
  });
});

describe('dispatchSubcommand：合法表的分发协议不受影响', () => {
  it('按主名与别名命中 handler', async () => {
    await dispatchSubcommand(['x', 'on'], TABLE, OPTIONS);
    assert.deepEqual(called, ['on']);
    await dispatchSubcommand(['x', 'enable'], TABLE, OPTIONS);
    assert.deepEqual(called, ['on', 'on']);
    await dispatchSubcommand(['x', 'off'], TABLE, OPTIONS);
    assert.deepEqual(called, ['on', 'on', 'off']);
  });

  it('无子命令走 fallback，未知子命令走 onUnknown', async () => {
    await dispatchSubcommand(['x'], TABLE, OPTIONS);
    assert.deepEqual(called, ['fallback']);
    await assert.rejects(
      dispatchSubcommand(['x', 'nope'], TABLE, {
        ...OPTIONS,
        onUnknown: () => {
          throw new Error('未知: nope');
        },
      }),
      /未知: nope/,
    );
  });

  it('同一张表重复分发不重复校验（记忆化，分发结果不受影响）', async () => {
    await dispatchSubcommand(['x', 'on'], TABLE, OPTIONS);
    await dispatchSubcommand(['x', 'off'], TABLE, OPTIONS);
    assert.deepEqual(called, ['on', 'off']);
  });
});
