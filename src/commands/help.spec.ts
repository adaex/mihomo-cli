import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeFixture, runCli } from '../test-support/cli.js';

/**
 * 命令级帮助：`help <命令>` 与 `<命令> -h|--help|help`。
 * 此前三路全是错误（未知选项 / 未知子命令 / 多余位置参数），用户自然试法全是死路。
 * 顺带锁 status 对自定义控制器端口的展示（README 承诺「status 会显示实际端口」）。
 */
function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const fixture = makeFixture('mihomo-help-cli');
  const { dataDir } = fixture;
  try {
    fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ports: { mixed: 17890, controller: 19090 } }));
    fs.writeFileSync(path.join(dataDir, 'runtime', 'config.yaml'), ['mixed-port: 17890', 'external-controller: 127.0.0.1:19090', ''].join('\n'));
    const run = (args: string[]) => runCli(args, fixture);
    check(dataDir, run);
  } finally {
    fixture.cleanup();
  }
}

describe('整页 help 的入口信息与快捷命令节', () => {
  it('命令别名行列出全部入口（mihomo-cli 与 mh），与 package.json bin 一致', () => {
    withFixture((_d, run) => {
      const r = run(['help']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /命令别名: mh\n/);
      assert.doesNotMatch(r.stdout, /命令别名:.*mhm/);
    });
  });

  it('快捷命令节包含 tun / use / restart 三条（README 同口径，help 内可发现）', () => {
    withFixture((_d, run) => {
      const r = run(['help']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /tun\s+= start tun/);
      assert.match(r.stdout, /use <name>\s+= subscription use <name>/);
      assert.match(r.stdout, /restart\s+= start（start 本身即重启）/);
    });
  });
});

describe('命令级帮助', () => {
  it('help <命令> 只显示该命令的用法行', () => {
    withFixture((_d, run) => {
      const r = run(['help', 'subscription']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /mihomo-cli subscription/);
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
      assert.match(run(['sub', '--help']).stdout, /subscription add \[url\] \[name\]/);
      assert.match(run(['ow', 'help']).stdout, /overwrite on\|off/);
    });
  });
});

describe('帮助文案与实际行为一致', () => {
  it('logs 用法行写明裸 logs 列列表、带查看选项才默认当前', () => {
    withFixture((_d, run) => {
      const out = run(['help', 'logs']).stdout;
      assert.match(out, /裸 logs 列列表/);
      assert.match(out, /省略编号但给 -f\/-n\/-o 时即当前/);
    });
  });

  it('version 用法行不带内嵌别名，别名只出现在别名行', () => {
    withFixture((_d, run) => {
      const out = run(['help', 'version']).stdout;
      assert.match(out, /^mihomo-cli version（别名: -v, --version）/m);
      assert.ok(!out.includes('version, -v'), '用法签名不得内嵌别名');
    });
  });

  it('subscription use 用法行写明自动重启，与 use 快捷行口径一致', () => {
    withFixture((_d, run) => {
      const out = run(['help', 'subscription']).stdout;
      assert.match(out, /subscription use <name>.*自动重启/);
    });
  });

  it('kernel 用法行的通道顺序与实际决策一致（本机代理优先、gh 回退）', () => {
    // 回归：通道改为「本机代理 > gh > 直连」后帮助仍写旧顺序「gh > 本机代理 > 直连」，
    // 用户按 help 排障被反向误导
    withFixture((_d, run) => {
      const out = run(['help', 'kernel']).stdout;
      assert.match(out, /本机代理 > gh > 直连/);
      assert.ok(!out.includes('gh > 本机代理'), '不得残留旧顺序');
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
