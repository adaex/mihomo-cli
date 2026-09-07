import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-reset-'));
  const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
  try {
    assert.ok(dataDir.startsWith(os.tmpdir()));
    // 数据目录隔离不隔离 LaunchAgent：label 也要隔离，测试只能查询不存在的服务
    assert.equal(fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
    assert.equal(fs.existsSync(path.join('/Library/LaunchDaemons', `${label}.plist`)), false);
    for (const dir of ['subscriptions', 'kernel', 'logs']) fs.mkdirSync(path.join(dataDir, dir));
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        subscriptions: [{ name: 'x', url: 'https://example.com' }],
        active_subscription: 'x',
        overwrite_enabled: false,
        controller_secret: 'fixture-secret',
        ports: { mixed: 17890 },
      }),
    );
    fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), 'log-level: debug\n');
    fs.writeFileSync(path.join(dataDir, 'subscriptions', 'x.yaml'), 'proxies: []\n');
    fs.writeFileSync(path.join(dataDir, 'kernel', 'mihomo'), 'fixture');
    fs.writeFileSync(path.join(dataDir, 'logs', 'mihomo.log'), 'fixture');
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label, NO_COLOR: '1' },
      });
    check(dataDir, run);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('reset 的最终数据状态', () => {
  for (const targets of [['--full'], ['settings', 'subs', 'ow'], ['ow', 'subs', 'settings']]) {
    it(`${targets.join(' ')} 不重建设置，覆写回到默认启用`, () =>
      withFixture((dataDir, run) => {
        const result = run(['reset', ...targets, '-y']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false);
        assert.equal(fs.existsSync(path.join(dataDir, 'overwrite.yaml')), false);
        const status = run(['ow']);
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /已启用/);
      }));
  }

  it('部分重置只清除相关设置，保留端口和密钥', () =>
    withFixture((dataDir, run) => {
      const result = run(['reset', 'subs', 'ow', '-y']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')), {
        controller_secret: 'fixture-secret',
        ports: { mixed: 17890 },
      });
      assert.ok(fs.existsSync(path.join(dataDir, 'logs', 'mihomo.log')));
      assert.ok(fs.existsSync(path.join(dataDir, 'kernel', 'mihomo')));
    }));

  it('裸 reset 保留内核、覆写和其余设置', () =>
    withFixture((dataDir, run) => {
      const result = run(['reset', '-y']);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(fs.existsSync(path.join(dataDir, 'kernel', 'mihomo')));
      assert.ok(fs.existsSync(path.join(dataDir, 'overwrite.yaml')));
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
      assert.equal(settings.overwrite_enabled, false);
      assert.equal(settings.subscriptions, undefined);
      assert.equal(fs.existsSync(path.join(dataDir, 'logs', 'mihomo.log')), false);
    }));

  it('没有覆写文件时仍重置开关并准确报告，空设置不落盘', () =>
    withFixture((dataDir, run) => {
      fs.rmSync(path.join(dataDir, 'overwrite.yaml'));
      const result = run(['reset', 'ow', '-y']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /已重置: 覆写/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).overwrite_enabled, undefined);
      fs.rmSync(path.join(dataDir, 'settings.json'));
      const empty = run(['reset', 'ow', '-y']);
      assert.equal(empty.status, 0, empty.stderr);
      assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false);
    }));

  it('内核文件缺失时仍清理下载残留', () =>
    withFixture((dataDir, run) => {
      fs.rmSync(path.join(dataDir, 'kernel', 'mihomo'));
      fs.writeFileSync(path.join(dataDir, 'kernel', 'download.tmp'), 'incomplete');
      const result = run(['reset', 'kernel', '-y']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(fs.readdirSync(path.join(dataDir, 'kernel')), []);
    }));

  it('未知目标或不合法布尔选项在删除前失败', () =>
    withFixture((dataDir, run) => {
      const before = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
      for (const args of [['daemon'], ['daemon', '--full'], ['--full=false'], ['-yes']]) {
        assert.equal(run(['reset', ...args]).status, 1);
        assert.equal(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'), before);
      }
    }));
});
