import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESET_TARGETS } from './reset.js';

describe('RESET_TARGETS 执行顺序', () => {
  const indexOf = (id: string): number => RESET_TARGETS.findIndex(t => t.id === id);

  // 数组顺序就是执行顺序（resolveResetTargets 按它排序，使结果与用户输入顺序无关）。
  // 带 onAfter: writeSettings 的目标若排在 settings 之后，会把刚删掉的 settings.json
  // 重建成 {}，于是 `reset --full` 报「已重置: 设置」却留下一个空文件。
  // 这是 CODE_REVIEW #14 记录过的坑，tunnel 落地时又踩了一次，故用测试锁住。
  for (const id of ['subs', 'tunnel']) {
    it(`${id} 排在 settings 之前（其 onAfter 会重建 settings.json）`, () => {
      const target = RESET_TARGETS.find(t => t.id === id);
      assert.ok(target?.onAfter, `${id} 应有 onAfter`);
      assert.ok(indexOf(id) < indexOf('settings'), `${id}(${indexOf(id)}) 必须早于 settings(${indexOf('settings')})`);
    });
  }

  it('tunnel 有 onBefore：必须先停进程再删运行态文件', () => {
    // 反序会让 ssh 进程失联——文件一删就再也找不到那些 PID，
    // 它们继续占着端口跑下去且 CLI 无任何路径能停掉
    const tunnel = RESET_TARGETS.find(t => t.id === 'tunnel');
    assert.ok(tunnel?.onBefore, 'tunnel 应有 onBefore 以先停进程');
  });

  it('目标 id 与别名均无重复', () => {
    const ids = RESET_TARGETS.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, `id 重复: ${ids.join(', ')}`);
    const aliases = RESET_TARGETS.flatMap(t => t.aliases);
    assert.equal(new Set(aliases).size, aliases.length, `别名重复: ${aliases.join(', ')}`);
  });
});
