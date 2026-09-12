import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DIRS, PATHS, withFileLock } from './paths.js';

let tmpDir: string;
/** 锁文件路径。withFileLock 收的就是锁本身（不再是被保护的数据文件 + 内部拼 .lock） */
let lockPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-lock-'));
  lockPath = path.join(tmpDir, 'settings.lock');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('withFileLock', () => {
  it('执行 fn 并返回其结果', () => {
    assert.equal(
      withFileLock(lockPath, () => 42),
      42,
    );
  });

  it('正常路径结束后释放锁', () => {
    withFileLock(lockPath, () => undefined);
    assert.equal(fs.existsSync(lockPath), false, '锁文件应已删除');
  });

  it('fn 抛错也释放锁（否则一次失败会锁死后续所有命令）', () => {
    assert.throws(() => {
      withFileLock(lockPath, () => {
        throw new Error('boom');
      });
    }, /boom/);
    assert.equal(fs.existsSync(lockPath), false, '异常路径也必须释放锁');
  });

  it('持锁期间锁文件存在（互斥的前提）', () => {
    let seenDuringFn = false;
    withFileLock(lockPath, () => {
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
    const result = withFileLock(lockPath, () => 'ok');
    assert.equal(result, 'ok');
    assert.ok(Date.now() - started < 2000, '强夺陈旧锁应立即完成，而非等满超时');
    assert.equal(fs.existsSync(lockPath), false);
  });

  it('锁被强夺后，原持有者的释放不得误删新持有者的锁', () => {
    // 三进程竞态的中间一步（A 持锁 12s 被 B 强夺、A 的 finally 误删 B 的锁 → C 直接进门）。
    // 在 fn 内模拟强夺：删除当前锁，让「新持有者」写入自己的 token。
    // 旧实现无条件 rmSync 会把 B 的锁删掉；新实现只认自己的 token，B 的锁必须原样保留
    withFileLock(lockPath, () => {
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
         withFileLock(${JSON.stringify(lockPath)}, () => {
           fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now()));
         });`,
      ],
      { stdio: 'ignore' },
    );

    let releasedAt = 0;
    withFileLock(lockPath, () => {
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

  it('deadline 到点也不抢新鲜锁：过了等待上限仍须等持有者释放', () => {
    // 旧实现的 deadline 兜底：等待超过上限就无条件 rmSync 强夺 + 立即重试（不睡眠）。
    // 能等到超时的场景，锁多半是新鲜的——持有者刚换人（另一个等待者按陈旧路径
    // 强夺成功），无条件强夺删掉的就是人家几毫秒前才建的锁。这里把等待者的
    // deadline 缩放到 30ms，让它在主进程持锁期间烧完，固化修复语义：
    // deadline 过线不是强夺新鲜锁的理由，只能继续睡等持有者释放。
    const ready = path.join(tmpDir, 'waiter-ready');
    const entered = path.join(tmpDir, 'waiter-entered-at');
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `import { withFileLock } from ${JSON.stringify(path.resolve('src/paths.ts'))};
         import fs from 'node:fs';
         fs.writeFileSync(${JSON.stringify(ready)}, '1');
         withFileLock(${JSON.stringify(lockPath)}, () => {
           fs.writeFileSync(${JSON.stringify(entered)}, String(Date.now()));
         }, { deadlineMs: 30 });`,
      ],
      { stdio: 'ignore' },
    );

    let releasedAt = 0;
    withFileLock(lockPath, () => {
      // 等子进程就位（写出 ready 后立刻进 withFileLock），确保它的 deadline
      // 是在主进程持锁期间烧完的，而不是压根还没开始等
      const readyDeadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < readyDeadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      assert.equal(fs.existsSync(ready), true, '子进程未就位');
      // 子进程的 deadline（30ms）此刻已烧完，而锁对它仍新鲜（默认 staleMs=10s）。
      // 旧实现会在这段窗口里的某个重试轮 rmSync 抢进临界区
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      assert.equal(fs.existsSync(entered), false, 'deadline 过线后子进程不得抢进新鲜锁');
      releasedAt = Date.now();
    });

    const enteredDeadline = Date.now() + 10_000;
    while (!fs.existsSync(entered) && Date.now() < enteredDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    child.kill();

    assert.equal(fs.existsSync(entered), true, '放锁后子进程应能拿到锁');
    assert.ok(Number(fs.readFileSync(entered, 'utf8')) >= releasedAt, '子进程必须在主进程放锁之后才拿到锁');
  });

  it('双等待者临界区不重叠：deadline 各自过线也只等对方释放，绝不删对方刚建的锁', async () => {
    // 缺陷的最小复现编排（三进程）：A（父进程直接造的锁）持有后一直不释放，
    // 模拟持锁进程已死；B、C 两个等待者先后排队，各自带着早已烧完的 deadline。
    // B 的 staleMs 较短，到点按陈旧路径强夺 A 的锁进入；C 的 staleMs 拉到远超
    // 整个时间线——它没有陈旧路径可走，只能等 B 释放，而它的 deadline 早已
    // 过线。旧实现此刻会删掉 B 刚建几毫秒的新鲜锁抢进临界区（实测 B/C 临界区
    // 重叠 1.24s）。B 与 C 的 staleMs 错开还避免了两人在陈旧边界同时强夺的
    // 竞态，让「B 强夺、C 等待」这条路径确定可测。
    const createdA = Date.now();
    fs.writeFileSync(lockPath, 'A-token');

    // 等待者子进程：记录进入/退出临界区的时刻（跨进程可见的文件信号）
    const spawnWaiter = (tag: string, holdMs: number, staleMs: number, deadlineMs: number) =>
      spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          '-e',
          `import { withFileLock } from ${JSON.stringify(path.resolve('src/paths.ts'))};
           import fs from 'node:fs';
           withFileLock(${JSON.stringify(lockPath)}, () => {
             fs.writeFileSync(${JSON.stringify(path.join(tmpDir, `${tag}-enter`))}, String(Date.now()));
             Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
             fs.writeFileSync(${JSON.stringify(path.join(tmpDir, `${tag}-exit`))}, String(Date.now()));
           }, { staleMs: ${staleMs}, deadlineMs: ${deadlineMs} });`,
        ],
        { stdio: 'ignore' },
      );

    const children = [spawnWaiter('B', 150, 250, 80), spawnWaiter('C', 60, 2000, 80)];
    const exits = children.map(
      child =>
        new Promise<number | null>(resolve => {
          child.on('close', code => resolve(code));
          child.on('error', () => resolve(-1));
        }),
    );

    // 修复正确时两个子进程 ~600ms 内自行退出；超时说明互相死等（等价于把 CLI
    // 锁死），杀掉并判失败，避免回归成挂起时拖死整个测试套件。
    // 20s 是防挂起守护而非时序断言：并行负载下三个 node+tsx 子进程的启动可被
    // 拖慢一个量级，守护收太紧会把「慢」误判成「死等」
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>(resolve => {
      timeoutHandle = setTimeout(() => resolve(null), 20_000);
    });
    let codes: (number | null)[] | null;
    try {
      codes = await Promise.race([Promise.all(exits), timedOut]);
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (codes === null) {
      for (const child of children) child.kill();
      assert.fail('等待者子进程未在 20s 内退出（可能互相死等或死循环）');
    }
    for (const code of codes) {
      assert.equal(code, 0, '等待者子进程应正常退出');
    }

    const readMoment = (tag: 'B' | 'C', phase: 'enter' | 'exit') => Number(fs.readFileSync(path.join(tmpDir, `${tag}-${phase}`), 'utf8'));
    const bEnter = readMoment('B', 'enter');
    const bExit = readMoment('B', 'exit');
    const cEnter = readMoment('C', 'enter');
    const cExit = readMoment('C', 'exit');

    assert.ok(bEnter < bExit && cEnter < cExit, '进入时刻必须早于退出时刻（标记文件损坏？）');
    assert.ok(bEnter >= createdA + 250, `B 只能经陈旧强夺进入：最早也得等 A 的锁龄超过 B 的 staleMs(250ms)，实际提前到 ${bEnter - createdA}ms`);
    assert.ok(
      bExit <= cEnter || cExit <= bEnter,
      `两个等待者的临界区重叠：B [${bEnter}, ${bExit}]，C [${cEnter}, ${cExit}]（deadline 过线者删掉了对方刚建的新鲜锁）`,
    );
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

  // 按命名约定枚举**所有**锁，不逐个点名：v4.7.4 给 serviceLock 修这个缺陷时，
  // 断言只写了 `PATHS.serviceLock`，于是 cache.json 的锁（当时位于
  // `subscriptions/cache.json.lock`）带着同一个缺陷躺在测试的盲区里，
  // reset subs 的 rmrf 照样能把它连目录带走。
  // 现在新增锁只要以 Lock 结尾就自动进这条断言。
  const lockEntries = Object.entries(PATHS).filter(([key]) => key.endsWith('Lock'));

  it('锁常量命名约定成立（否则下面的枚举会空转、断言变成永真）', () => {
    assert.ok(
      lockEntries.length >= 3,
      `应至少有 3 把以 Lock 结尾的锁常量（settings/subscriptionCache/service），实际 ${lockEntries.length} 个: ${lockEntries.map(([k]) => k).join(', ')}`,
    );
  });

  it('所有锁文件都不在会被 rmrf 的目录下', () => {
    // stop() 的 clearRuntime() 与 reset 的各 target 都会整体 rmrf 这些目录。
    // 锁文件躺在里面的话，第三方进程删目录会连别人正持着的锁一起删掉，
    // 下一个进程立刻拿到锁 → 两个进程同时进临界区（withFileLock 的 token
    // 所有权校验挡不住：它防的是误删，不是「锁被连目录一起删」）。
    for (const [lockName, lockPath] of lockEntries) {
      for (const [dirName, dir] of wipedDirs) {
        assert.ok(
          !lockPath.startsWith(`${dir}${path.sep}`),
          `${lockName} 不能放在 ${dirName}/ 下（${lockPath}）：该目录会被整体删除，锁会连带消失导致互斥失效`,
        );
      }
    }
  });

  // 停止计数不是锁（命名刻意不带 Lock 后缀，否则会被上面的枚举当锁断言），
  // 但**同样不能被 rmrf 带走**：文件消失即读作 0，于是「期间发生过 stop」这个事实丢失，
  // 并发的 start 会把用户刚跑完的 stop 覆盖掉。故单独点名断言它的位置。
  it('停止计数文件不在会被 rmrf 的目录下', () => {
    for (const [dirName, dir] of wipedDirs) {
      assert.ok(
        !PATHS.serviceStopEpoch.startsWith(`${dir}${path.sep}`),
        `serviceStopEpoch 不能放在 ${dirName}/ 下（${PATHS.serviceStopEpoch}）：被删后读作 0，并发 stop 的记录丢失`,
      );
    }
  });

  it('锁文件被第三方连目录删掉后互斥即失效（上面那条断言守的就是这个）', () => {
    // 复现机制本身，锁死「为什么位置很重要」。用独立的临时目录模拟被删的 runtime/。
    const wiped = path.join(tmpDir, 'runtime');
    fs.mkdirSync(wiped, { recursive: true });
    const lockFile = path.join(wiped, 'service.lock');

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

  it('订阅缓存锁在 reset subs 的 rmrf 之后依然幸存（本次修的那条同族缺陷）', async () => {
    // v4.7.4 只把 serviceLock 移出 runtime/，cache.json 的锁仍在 subscriptions/ 里，
    // 于是「慢速 sub update 持缓存锁期间另一终端 reset」照样让两进程同进临界区。
    // 这里用真实的 rmrf(DIRS.subscriptions) 验证锁位置：删完目录后，
    // 持锁者的锁必须还在（否则第三方能立刻拿到锁）。
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cachelock-'));
    try {
      // 子进程持缓存锁，锁内 rmrf subscriptions/（模拟另一终端 reset subs），
      // 再检查自己的锁是否幸存 —— 幸存则退 0
      const script = [
        `import fs from 'node:fs';`,
        `import assert from 'node:assert/strict';`,
        `import { withFileLock, rmrf, DIRS, PATHS, ensureDirs } from ${JSON.stringify(path.resolve('src/paths.ts'))};`,
        `ensureDirs();`,
        `withFileLock(PATHS.subscriptionCacheLock, () => {`,
        `  assert.ok(fs.existsSync(PATHS.subscriptionCacheLock), '持锁期间锁文件应存在');`,
        `  rmrf(DIRS.subscriptions);`,
        `  assert.ok(fs.existsSync(PATHS.subscriptionCacheLock), 'reset subs 的 rmrf 把正被持有的缓存锁一起删掉了：第三方可立刻进入临界区');`,
        `});`,
      ].join('\n');
      const code = await new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
          stdio: 'ignore',
          env: { ...process.env, MIHOMO_CLI_DIR: dataDir },
        });
        child.on('close', c => resolve(c));
        child.on('error', () => resolve(-1));
      });
      assert.equal(code, 0, '缓存锁应在 rmrf(subscriptions/) 后幸存（子进程退出码非 0 表示断言失败）');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
