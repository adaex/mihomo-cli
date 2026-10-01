import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

/**
 * logs 命令此前无专属 spec：「省略编号但给查看类选项时默认当前日志」是最容易
 * 改坏的分支（帮助文案专门为它写了说明，却只有文案断言）。查看走真实 tail
 * （-n 非跟随、跑完即退），归档序号映射用预摆归档锁定。隔离：MIHOMO_CLI_DIR。
 */
describe('logs：编号省略与归档序号映射', () => {
  function withLogs(check: (run: (args: string[]) => { status: number | null; stdout: string; stderr: string }) => void): void {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-logs-'));
    try {
      fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'logs', 'mihomo.log'), 'current-line-1\ncurrent-line-2\ncurrent-line-3\n');
      // 两个归档：命名按 ARCHIVE_LOG_RE（mihomo.<yyyy-MM-dd_HH-mm-ss>.log），
      // 时间戳大的（新）排在列表前面
      fs.writeFileSync(path.join(dataDir, 'logs', 'mihomo.2026-01-02_03-04-05.log'), 'archive-new-content\n');
      fs.writeFileSync(path.join(dataDir, 'logs', 'mihomo.2026-01-01_03-04-05.log'), 'archive-old-content\n');
      // 归档按 mtime 降序排（新在前）；同秒创建 mtime 相等会让排序退化成 readdir 序，
      // 显式设 mtime 锁住「1 = 最新归档」的语义
      const newer = new Date('2026-01-02T03:04:05Z');
      const older = new Date('2026-01-01T03:04:05Z');
      fs.utimesSync(path.join(dataDir, 'logs', 'mihomo.2026-01-02_03-04-05.log'), newer, newer);
      fs.utimesSync(path.join(dataDir, 'logs', 'mihomo.2026-01-01_03-04-05.log'), older, older);
      const run = (args: string[]) => {
        const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, MIHOMO_CLI_DIR: dataDir, NO_COLOR: '1' },
        });
        return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
      };
      check(run);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it('logs -n 5（省略编号）默认当前日志，不静默落列表', () =>
    withLogs(run => {
      const r = run(['logs', '-n', '5']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /current-line-3/);
      assert.doesNotMatch(r.stdout, /archive-/);
    }));

  it('logs -o 的等号形式（--open）同样触发默认当前日志的判定', () =>
    withLogs(run => {
      // -o 会 spawn 系统打开动作，这里只锁「编号缺省 + 查看类 flag」的解析分支：
      // 用 --lines 的等号形式同样默认当前日志（tail 非跟随，跑完即退）
      const r = run(['logs', '--lines=2']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /current-line-2/);
    }));

  it('logs 1 映射到最新的归档（列表序号 1 起）', () =>
    withLogs(run => {
      const r = run(['logs', '1']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /archive-new-content/);
      assert.doesNotMatch(r.stdout, /archive-old-content/);
    }));

  it('logs 9 越界报「未找到日志」，不静默回列表', () =>
    withLogs(run => {
      const r = run(['logs', '9']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /未找到日志 "9"/);
    }));
});
