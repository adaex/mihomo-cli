import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 多余位置参数统一报错的端到端回归。
 *
 * 此前 flag 侧早已「未知即报错」，位置参数却只认第一个：`start mixed garbage`
 * 忽略 garbage 继续执行，`sub use foo bar`、`dir open logs extra`、`ui zash extra`、
 * `completion install zsh extra`、`help extra` 同型——与「未知命令、子命令和选项统一
 * 报错」的产品边界不对称。reset 是可变参数命令（每个位置参数都是目标名，自带校验），
 * 不在此列。
 *
 * 每个命令配一对用例：多余参数报「参数错误」；声明个数内的合法形态**不触发**该错误，
 * 而是到达各自的下一道校验或正常输出——后者是防误伤的关键断言（`sub use name -u 5000`
 * 的带值选项值、`logs 3 -f` 的 flag 位置都不能被算成位置参数）。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let dataDir: string;
let label: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-posargs-'));
  label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label, NO_COLOR: '1' },
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('多余位置参数报错', () => {
  const cases: [string, string[]][] = [
    ['start：模式之后', ['start', 'mixed', 'garbage']],
    ['start：两个模式 token', ['start', 'tun', 'mixed']],
    ['sub use：名称之后', ['sub', 'use', 'foo', 'bar']],
    ['sub update：名称之后', ['sub', 'update', 'foo', 'bar']],
    ['sub remove：名称之后', ['sub', 'remove', 'foo', 'bar']],
    ['sub add：超出 url 与可选 name', ['sub', 'add', 'https://example.com/s', 'n', 'extra']],
    ['dir open：目标之后', ['dir', 'open', 'logs', 'extra']],
    ['ui：名称之后', ['ui', 'zash', 'extra']],
    ['logs：编号之后', ['logs', '1', '2']],
    ['ow on：开关之后', ['ow', 'on', 'garbage']],
    ['completion install：shell 之后', ['completion', 'install', 'zsh', 'extra']],
    ['completion uninstall：shell 之后', ['completion', 'uninstall', 'zsh', 'extra']],
    ['completion 直接输出：shell 之后', ['completion', 'zsh', 'extra']],
    ['help：meta 不接受位置参数', ['help', 'extra']],
    ['version：meta 不接受位置参数', ['version', 'extra']],
    ['顶层快捷 use', ['use', 'foo', 'bar']],
    ['顶层快捷 tun', ['tun', 'extra']],
    ...(['stop', 'install', 'uninstall', 'status', 'config', 'update', 'doctor', 'kernel'] as const).map(
      cmd => [`零参命令 ${cmd}`, [cmd, 'garbage']] as [string, string[]],
    ),
  ];

  for (const [desc, args] of cases) {
    it(`${desc}（mihomo ${args.join(' ')}）报参数错误`, () => {
      const { status, output } = run(args);
      assert.notEqual(status, 0, `多余位置参数必须让命令失败，实际输出: ${output}`);
      assert.match(output, /参数错误/);
      assert.match(output, /多余的参数/);
      assert.match(output, new RegExp(`多余的参数: ${args[args.length - 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '报错应指明哪个参数多余');
    });
  }
});

describe('声明个数内的合法形态不触发参数错误', () => {
  it('start mixed 到达内核检查（而非参数错误）', () => {
    const { status, output } = run(['start', 'mixed']);
    assert.notEqual(status, 0);
    assert.match(output, /未找到内核/);
    assert.doesNotMatch(output, /多余的参数/);
  });

  it('start -u 5000 mixed：带值选项的值不算位置参数', () => {
    const { status, output } = run(['start', '-u', '5000', 'mixed']);
    assert.notEqual(status, 0);
    assert.match(output, /未找到内核/);
    assert.doesNotMatch(output, /多余的参数/);
  });

  it('sub use name -u 5000 到达订阅检查', () => {
    const { status, output } = run(['sub', 'use', 'foo', '-u', '5000']);
    assert.notEqual(status, 0);
    assert.match(output, /没有订阅/);
    assert.doesNotMatch(output, /多余的参数/);
  });

  it('sub update name 到达订阅检查', () => {
    const { status, output } = run(['sub', 'update', 'foo']);
    assert.notEqual(status, 0);
    assert.match(output, /没有订阅/);
  });

  it('sub remove -y foo：flag 在名称之前不受影响', () => {
    const { status, output } = run(['sub', 'remove', '-y', 'foo']);
    assert.notEqual(status, 0);
    assert.match(output, /未找到匹配 "foo"/);
  });

  it('sub add url name（两个位置参数）到达 URL 校验', () => {
    const { status, output } = run(['sub', 'add', 'not-a-url', 'n']);
    assert.notEqual(status, 0);
    assert.match(output, /有效的订阅 URL/);
  });

  it('dir open bogus 到达目标校验（不开 Finder）', () => {
    const { status, output } = run(['dir', 'open', 'bogus']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的目录目标/);
  });

  it('ui bogus 到达名称校验（不开浏览器）', () => {
    const { status, output } = run(['ui', 'bogus']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的 UI/);
  });

  it('logs 3 到达归档查找', () => {
    const { status, output } = run(['logs', '3']);
    assert.notEqual(status, 0);
    assert.match(output, /未找到日志/);
  });

  it('logs -f 3：flag 在编号之前不受影响', () => {
    const { status, output } = run(['logs', '-f', '3']);
    assert.notEqual(status, 0);
    assert.match(output, /未找到日志/);
  });

  it('ow on 正常执行（已是启用状态）', () => {
    const { status, output } = run(['ow', 'on']);
    assert.equal(status, 0, output);
    assert.match(output, /已是启用状态/);
  });

  it('completion install bogus 到达 shell 校验（不写文件）', () => {
    const { status, output } = run(['completion', 'install', 'bogus']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的 shell/);
  });

  it('completion bogus 到达 shell 校验', () => {
    const { status, output } = run(['completion', 'bogus']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的 shell/);
  });

  it('help / version 正常退出', () => {
    for (const cmd of ['help', 'version']) {
      const { status, output } = run([cmd]);
      assert.equal(status, 0, output);
      assert.doesNotMatch(output, /多余的参数/);
    }
  });

  it('stop 正常执行（不在运行）', () => {
    const { status, output } = run(['stop']);
    assert.equal(status, 0, output);
    assert.match(output, /不在运行/);
  });

  it('install 到达内核检查', () => {
    const { status, output } = run(['install']);
    assert.notEqual(status, 0);
    assert.match(output, /未找到内核/);
  });

  it('uninstall 正常执行（服务未安装）', () => {
    const { status, output } = run(['uninstall']);
    assert.equal(status, 0, output);
    assert.match(output, /服务未安装/);
  });

  it('status --no-probe 正常执行', () => {
    const { status, output } = run(['status', '--no-probe']);
    assert.equal(status, 0, output);
  });

  it('config 到达订阅检查', () => {
    const { status, output } = run(['config']);
    assert.notEqual(status, 0);
    assert.match(output, /尚无订阅/);
  });
});

describe('空串参数不当作缺省（变量展开为空的笔误要有反馈）', () => {
  it('ui "" 报未知 UI，不静默打开默认面板', () => {
    const { status, output } = run(['ui', '']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的 UI/);
  });

  it('dir open "" 报未知目标，不静默打开根目录', () => {
    const { status, output } = run(['directory', 'open', '']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的目录目标/);
  });
});

describe('重启透传选项即使不重启也被校验', () => {
  it('ow on -u（缺值）报错，不静默切换开关', () => {
    const { status, output } = run(['ow', 'on', '-u']);
    assert.notEqual(status, 0);
    assert.match(output, /选项 -u 缺少值/);
  });

  it('ow on -u5s（非法值）报错', () => {
    const { status, output } = run(['ow', 'on', '-u5s']);
    assert.notEqual(status, 0);
    assert.match(output, /需要正整数/);
  });

  it('裸 ow 的子命令位置给选项：按未知选项报错而非当子命令', () => {
    const { status, output } = run(['ow', '-s']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的选项: -s/);
  });
});

describe('kernel --mirror 重复显式报错', () => {
  it('两个 --mirror 不取第一个静默执行', () => {
    const { status, output } = run(['kernel', '--mirror', 'cdn', '--mirror', 'direct']);
    assert.notEqual(status, 0);
    assert.match(output, /--mirror 只能指定一次/);
  });
});
