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

  it('删除计划含订阅时挑明链接不可恢复；不含订阅时不恐吓', () =>
    withFixture((_dataDir, run) => {
      // 非 TTY 且无 -y：确认环节报错退出，但删除计划在确认前已打印
      const bare = run(['reset']);
      assert.notEqual(bare.status, 0);
      assert.match(bare.stdout, /订阅链接与本地配置将被删除且无法恢复/);

      const explicit = run(['reset', 'subs']);
      assert.notEqual(explicit.status, 0);
      assert.match(explicit.stdout, /无法恢复/);

      const logs = run(['reset', 'logs']);
      assert.notEqual(logs.status, 0);
      assert.ok(!logs.stdout.includes('无法恢复'), '与订阅无关的目标不该显示该警告');
    }));

  /**
   * 会破坏运行前提的 reset 必须记录「停止过」，纯配置类的不记录。
   *
   * 缺了前者：服务未装（本 fixture 即如此，label 是隔离的假 label）时 reset 不走
   * stopService，没有 disable 可执行，却已经把 runtime/config.yaml 或 kernel/ 删掉——
   * 并发的慢速 start 看不到变化，就会 bootstrap 一个内核已被删除的 plist，
   * 落进 KeepAlive 每约 10s 拉起一次的崩溃循环。
   */
  const readEpoch = (dataDir: string): number => {
    const servicePath = path.resolve('src/service.ts');
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', `import { readStopEpoch } from ${JSON.stringify(servicePath)}; process.stdout.write(String(readStopEpoch()));`],
      { encoding: 'utf8', env: { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_ALLOW_ANY_PLATFORM: '1' }, timeout: 30_000 },
    );
    assert.equal(r.status, 0, `读取子进程应正常退出: ${r.stderr}`);
    return Number.parseInt(r.stdout.trim(), 10);
  };

  it('删除运行前提的 reset 记录停止，纯配置的 reset 不记录', () =>
    withFixture((dataDir, run) => {
      // logs 的 needsStop 为真：清理游离内核后即将删文件
      const beforeLogs = readEpoch(dataDir);
      const logs = run(['reset', 'logs', '-y']);
      assert.equal(logs.status, 0, logs.stderr);
      assert.equal(fs.existsSync(path.join(dataDir, 'logs', 'mihomo.log')), false);
      assert.notEqual(readEpoch(dataDir), beforeLogs, 'reset logs 会清进程并删文件，必须让并发的 start 看见');

      // overwrites 的 needsStop 为假：只动配置文件，不该中止并发的 start
      const beforeOw = readEpoch(dataDir);
      const ow = run(['reset', 'ow', '-y']);
      assert.equal(ow.status, 0, ow.stderr);
      assert.equal(readEpoch(dataDir), beforeOw, 'reset ow 不碰运行前提，不该记录停止');
    }));
});
