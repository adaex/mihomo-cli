import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

// paths.ts 在 import 期求值 MIHOMO_CLI_DIR，必须先设环境变量再动态 import
// （config-dns.spec.ts 同款手法）。归档分配直接写 logs/ 目录；并发用例的子进程
// 也靠同一个 MIHOMO_CLI_DIR 与主进程共享同一份目录。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-logfiles-'));
process.env.MIHOMO_CLI_DIR = tmpDir;

const { allocateArchivePath, isArchiveLogFilename } = await import('./log-files.js');
const { CliError } = await import('./errors.js');
const { DIRS, PATHS } = await import('./paths.js');
const { formatLocalTimestamp } = await import('./utils.js');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('归档日志文件名判据（清理与列表的单一真相源）', () => {
  // 此前 cleanupOldLogs 与 listLogs 各写一份正则，只有前者认序号后缀：
  // `mihomo.<ts>.1.log` 会被按时清理却永远不出现在 `logs` 列表里，
  // 于是 `logs <编号>` 拿不到它——而序号后缀恰恰产生于「同一秒内二次轮转」，
  // 也就是 start 失败后立即重试这个最需要翻日志的场景。
  it('认标准时间戳归档', () => {
    assert.ok(isArchiveLogFilename('mihomo.2026-09-06_10-00-00.log'));
  });

  it('认带序号后缀的归档（同秒二次轮转产生，此前列表漏了它）', () => {
    assert.ok(isArchiveLogFilename('mihomo.2026-09-06_10-00-00.1.log'), '带序号的归档必须能被列出，否则 logs <编号> 永远访问不到');
    assert.ok(isArchiveLogFilename('mihomo.2026-09-06_10-00-00.12.log'));
  });

  it('不认当前日志本身（它由 listLogs 单独作为编号 0 处理）', () => {
    assert.equal(isArchiveLogFilename('mihomo.log'), false);
  });

  it('不认时间戳残缺或异形的名字', () => {
    for (const bad of [
      'mihomo.2026-09-06.log', // 缺时间部分
      'mihomo.2026-9-6_10-00-00.log', // 月日未补零
      'mihomo.2026-09-06_10-00-00.log.bak', // 尾部多后缀
      'mihomo.2026-09-06_10-00-00.a.log', // 序号非数字
      'other.2026-09-06_10-00-00.log', // 前缀不符
    ]) {
      assert.equal(isArchiveLogFilename(bad), false, `不该认: ${bad}`);
    }
  });

  it('不认借前缀混入的路径成分（判据锚定整个文件名）', () => {
    assert.equal(isArchiveLogFilename('../mihomo.2026-09-06_10-00-00.log'), false);
    assert.equal(isArchiveLogFilename('sub/mihomo.2026-09-06_10-00-00.log'), false);
  });
});

describe('allocateArchivePath：原子占名', () => {
  beforeEach(() => {
    // 每个用例从干净的 logs/ 出发：分配测试对目录里的既有文件敏感
    fs.rmSync(DIRS.logs, { recursive: true, force: true });
    fs.mkdirSync(DIRS.logs, { recursive: true });
  });

  it('返回时名字已被本进程占住（空占位文件已存在）', () => {
    const archivePath = allocateArchivePath();
    assert.ok(fs.existsSync(archivePath), '返回的路径应已被创建——否则「名字可用」与「名字归我」仍隔一次 existsSync，并发进程照样选中同一名字');
    assert.ok(isArchiveLogFilename(path.basename(archivePath)), `分配的名字应符合归档判据，实际: ${path.basename(archivePath)}`);
    assert.equal(fs.statSync(archivePath).size, 0, '占位应是空文件，内容随后由调用方 rename/copy 覆写');
  });

  it('base 名被占时让位给序号后缀（命名约定不变）', () => {
    // 时间戳由 formatLocalTimestamp 现算，与分配函数落在同一秒才算数；
    // 造两个文件是毫秒级操作，恰好跨秒就换一秒重来
    for (let attempt = 0; attempt < 5; attempt++) {
      const ts = formatLocalTimestamp();
      fs.writeFileSync(path.join(DIRS.logs, `mihomo.${ts}.log`), 'first');
      fs.writeFileSync(path.join(DIRS.logs, `mihomo.${ts}.1.log`), 'second');
      const got = allocateArchivePath();
      if (path.basename(got) === `mihomo.${ts}.2.log`) return; // 同一秒：让位给 .2，约定成立
      // 分配函数内部已换秒（新秒的 base 名空闲）：清掉这轮的文件再试
      fs.rmSync(DIRS.logs, { recursive: true, force: true });
      fs.mkdirSync(DIRS.logs, { recursive: true });
    }
    assert.fail('连续 5 次都跨秒边界（时间窗口异常），未能验证序号让位');
  });

  it('并发双进程同时分配拿到不同路径，先写内容不被覆盖', async () => {
    // 两个子进程经 ready/go 标记对齐起跑线后同时调 allocateArchivePath，各自把
    // 标记内容写进拿到的路径。分配与写入之间隔 50ms——模拟真实消费方「分配 →
    // rename/copy」之间的窗口（copy 大日志、进程被调度出去都会拉大它），这正是
    // 旧实现 existsSync 判否与实际落盘之间的 TOCTOU 空档。
    const childScript = (id: string) => `
      import fs from 'node:fs';
      import path from 'node:path';
      import { allocateArchivePath } from ${JSON.stringify(path.resolve('src/log-files.ts'))};
      const tmpDir = ${JSON.stringify(tmpDir)};
      fs.writeFileSync(path.join(tmpDir, 'alloc-ready-${id}'), '');
      while (!fs.existsSync(path.join(tmpDir, 'alloc-go'))) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      const p = allocateArchivePath();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      fs.writeFileSync(p, 'content-${id}');
      fs.writeFileSync(path.join(tmpDir, 'alloc-result-${id}'), p);
    `;

    const children = ['a', 'b'].map(id =>
      spawn(process.execPath, ['--import', 'tsx', '-e', childScript(id)], {
        stdio: 'ignore',
        env: { ...process.env, MIHOMO_CLI_DIR: tmpDir },
      }),
    );

    const waitMarker = (name: string) => {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(path.join(tmpDir, name)) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      assert.ok(fs.existsSync(path.join(tmpDir, name)), `等待子进程标记 ${name} 超时`);
    };
    waitMarker('alloc-ready-a');
    waitMarker('alloc-ready-b');
    fs.writeFileSync(path.join(tmpDir, 'alloc-go'), '');

    const exitCodes = await Promise.all(children.map(child => new Promise<number | null>(resolve => child.on('close', resolve))));
    assert.deepEqual(exitCodes, [0, 0], '两个子进程都不该失败');

    const pathA = fs.readFileSync(path.join(tmpDir, 'alloc-result-a'), 'utf8');
    const pathB = fs.readFileSync(path.join(tmpDir, 'alloc-result-b'), 'utf8');
    assert.notEqual(pathA, pathB, '并发分配必须拿到不同归档名——同一个名字会被后写者静默覆盖');
    assert.equal(fs.readFileSync(pathA, 'utf8'), 'content-a', '先落盘的归档内容被后到进程覆盖');
    assert.equal(fs.readFileSync(pathB, 'utf8'), 'content-b', '后到进程的归档内容不完整');
  });

  it('并发双进程同时轮转同一份日志：只产生一份归档、内容不丢、双方都不报错', async () => {
    // 比「分配」更贴近消费端：两个子进程对同一份 mihomo.log 走完整的
    // rotateAndCleanupLogs（startService 与 startTun 并发时的真实路径）。
    // 无论谁先搬走日志，输家必须优雅退出（不抛错、不留空占位），历史内容恰好归档一份。
    fs.writeFileSync(PATHS.logFile, 'history');

    const childScript = (id: string) => `
      import fs from 'node:fs';
      import path from 'node:path';
      import { rotateAndCleanupLogs } from ${JSON.stringify(path.resolve('src/log-files.ts'))};
      const tmpDir = ${JSON.stringify(tmpDir)};
      fs.writeFileSync(path.join(tmpDir, 'rotate-ready-${id}'), '');
      while (!fs.existsSync(path.join(tmpDir, 'rotate-go'))) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      rotateAndCleanupLogs();
    `;
    const children = ['a', 'b'].map(id =>
      spawn(process.execPath, ['--import', 'tsx', '-e', childScript(id)], {
        stdio: 'ignore',
        env: { ...process.env, MIHOMO_CLI_DIR: tmpDir },
      }),
    );

    const waitMarker = (name: string) => {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(path.join(tmpDir, name)) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      assert.ok(fs.existsSync(path.join(tmpDir, name)), `等待子进程标记 ${name} 超时`);
    };
    waitMarker('rotate-ready-a');
    waitMarker('rotate-ready-b');
    fs.writeFileSync(path.join(tmpDir, 'rotate-go'), '');

    const exitCodes = await Promise.all(children.map(child => new Promise<number | null>(resolve => child.on('close', resolve))));
    assert.deepEqual(exitCodes, [0, 0], '并发轮转的输家也不该抛错（日志已被赢家归档，无事可做）');

    const archives = fs
      .readdirSync(DIRS.logs)
      .filter(f => isArchiveLogFilename(f))
      .map(f => path.join(DIRS.logs, f));
    assert.equal(archives.length, 1, `应恰好产生一份归档（内容一份、无空占位残留），实际: ${archives.map(p => path.basename(p)).join(', ')}`);
    assert.equal(fs.readFileSync(archives[0], 'utf8'), 'history', '历史日志内容必须完整落到归档里');
    assert.equal(fs.existsSync(PATHS.logFile), false, 'mihomo.log 应已被 rename 搬走');
  });

  it('同秒序号耗尽时抛 CliError 而非无限换名', () => {
    // 与实现的 MAX_ARCHIVE_SEQ 约定一致（log-files.ts）：base + .1…1000 全部占满
    // 后必须报错。1001 个空文件的创建是毫秒级操作，但若恰好跨过秒边界，分配函数
    // 内部的时间戳已换新秒（base 名空闲、分配成功）——清掉重来，直到落在同一秒。
    for (let attempt = 0; attempt < 6; attempt++) {
      const ts = formatLocalTimestamp();
      for (let i = 0; i <= 1000; i++) {
        fs.closeSync(fs.openSync(path.join(DIRS.logs, i === 0 ? `mihomo.${ts}.log` : `mihomo.${ts}.${i}.log`), 'w'));
      }
      try {
        allocateArchivePath();
      } catch (e) {
        assert.ok(e instanceof CliError, `序号耗尽应抛 CliError，实际: ${e}`);
        return;
      }
      // 没抛：这轮造文件跨过了秒边界，换一秒再试
      fs.rmSync(DIRS.logs, { recursive: true, force: true });
      fs.mkdirSync(DIRS.logs, { recursive: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
    assert.fail('连续 6 次都跨秒边界（时间窗口异常），未能验证序号耗尽');
  });
});
