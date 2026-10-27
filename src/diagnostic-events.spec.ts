import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeFixture, moduleUrl, runCli, runModule, spawnCli } from './test-support/cli.js';
import { pollUntil } from './test-support/poll.js';
import { spawnEval } from './test-support/spawn-eval.js';

interface EventRow {
  v: number;
  ts: string;
  event: string;
  result: string;
  operationId: string;
  command: string;
  pid: number;
  exitCode?: number;
  durationMs?: number;
  succeeded?: number;
  [key: string]: unknown;
}

function diagnosticPath(dataDir: string): string {
  return path.join(dataDir, 'logs', 'diagnostic.jsonl');
}

function readEvents(dataDir: string): EventRow[] {
  const text = fs.readFileSync(diagnosticPath(dataDir), 'utf8');
  assert.ok(text.endsWith('\n'), 'JSONL 必须以完整换行收尾');
  return text
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as EventRow);
}

function assertCommandEvent(row: EventRow, command: string, exitCode: number): void {
  assert.deepEqual(Object.keys(row).sort(), ['command', 'durationMs', 'event', 'exitCode', 'operationId', 'pid', 'result', 'ts', 'v'].sort());
  assert.equal(row.v, 1);
  assert.equal(row.event, 'cli.command');
  assert.equal(row.command, command);
  assert.equal(row.exitCode, exitCode);
  assert.equal(row.result, exitCode === 0 ? 'success' : 'failure');
  assert.ok(Number.isFinite(Date.parse(row.ts)));
  assert.ok(typeof row.durationMs === 'number' && row.durationMs >= 0);
  assert.ok(row.operationId.length > 0);
  assert.ok(row.pid > 0);
}

describe('CLI 诊断事件', () => {
  it('成功与失败命令各留下固定字段事件，新建文件权限为 0600', () => {
    const fixture = makeFixture('mihomo-diagnostic-command');
    try {
      const success = runCli(['dir'], fixture);
      assert.equal(success.status, 0, success.stderr);
      const failure = runCli(['dir', 'open', 'not-a-target'], fixture);
      assert.notEqual(failure.status, 0);

      const rows = readEvents(fixture.dataDir);
      assert.equal(rows.length, 2);
      assertCommandEvent(rows[0], 'directory', 0);
      assertCommandEvent(rows[1], 'directory', 1);
      assert.notEqual(rows[0].operationId, rows[1].operationId);
      assert.equal(fs.statSync(diagnosticPath(fixture.dataDir)).mode & 0o777, 0o600);
    } finally {
      fixture.cleanup();
    }
  });

  it('未建立 CLI 上下文与 help/version 豁免路径均不写诊断文件', () => {
    const fixture = makeFixture('mihomo-diagnostic-disabled');
    try {
      const direct = runModule(
        `import { recordDiagnosticEvent } from ${JSON.stringify(moduleUrl('src/diagnostic-events.ts'))}; recordDiagnosticEvent('test.disabled', 'success');`,
        fixture.dataDir,
      );
      assert.equal(direct.status, 0, direct.stderr);
      assert.equal(fs.existsSync(diagnosticPath(fixture.dataDir)), false);

      const help = runCli(['help'], fixture);
      assert.equal(help.status, 0, help.stderr);
      const version = runCli(['version'], fixture);
      assert.equal(version.status, 0, version.stderr);
      assert.equal(fs.existsSync(diagnosticPath(fixture.dataDir)), false);
    } finally {
      fixture.cleanup();
    }
  });

  it('start 在进入环境检查前记录安全的模式与更新选项', () => {
    const fixture = makeFixture('mihomo-diagnostic-start');
    try {
      const result = runCli(['start', 'tun', '-s', '-u', '1234'], fixture);
      assert.notEqual(result.status, 0, '未安装内核的隔离目录应在启动前失败');
      const rows = readEvents(fixture.dataDir);
      assert.deepEqual(
        rows.map(row => row.event),
        ['start', 'cli.command'],
      );
      assert.equal(rows[0].result, 'begin');
      assert.equal(rows[0].mode, 'tun');
      assert.equal(rows[0].updateRequested, false);
      assert.equal(rows[0].timeoutMs, 1234);
      assertCommandEvent(rows[1], 'start', 1);
    } finally {
      fixture.cleanup();
    }
  });

  it('自动更新 fresh 跳过与整体超时分别记录，abort 不算真实下载失败', async () => {
    const freshFixture = makeFixture('mihomo-diagnostic-auto-fresh');
    try {
      const script = `
        import { beginDiagnosticOperation } from ${JSON.stringify(moduleUrl('src/diagnostic-events.ts'))};
        import { autoUpdateStaleSubscription } from ${JSON.stringify(moduleUrl('src/subscription.ts'))};
        beginDiagnosticOperation('test');
        await autoUpdateStaleSubscription();
      `;
      const result = runModule(script, freshFixture.dataDir);
      assert.equal(result.status, 0, result.stderr);
      const rows = readEvents(freshFixture.dataDir);
      assert.deepEqual(
        rows.map(row => row.event),
        ['subscription.auto-update', 'cli.command'],
      );
      assert.equal(rows[0].result, 'skipped');
      assert.equal(rows[0].reason, 'fresh');
    } finally {
      freshFixture.cleanup();
    }

    const server = http.createServer(() => {
      // 刻意不响应，由 autoUpdate 的整体预算 abort 在途 fetch
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const fixture = makeFixture('mihomo-diagnostic-auto-timeout');
    const url = `http://127.0.0.1:${address.port}/slow`;
    fs.writeFileSync(path.join(fixture.dataDir, 'settings.json'), JSON.stringify({ subscriptions: [{ name: 'x', url }], active_subscription: 'x' }));
    const script = `
      import { beginDiagnosticOperation } from ${JSON.stringify(moduleUrl('src/diagnostic-events.ts'))};
      import { autoUpdateStaleSubscription } from ${JSON.stringify(moduleUrl('src/subscription.ts'))};
      beginDiagnosticOperation('test');
      await autoUpdateStaleSubscription({ timeout: 25 });
    `;
    const run = spawnEval(script, { env: { MIHOMO_CLI_DIR: fixture.dataDir } });
    try {
      assert.equal(await run.done, 0);
      const rows = readEvents(fixture.dataDir);
      assert.deepEqual(
        rows.map(row => row.event),
        ['subscription.download', 'subscription.auto-update', 'cli.command'],
      );
      assert.equal(rows[0].result, 'aborted');
      assert.equal(rows[0].stage, 'http');
      assert.equal(rows[1].result, 'timeout');
      assert.equal(rows[1].timedOut, true);
      assert.equal(rows[1].abortedCount, 1);
      assert.equal(rows[1].failed, 0);
    } finally {
      run.child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fixture.cleanup();
    }
  });

  it('原始 URL、userinfo、token 与订阅名参数不进入事件文件', () => {
    const fixture = makeFixture('mihomo-diagnostic-privacy');
    const url = 'https://user:password@example.com/api/v1/client/subscribe/CANARY_PATH_TOKEN_123456?token=CANARY_QUERY_TOKEN';
    try {
      const result = runCli(['sub', 'add', url, ''], fixture);
      assert.notEqual(result.status, 0, '空订阅名应在联网前失败');
      const text = fs.readFileSync(diagnosticPath(fixture.dataDir), 'utf8');
      for (const canary of [url, 'user:password', 'CANARY_PATH_TOKEN_123456', 'CANARY_QUERY_TOKEN']) {
        assert.ok(!text.includes(canary), `诊断文件不得包含敏感输入: ${canary}`);
      }
      const rows = readEvents(fixture.dataDir);
      assert.equal(rows.length, 1);
      assertCommandEvent(rows[0], 'sub add', 1);
    } finally {
      fixture.cleanup();
    }
  });

  it('诊断写入失败不改变成功命令输出，也不替换原命令错误', () => {
    const fixture = makeFixture('mihomo-diagnostic-eisdir');
    try {
      fs.mkdirSync(diagnosticPath(fixture.dataDir), { recursive: true });
      const success = runCli(['dir'], fixture);
      assert.equal(success.status, 0, success.stderr);
      assert.match(success.stdout, /数据目录/);
      assert.doesNotMatch(success.stderr, /EISDIR|diagnostic/);

      const failure = runCli(['dir', 'open', 'not-a-target'], fixture);
      assert.notEqual(failure.status, 0);
      assert.match(failure.stderr, /未知的目录目标/);
      assert.doesNotMatch(failure.stderr, /EISDIR|diagnostic/);
    } finally {
      fixture.cleanup();
    }
  });

  it('大小轮转保留当前事件并清理 7 天前归档', () => {
    const fixture = makeFixture('mihomo-diagnostic-rotation');
    try {
      const script = `
        import fs from 'node:fs';
        import path from 'node:path';
        import { DIRS, PATHS, ensureDirs } from ${JSON.stringify(moduleUrl('src/paths.ts'))};
        import { beginDiagnosticOperation, DIAGNOSTIC_LOG_MAX_BYTES, recordDiagnosticEvent } from ${JSON.stringify(moduleUrl('src/diagnostic-events.ts'))};
        ensureDirs();
        fs.writeFileSync(PATHS.diagnosticEventsFile, 'x'.repeat(DIAGNOSTIC_LOG_MAX_BYTES));
        const expired = path.join(DIRS.logs, 'diagnostic.2020-01-01_00-00-00.jsonl');
        fs.writeFileSync(expired, 'expired');
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        fs.utimesSync(expired, old, old);
        beginDiagnosticOperation('test');
        recordDiagnosticEvent('test.rotation', 'success', { reason: 'size' });
      `;
      const result = runModule(script, fixture.dataDir);
      assert.equal(result.status, 0, result.stderr);

      const rows = readEvents(fixture.dataDir);
      assert.deepEqual(
        rows.map(row => row.event),
        ['test.rotation', 'cli.command'],
      );
      assert.equal(new Set(rows.map(row => row.operationId)).size, 1);
      const archives = fs.readdirSync(path.join(fixture.dataDir, 'logs')).filter(file => /^diagnostic\..*\.jsonl$/.test(file) && file !== 'diagnostic.jsonl');
      assert.equal(archives.length, 1, `过期归档应清理，仅保留本次轮转: ${archives.join(', ')}`);
      assert.ok(!archives.includes('diagnostic.2020-01-01_00-00-00.jsonl'));
      assert.equal(fs.statSync(path.join(fixture.dataDir, 'logs', archives[0])).size > 0, true);
    } finally {
      fixture.cleanup();
    }
  });

  it('reset logs 删除旧历史，退出时只重建本次 reset 事件', () => {
    const fixture = makeFixture('mihomo-diagnostic-reset');
    try {
      fs.mkdirSync(path.dirname(diagnosticPath(fixture.dataDir)), { recursive: true });
      fs.writeFileSync(diagnosticPath(fixture.dataDir), '{"event":"OLD_CANARY"}\n');
      const result = runCli(['reset', 'logs', '-y'], fixture);
      assert.equal(result.status, 0, result.stderr);
      const text = fs.readFileSync(diagnosticPath(fixture.dataDir), 'utf8');
      assert.ok(!text.includes('OLD_CANARY'));
      const rows = readEvents(fixture.dataDir);
      assert.equal(rows.length, 1);
      assertCommandEvent(rows[0], 'reset', 0);
    } finally {
      fixture.cleanup();
    }
  });

  it('订阅添加与更新记录前后哈希，敏感配置和原始 URL 不落盘', async () => {
    const initialContent = `proxies:\n  - {name: CANARY_NODE_NAME, type: trojan, server: 127.0.0.1, port: 443, password: SECRET_ONE_PASSWORD, uuid: CANARY_UUID}\nproxy-groups:\n  - {name: PROXY, type: select, proxies: [CANARY_NODE_NAME]}\n`;
    const changedContent = initialContent.replace('SECRET_ONE_PASSWORD', 'SECRET_TWO_PASSWORD');
    let responseContent = initialContent;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(responseContent);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const fixture = makeFixture('mihomo-diagnostic-subscription');
    const run = async (args: string[]) => {
      // 父进程持有本地 HTTP server，必须异步 spawn；spawnSync 会堵住父事件循环形成父子死锁
      const { child, done } = spawnCli(args, fixture);
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      try {
        return await done;
      } finally {
        clearTimeout(timer);
        child.kill('SIGKILL');
      }
    };
    try {
      const url = `http://127.0.0.1:${address.port}/subscribe/CANARY_PATH_TOKEN?token=CANARY_QUERY_TOKEN`;
      const added = await run(['sub', 'add', url, 'CANARY_SUB_NAME']);
      assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);

      responseContent = changedContent;
      const changed = await run(['sub', 'update', 'CANARY_SUB_NAME']);
      assert.equal(changed.status, 0, `${changed.stdout}\n${changed.stderr}`);
      const unchanged = await run(['sub', 'update', 'CANARY_SUB_NAME']);
      assert.equal(unchanged.status, 0, `${unchanged.stdout}\n${unchanged.stderr}`);

      const text = fs.readFileSync(diagnosticPath(fixture.dataDir), 'utf8');
      for (const canary of [
        'CANARY_PATH_TOKEN',
        'CANARY_QUERY_TOKEN',
        'CANARY_SUB_NAME',
        'CANARY_NODE_NAME',
        'SECRET_ONE_PASSWORD',
        'SECRET_TWO_PASSWORD',
        'CANARY_UUID',
      ]) {
        assert.ok(!text.includes(canary), `诊断文件不得包含 ${canary}`);
      }
      const rows = readEvents(fixture.dataDir);
      assert.deepEqual(
        rows.map(row => row.event),
        ['subscription.download', 'cli.command', 'subscription.download', 'cli.command', 'subscription.download', 'cli.command'],
      );
      assert.deepEqual(
        rows.filter(row => row.event === 'cli.command').map(row => row.command),
        ['sub add', 'sub update', 'sub update'],
      );
      const downloads = rows.filter(row => row.event === 'subscription.download');
      const initialHash = createHash('sha256').update(initialContent, 'utf8').digest('hex');
      const changedHash = createHash('sha256').update(changedContent, 'utf8').digest('hex');
      assert.equal(downloads[0].rawBeforeSha256, null);
      assert.equal(downloads[0].rawAfterSha256, initialHash);
      assert.equal(downloads[0].changed, true);
      assert.equal(downloads[1].rawBeforeSha256, initialHash);
      assert.equal(downloads[1].rawAfterSha256, changedHash);
      assert.equal(downloads[1].changed, true);
      assert.equal(downloads[2].rawBeforeSha256, changedHash);
      assert.equal(downloads[2].rawAfterSha256, changedHash);
      assert.equal(downloads[2].changed, false);
      for (const row of rows) {
        for (const forbidden of ['args', 'url', 'subscription', 'message', 'stack', 'content']) {
          assert.ok(!(forbidden in row), `事件不得出现自由文本/敏感字段 ${forbidden}`);
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fixture.cleanup();
    }
  });

  it('多进程 O_APPEND 不交叉 JSON，事件按 operation id 与 pid 完整归属', async () => {
    const fixture = makeFixture('mihomo-diagnostic-concurrent');
    const childCount = 4;
    const eventsPerChild = 50;
    const childScript = (id: string) => `
      import fs from 'node:fs';
      import path from 'node:path';
      import { beginDiagnosticOperation, recordDiagnosticEvent } from ${JSON.stringify(moduleUrl('src/diagnostic-events.ts'))};
      const dataDir = ${JSON.stringify(fixture.dataDir)};
      beginDiagnosticOperation('concurrent');
      fs.writeFileSync(path.join(dataDir, 'ready-${id}'), '');
      while (!fs.existsSync(path.join(dataDir, 'go'))) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      for (let i = 0; i < ${eventsPerChild}; i++) {
        recordDiagnosticEvent('test.append', 'success', { succeeded: i });
      }
    `;
    const runs = Array.from({ length: childCount }, (_, index) => spawnEval(childScript(String(index)), { env: { MIHOMO_CLI_DIR: fixture.dataDir } }));
    try {
      for (let index = 0; index < childCount; index++) {
        assert.ok(
          pollUntil(() => fs.existsSync(path.join(fixture.dataDir, `ready-${index}`)), 10_000),
          `等待子进程 ${index} 就绪超时`,
        );
      }
      fs.writeFileSync(path.join(fixture.dataDir, 'go'), '');
      assert.deepEqual(await Promise.all(runs.map(run => run.done)), [0, 0, 0, 0]);

      const rows = readEvents(fixture.dataDir);
      assert.equal(rows.length, childCount * (eventsPerChild + 1));
      const appended = rows.filter(row => row.event === 'test.append');
      assert.equal(appended.length, childCount * eventsPerChild);
      assert.equal(new Set(appended.map(row => row.operationId)).size, childCount);
      for (const pid of new Set(appended.map(row => row.pid))) {
        const own = appended.filter(row => row.pid === pid);
        assert.equal(own.length, eventsPerChild);
        assert.deepEqual(
          own.map(row => row.succeeded).sort((a, b) => Number(a) - Number(b)),
          Array.from({ length: eventsPerChild }, (_, index) => index),
        );
        assert.equal(new Set(own.map(row => row.operationId)).size, 1);
      }
    } finally {
      for (const run of runs) run.child.kill('SIGKILL');
      fixture.cleanup();
    }
  });
});
