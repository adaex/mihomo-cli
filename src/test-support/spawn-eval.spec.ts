import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withTimeout } from '../errors.js';
import { spawnEval } from './spawn-eval.js';

describe('spawnEval 超时兜底', () => {
  it('超时终止挂住子进程并让 done 完成；测试自身也有看门狗', async () => {
    const { child, done } = spawnEval('setInterval(() => {}, 1000)', { timeout: 100 });
    try {
      const code = await withTimeout(done, 3_000);
      assert.equal(code, null, '被信号终止时 close 的退出码为 null');
      assert.equal(child.killed, true, '超时必须向子进程发出终止信号');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
