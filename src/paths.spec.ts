import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { withFileLock } from './paths.js';

let tmpDir: string;
let target: string;
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-lock-'));
  target = path.join(tmpDir, 'settings.json');
  lockPath = `${target}.lock`;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('执行 fn 并返回其结果', () => {
    assert.equal(
      withFileLock(target, () => 42),
      42,
    );
  });

  it('正常路径结束后释放锁', () => {
    withFileLock(target, () => undefined);
    assert.equal(fs.existsSync(lockPath), false, '锁文件应已删除');
  });

  it('fn 抛错也释放锁（否则一次失败会锁死后续所有命令）', () => {
    assert.throws(() => {
      withFileLock(target, () => {
        throw new Error('boom');
      });
    }, /boom/);
    assert.equal(fs.existsSync(lockPath), false, '异常路径也必须释放锁');
  });

  it('持锁期间锁文件存在（互斥的前提）', () => {
    let seenDuringFn = false;
    withFileLock(target, () => {
      seenDuringFn = fs.existsSync(lockPath);
    });
    assert.equal(seenDuringFn, true);
  });

  it('强夺陈旧锁：持锁进程崩溃留下的锁不能永久卡死 CLI', () => {
    // 造一把 11 秒前的锁（超过 LOCK_STALE_MS=10s）
    fs.writeFileSync(lockPath, '');
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(lockPath, old, old);

    const started = Date.now();
    const result = withFileLock(target, () => 'ok');
    assert.equal(result, 'ok');
    assert.ok(Date.now() - started < 2000, '强夺陈旧锁应立即完成，而非等满超时');
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('新鲜锁拦住并发获取，持锁者放锁后才轮到（真实互斥）', () => {
    // 用真实的第二个持锁者验证互斥，而不是只检查锁文件属性。
    // 主进程先拿锁，在锁内记录时刻；子进程尝试拿同一把锁并记录拿到的时刻。
    // 子进程必须在主进程放锁之后才拿到。
    const marker = path.join(tmpDir, 'child-acquired-at');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `import { withFileLock } from ${JSON.stringify(path.resolve('src/paths.ts'))};
         import fs from 'node:fs';
         withFileLock(${JSON.stringify(target)}, () => {
           fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now()));
         });`,
      ],
      { stdio: 'ignore' },
    );

    let releasedAt = 0;
    withFileLock(target, () => {
      // 持锁 300ms，给子进程充分的尝试时间
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      assert.equal(fs.existsSync(marker), false, '持锁期间子进程不得拿到锁');
      releasedAt = Date.now();
    });

    // 等子进程拿到锁。注意不能等 child.exitCode：本用例全程同步阻塞事件循环，
    // 'exit' 事件永远派发不了，只能轮询文件系统这个跨进程可见的信号。
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    child.kill();

    assert.equal(fs.existsSync(marker), true, '放锁后子进程应能拿到锁');
    const childAcquiredAt = Number(fs.readFileSync(marker, 'utf8'));
    assert.ok(childAcquiredAt >= releasedAt, '子进程必须在主进程放锁之后才拿到锁');
  });
});
