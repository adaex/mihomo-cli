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
    // 覆写脚本与 YAML 同属 overwrites 目标：reset 的删除按 isOverwriteFilename 枚举，
    // 漏删脚本会让「已重置」之后覆写照常生效
    fs.writeFileSync(path.join(dataDir, 'overwrite.custom.js'), 'export default function () {}\n');
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
        assert.equal(fs.existsSync(path.join(dataDir, 'overwrite.custom.js')), false, '覆写脚本须与 YAML 一并删除');
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

describe('reset 目标解析的防呆', () => {
  it('目标与 --full 同现报错，不静默扩成全量', () => {
    // 回归：`reset subs --full` 此前静默忽略 subs、扩成全量重置——本意多半是
    // 「彻底删 subs」，却放大到删设置/内核/服务。矛盾输入显式报错，数据不动
    withFixture((dataDir, run) => {
      const result = run(['reset', 'subs', '--full', '-y']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /不能同时指定重置目标与 --full/);
      assert.ok(fs.existsSync(path.join(dataDir, 'subscriptions', 'x.yaml')), 'subs 未被删除');
      assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')), 'settings 未被删除');
    });
  });

  it('reset config 报未知目标（config 不是 settings 的别名）', () => {
    // 回归：`config` 曾在 settings 目标的别名里，与用户从 `mihomo-cli config` 命令得到的
    // 「运行配置」直觉对撞（那属于 runtime 目标）；`reset config -y` 会删超预期的
    // 订阅列表/端口/密钥。未知目标报错 + 目标列表兜底
    withFixture((dataDir, run) => {
      const result = run(['reset', 'config', '-y']);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /未知的重置目标/);
      assert.ok(fs.existsSync(path.join(dataDir, 'settings.json')), 'settings 未被删除');
    });
  });
});

describe('确认窗口的并发复核', () => {
  /**
   * 交互确认的等待无上界，期间另一终端可能装上/卸掉服务。锁定「确认通过后重读
   * 现值」：桩 launchctl 的 print 首次返回已装载（确认前快照）、之后返回未装载
   * （模拟并发卸载）——按确认前快照行动会对已不存在的服务调 uninstallService 并
   * 报「已重置: 服务」；重读后如实报「没有需要重置的内容」。
   * 正向（确认期间装上服务 → 停掉它）依赖完整 stopService 桩，此处锁定重读行为
   * 本身；停/卸动作语义由 service 层用例保证。
   * 隔离三层：MIHOMO_CLI_DIR（数据目录）+ MIHOMO_CLI_DAEMON_LABEL（一次性 label）
   * + 临时 HOME（userAgentPlist 随 homedir 走），桩 launchctl 走 PATH 前置。
   */
  it('确认后服务已被并发卸载：不调卸载、如实报告无内容', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-reset-recheck-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-reset-recheck-home-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-reset-recheck-bin-'));
    const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
    const countFile = path.join(fakeBin, 'count');
    try {
      fs.writeFileSync(
        path.join(fakeBin, 'launchctl'),
        `#!/bin/bash
n=$(cat '${countFile}' 2>/dev/null || echo 0)
echo $((n+1)) > '${countFile}'
case "$1" in
  print)
    if [ "$n" -eq 0 ]; then
      printf '\\tstate = running\\n\\tpid = 4242\\n'
      exit 0
    fi
    exit 113
    ;;
  *)
    exit 0
    ;;
esac
`,
      );
      fs.chmodSync(path.join(fakeBin, 'launchctl'), 0o755);
      const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), 'reset', 'service', '-y'], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          MIHOMO_CLI_DIR: dataDir,
          MIHOMO_CLI_DAEMON_LABEL: label,
          NO_COLOR: '1',
          HOME: fakeHome,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /没有需要重置的内容/);
      assert.doesNotMatch(result.stdout, /已重置/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
