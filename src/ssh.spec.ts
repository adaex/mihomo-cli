import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError } from './errors.js';
import { validateSshName } from './settings.js';
import { buildSshArgs, validateSshHost } from './ssh.js';

const isCliError = (e: unknown): boolean => e instanceof CliError;

describe('buildSshArgs', () => {
  const args = buildSshArgs({ host: 'm4', port: 1080 });

  // 六个选项各自防一种失败模式，缺任何一个都会退化成「看着还活着但不通」的状态，
  // 见 docs/ssh-requirement.md 的「硬约束 1」
  for (const opt of ['ExitOnForwardFailure=yes', 'BatchMode=yes', 'ServerAliveInterval=30', 'ServerAliveCountMax=3', 'ConnectTimeout=15']) {
    it(`包含 -o ${opt}`, () => {
      const idx = args.indexOf(opt);
      assert.ok(idx > 0, `缺少 ${opt}: ${args.join(' ')}`);
      assert.equal(args[idx - 1], '-o', `${opt} 前应是 -o`);
    });
  }

  it('包含 -N（不执行远程命令）', () => {
    assert.ok(args.includes('-N'));
  });

  it('-D 恒绑 127.0.0.1，绝不绑 0.0.0.0（安全红线）', () => {
    const idx = args.indexOf('-D');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], '127.0.0.1:1080');
    assert.ok(!args.some(a => a.includes('0.0.0.0')), `不得出现 0.0.0.0: ${args.join(' ')}`);
  });

  it('主机名在最后一位', () => {
    assert.equal(args[args.length - 1], 'm4');
  });

  it('-D 偏移足够小，不会撞上 BSD ps 的 79 列截断', () => {
    // isProcessCommandMatching 用 `-D 127.0.0.1:<port>` 作 needle；该片段若偏移过大，
    // ps 截断会让匹配恒 false → 进程探测失效（历史上测速实例踩过这个坑）
    const needleOffset = `ssh ${args.join(' ')}`.indexOf('-D 127.0.0.1:1080');
    assert.ok(needleOffset < 79, `needle 偏移 ${needleOffset} 过大`);
  });
});

describe('validateSshHost', () => {
  it('拒绝以 - 开头的主机名（ssh 会当选项解析 → 任意命令执行）', () => {
    assert.throws(() => validateSshHost('-oProxyCommand=touch /tmp/pwned'), isCliError);
  });

  it('拒绝单独的 -o', () => {
    assert.throws(() => validateSshHost('-o'), isCliError);
  });

  for (const bad of ['a b', 'a;rm -rf /', 'a$(id)', 'a`id`', 'a|b', 'a&b', '', 'a>b']) {
    it(`拒绝非法主机名 ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validateSshHost(bad), isCliError);
    });
  }

  for (const good of ['m4', 'user@host', 'host.example.com', 'my-host_1', 'user@10.0.0.1']) {
    it(`接受合法主机名 ${good}`, () => {
      assert.doesNotThrow(() => validateSshHost(good));
    });
  }
});

describe('validateSshName', () => {
  // 名字会被拼进 ssh.<name>.yaml 与 ssh/<name>.json 两处路径
  for (const bad of ['../evil', 'a/b', 'a.b', '', 'a b', 'a'.repeat(65)]) {
    it(`拒绝非法名称 ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validateSshName(bad), isCliError);
    });
  }

  for (const good of ['work', 'work-1', 'work_1', '公司']) {
    it(`接受合法名称 ${good}`, () => {
      assert.doesNotThrow(() => validateSshName(good));
    });
  }
});
