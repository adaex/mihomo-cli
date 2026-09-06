import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DIRS, PATHS, withFileLock } from './paths.js';

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

  it('锁被强夺后，原持有者的释放不得误删新持有者的锁', () => {
    // 三进程竞态的中间一步（A 持锁 12s 被 B 强夺、A 的 finally 误删 B 的锁 → C 直接进门）。
    // 在 fn 内模拟强夺：删除当前锁，让「新持有者」写入自己的 token。
    // 旧实现无条件 rmSync 会把 B 的锁删掉；新实现只认自己的 token，B 的锁必须原样保留
    withFileLock(target, () => {
      fs.rmSync(lockPath);
      fs.writeFileSync(lockPath, '999-123456789');
    });
    assert.equal(fs.readFileSync(lockPath, 'utf8'), '999-123456789', '新持有者的锁被误删，第三方将直接进入临界区');
    fs.rmSync(lockPath);
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

describe('锁文件的存放位置', () => {
  // 判据是「锁不在会被整体删除的目录里」，不是「锁在某个具体路径」——
  // 后者会在目录结构调整时误报，前者才是真正要守的不变量。
  const wipedDirs: [string, string][] = [
    ['runtime', DIRS.runtime],
    ['logs', DIRS.logs],
    ['data', DIRS.data],
    ['subscriptions', DIRS.subscriptions],
    ['kernel', DIRS.kernel],
  ];

  it('service.lock 不在任何会被 rmrf 的目录下', () => {
    // stop() 的 clearRuntime() 与 reset 的各 target 都会整体 rmrf 这些目录。
    // 锁文件躺在里面的话，第三方进程删目录会连别人正持着的锁一起删掉，
    // 下一个进程立刻拿到锁 → 两个进程同时进临界区（withFileLock 的 token
    // 所有权校验挡不住：它防的是误删，不是「锁被连目录一起删」）。
    for (const [name, dir] of wipedDirs) {
      assert.ok(!PATHS.serviceLock.startsWith(`${dir}${path.sep}`), `serviceLock 不能放在 ${name}/ 下（${dir}）：该目录会被整体删除，锁会连带消失导致互斥失效`);
    }
  });

  it('锁文件被第三方连目录删掉后互斥即失效（上面那条断言守的就是这个）', () => {
    // 复现机制本身，锁死「为什么位置很重要」。用独立的临时目录模拟被删的 runtime/。
    const wiped = path.join(tmpDir, 'runtime');
    fs.mkdirSync(wiped, { recursive: true });
    const lockInWiped = path.join(wiped, 'service.lock');
    const lockFile = `${lockInWiped}.lock`;

    // A 持锁
    const fdA = fs.openSync(lockFile, 'wx');
    fs.writeSync(fdA, 'A-token');

    // B 执行 clearRuntime()：rmrf 整个目录，A 的锁一起没了
    fs.rmSync(wiped, { recursive: true, force: true });
    fs.mkdirSync(wiped, { recursive: true });

    // C 立刻就能拿到锁——A 仍在临界区内
    let cGotLock = false;
    try {
      const fdC = fs.openSync(lockFile, 'wx');
      cGotLock = true;
      fs.closeSync(fdC);
    } catch {
      /* 拿不到才是安全的 */
    }
    fs.closeSync(fdA);

    assert.equal(cGotLock, true, '本用例是在记录缺陷机制：锁文件被连目录删掉后，第三方必然能立刻进入临界区');
  });
});
