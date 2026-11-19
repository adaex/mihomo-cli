import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeFixture, runCli } from '../test-support/cli.js';

/** 用真实的 tail 读取临时目录下的日志，不启用跟随模式 */
describe('logs：编号省略与归档序号映射', () => {
  function withLogs(check: (run: (args: string[]) => { status: number | null; stdout: string; stderr: string }, dataDir: string) => void): void {
    const fixture = makeFixture('mihomo-logs');
    const { dataDir } = fixture;
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
        const r = runCli(args, fixture);
        return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
      };
      check(run, dataDir);
    } finally {
      fixture.cleanup();
    }
  }

  it('logs -n 5（省略编号）默认当前日志，不静默落列表', () =>
    withLogs(run => {
      const r = run(['logs', '-n', '5']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /current-line-3/);
      assert.doesNotMatch(r.stdout, /archive-/);
    }));

  it('logs --lines=2 省略编号时读取当前日志的最后两行', () =>
    withLogs(run => {
      const r = run(['logs', '--lines=2']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.stdout.match(/^current-line-\d+$/gm), ['current-line-2', 'current-line-3']);
    }));

  it('列表中 0 只表示当前日志；没有当前日志时归档仍从 1 编号', () =>
    withLogs((run, dataDir) => {
      const entries = () => {
        const result = run(['logs']);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout
          .split('\n')
          .map(line => line.trim())
          .filter(line => /^\d+\. /.test(line));
      };
      const archives = ['1. mihomo.2026-01-02_03-04-05.log', '2. mihomo.2026-01-01_03-04-05.log'];
      assert.deepEqual(entries(), ['0. mihomo.log (当前运行中)', ...archives]);
      fs.unlinkSync(path.join(dataDir, 'logs', 'mihomo.log'));
      assert.deepEqual(entries(), archives);
    }));

  it('logs 1 映射到最新的归档（列表序号 1 起）', () =>
    withLogs(run => {
      const r = run(['logs', '1']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /archive-new-content/);
      assert.doesNotMatch(r.stdout, /archive-old-content/);
    }));

  it('logs ""（空串编号）显式报错，不静默落列表（变量展开为空的笔误要有反馈）', () =>
    withLogs(run => {
      const r = run(['logs', '']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /无效的日志编号 ""/);
    }));

  it('logs 0（当前日志）不存在时退出码透传 tail 的非零（脚本消费契约：空结果不当成功）', () => {
    // 独立 fixture：logs 目录存在但无 mihomo.log——tail 退 1，CLI 必须透传而非吞成 0
    const fixture = makeFixture('mihomo-logs-empty');
    try {
      fs.mkdirSync(path.join(fixture.dataDir, 'logs'), { recursive: true });
      const r = runCli(['logs', '0'], fixture);
      assert.notEqual(r.status, 0, 'tail 对不存在的文件退非零，CLI 不得吞成 0');
    } finally {
      fixture.cleanup();
    }
  });

  it('logs 9 越界报「未找到日志」，不静默回列表', () =>
    withLogs(run => {
      const r = run(['logs', '9']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /未找到日志 "9"/);
    }));
});
