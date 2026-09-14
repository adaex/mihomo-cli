import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 命令级帮助：`help <命令>` 与 `<命令> -h|--help|help`。
 * 此前三路全是错误（未知选项 / 未知子命令 / 多余位置参数），用户自然试法全是死路。
 * 顺带锁 status 对自定义控制器端口的展示（README 承诺「status 会显示实际端口」）。
 */
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');

function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-help-cli-'));
  const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
  try {
    fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ports: { mixed: 17890, controller: 19090 } }));
    fs.writeFileSync(path.join(dataDir, 'runtime', 'config.yaml'), ['mixed-port: 17890', 'external-controller: 127.0.0.1:19090', ''].join('\n'));
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label, NO_COLOR: '1' },
      });
    check(dataDir, run);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('命令级帮助', () => {
  it('help <命令> 只显示该命令的用法行', () => {
    withFixture((_d, run) => {
      const r = run(['help', 'subscription']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /mihomo subscription/);
      assert.match(r.stdout, /subscription use <name>/);
      assert.match(r.stdout, /别名: sub, subs, subscriptions/);
      // 是单命令帮助，不是整页
      assert.ok(!r.stdout.includes('体检诊断'), '不应展开整页帮助');
    });
  });

  it('help 未知命令给纠错建议而非堆栈', () => {
    withFixture((_d, run) => {
      const r = run(['help', 'stats']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /是否想输入: status/);
    });
  });

  it('help 只接受一个命令名，多给仍是多余参数', () => {
    withFixture((_d, run) => {
      const r = run(['help', 'status', 'extra']);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /多余的参数: extra/);
    });
  });

  it('<命令> -h / --help / help 三种自然试法都能拿到帮助', () => {
    withFixture((_d, run) => {
      for (const args of [
        ['status', '-h'],
        ['status', '--help'],
        ['sub', 'help'],
        ['ow', '-h'],
      ] as string[][]) {
        const r = run(args);
        assert.equal(r.status, 0, `${args.join(' ')} 应退出 0：${r.stderr}`);
        assert.ok(r.stdout.includes('用法:'), `${args.join(' ')} 应打印用法`);
      }
      assert.match(run(['sub', '--help']).stdout, /subscription add <url>/);
      assert.match(run(['ow', 'help']).stdout, /overwrite on\|off/);
    });
  });
});

describe('status 展示实际端口（含控制器口）', () => {
  it('自定义端口后人读与 JSON 两形态都显示控制器口', () => {
    withFixture((_d, run) => {
      const text = run(['status', '--no-probe']).stdout;
      assert.match(text, /17890，控制器 19090/);

      const json = JSON.parse(run(['status', '--json', '--no-probe']).stdout);
      assert.equal(json.ports.mixed, 17890);
      assert.equal(json.ports.controller, 19090);
    });
  });
});
