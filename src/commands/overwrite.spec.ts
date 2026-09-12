import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * `ow` 列表与 `status` 的覆写展示（CLI 级）。
 *
 * 「被停用的文件仍要列出并标注」是产品承诺：若 loadOverwriteFile 日后改成直接丢弃，
 * 单测层面 selectActiveOverwriteFiles 照样为空、测不出来，只有真跑命令看输出才拦得住。
 * 同 reset.spec：隔离 MIHOMO_CLI_DIR，并隔离 MIHOMO_CLI_DAEMON_LABEL（plist 在数据目录之外）。
 */
function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ow-cli-'));
  const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
  try {
    assert.ok(dataDir.startsWith(os.tmpdir()));
    assert.equal(fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
    fs.mkdirSync(path.join(dataDir, 'subscriptions'));
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        subscriptions: [{ name: 'edu1', url: 'https://update.glados-config.com/x' }],
        active_subscription: 'edu1',
      }),
    );
    fs.writeFileSync(path.join(dataDir, 'subscriptions', 'edu1.yaml'), 'proxies: []\n');
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

describe('ow 列表展示文件级开关', () => {
  it('停用的文件仍列出并标注已禁用，作用域照常显示', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'match:\n  name: edu*\nlog-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.b.yaml'), 'enabled: false\nlog-level: info\n');
      const out = run(['ow']).stdout;
      assert.match(out, /overwrite\.a\.yaml/);
      assert.match(out, /overwrite\.b\.yaml \[已禁用\]/);
      // 计数区分总数与未禁用数
      assert.match(out, /2 个，1 个未禁用/);
      // 回显用户写的原键名
      assert.match(out, /作用域: name=edu\*/);
    });
  });

  it('用法提示恒在：看到 [已禁用] 却不知怎么改回来是最直接的死路', () => {
    // 该行无条件打印，故断言点在「所有状态下都有」，而不是混在上面那条里
    // 当成功能性断言——那样无论功能好坏它都通过，测不出东西
    withFixture((dataDir, run) => {
      assert.match(run(['ow']).stdout, /停用单个文件: 在该文件顶部写 enabled: false/, '空列表时也应给出用法');
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'enabled: false\nlog-level: debug\n');
      assert.match(run(['ow']).stdout, /停用单个文件: 在该文件顶部写 enabled: false/, '有停用文件时更要给出用法');
    });
  });

  it('无停用文件时计数不加后缀（常态无噪音）', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      const out = run(['ow']).stdout;
      assert.match(out, /1 个，按顺序加载/);
      assert.ok(!out.includes('未禁用'), '没有停用文件时不该出现该计数');
      assert.ok(!out.includes('[已禁用]'));
    });
  });

  it('全局开关与文件级开关是两层，可同时区分', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'enabled: false\nlog-level: debug\n');
      run(['ow', 'off']);
      const out = run(['ow']).stdout;
      assert.match(out, /状态: 已禁用/); // 全局
      assert.match(out, /overwrite\.a\.yaml \[已禁用\]/); // 文件级
    });
  });

  it('enabled 写错时报错并指出是哪个文件', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.bad.yaml'), 'enabled: nope\nlog-level: debug\n');
      const r = run(['ow']);
      assert.notEqual(r.status, 0);
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, /overwrite\.bad\.yaml/);
      assert.match(out, /enabled 必须是布尔值/);
    });
  });

  it('status --json 的 overwrite.files 只含未停用的文件', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.b.yaml'), 'enabled: false\nlog-level: info\n');
      const json = JSON.parse(run(['status', '--json', '--no-probe']).stdout);
      assert.deepEqual(json.overwrite.files, ['overwrite.a.yaml']);
      assert.equal(json.overwrite.enabled, true, 'enabled 仍是全局开关，不受文件级影响');
    });
  });

  it('status 人读形态标出被停用的数量', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.b.yaml'), 'enabled: false\nlog-level: info\n');
      assert.match(run(['status', '--no-probe']).stdout, /覆写:.*已启用 \(a，1 个已禁用\)/);
    });
  });

  it('全部文件都被停用时不显示成「无文件」', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'enabled: false\nlog-level: debug\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /无生效文件，1 个已禁用/);
    });
  });
});
