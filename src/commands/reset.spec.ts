import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESET_TARGETS } from './reset.js';

describe('RESET_TARGETS 执行顺序', () => {
  const indexOf = (id: string): number => RESET_TARGETS.findIndex(t => t.id === id);

  // 数组顺序就是执行顺序（resolveResetTargets 按它排序，使结果与用户输入顺序无关）。
  // 带 onAfter: writeSettings 的目标若排在 settings 之后，会把刚删掉的 settings.json
  // 重建成 {}，于是 `reset --full` 报「已重置: 设置」却留下一个空文件。
  // 这是 CODE_REVIEW #14 记录过的坑，故用测试锁住。
  it('subs 排在 settings 之前（其 onAfter 会重建 settings.json）', () => {
    const target = RESET_TARGETS.find(t => t.id === 'subs');
    assert.ok(target?.onAfter, 'subs 应有 onAfter');
    assert.ok(indexOf('subs') < indexOf('settings'), `subs(${indexOf('subs')}) 必须早于 settings(${indexOf('settings')})`);
  });

  it('目标 id 与别名均无重复', () => {
    const ids = RESET_TARGETS.map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, `id 重复: ${ids.join(', ')}`);
    const aliases = RESET_TARGETS.flatMap(t => t.aliases);
    assert.equal(new Set(aliases).size, aliases.length, `别名重复: ${aliases.join(', ')}`);
  });
});
