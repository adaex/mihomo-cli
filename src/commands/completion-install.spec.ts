import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 补全的安装与卸载（落盘行为）。
 *
 * 跑真实 CLI 并把 `HOME` 指向临时目录——`completionInstallPath` 用 `os.homedir()`
 * 定位落盘位置，只有换 HOME 才能在不碰开发机 `~/.zsh`、`~/.bash_completion` 的前提下
 * 验证真实写入。断言的是**文件最终内容**，不是函数调用了什么。
 *
 * 重点是 bash：`~/.bash_completion` 是共享文件，卸载必须只剥掉自己那段，用户自己的
 * 补全一行都不能少。zsh/fish 独占文件名，重点则是「不是我们写的就不许删」。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-comp-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      MIHOMO_CLI_DIR: path.join(home, 'data'),
      MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(home)}`,
      NO_COLOR: '1',
    },
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

const USER_LINE = 'complete -F _my_thing mything';

describe('completion install/uninstall 的落盘行为', () => {
  it('bash：卸载只剥掉 mihomo 段，用户自己的内容原样保留', () => {
    const target = path.join(home, '.bash_completion');
    fs.writeFileSync(target, `# 用户自己的补全\n${USER_LINE}\n`);

    assert.equal(run(['completion', 'install', 'bash']).status, 0);
    const installed = fs.readFileSync(target, 'utf8');
    assert.ok(installed.includes(USER_LINE), '安装不该动用户已有内容');
    assert.ok(installed.includes('_mihomo_completions'), '安装应写入补全函数');

    assert.equal(run(['completion', 'uninstall', 'bash']).status, 0);
    const after = fs.readFileSync(target, 'utf8');
    assert.ok(after.includes(USER_LINE), '卸载必须保留用户自己的补全——这才是不能整文件删的理由');
    assert.ok(!after.includes('_mihomo_completions'), 'mihomo 段应被移除');
    assert.ok(!after.includes('mihomo-cli completion'), '标记本身也要移除');
  });

  it('bash：反复装卸不堆积空行，且文件只剩空白时整个删掉', () => {
    const target = path.join(home, '.bash_completion');
    for (let i = 0; i < 3; i++) {
      assert.equal(run(['completion', 'install', 'bash']).status, 0);
      assert.equal(run(['completion', 'uninstall', 'bash']).status, 0);
    }
    // 文件本就是我们建的（用户无内容），最后一次卸载后不该留个空文件
    assert.equal(fs.existsSync(target), false, '空文件应一并删除，否则装卸往返不干净');
  });

  it('zsh：装完能卸掉，文件消失', () => {
    const target = path.join(home, '.zsh', 'completions', '_mihomo');
    assert.equal(run(['completion', 'install', 'zsh']).status, 0);
    assert.ok(fs.existsSync(target));

    assert.equal(run(['completion', 'uninstall', 'zsh']).status, 0);
    assert.equal(fs.existsSync(target), false);
  });

  // 误删别人的文件比留下孤儿文件糟得多：用户可能自己写过同名补全
  it('zsh：不是本工具生成的同名文件拒绝删除，并给出手动路径', () => {
    const target = path.join(home, '.zsh', 'completions', '_mihomo');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# 我自己写的补全\ncompdef _whatever mihomo\n');

    const { status, output } = run(['completion', 'uninstall', 'zsh']);
    assert.notEqual(status, 0, '识别不出是自己的产物时必须失败退出，不能静默删掉');
    assert.match(output, /不像是 mihomo-cli 生成的/);
    assert.ok(fs.existsSync(target), '文件必须还在');
    assert.equal(fs.readFileSync(target, 'utf8').includes('我自己写的补全'), true);
  });

  // 回归：#compdef mihomo 是 compinit 对每个 _mihomo 补全要求的固定首行，用户手写或第三方
  // 分发的同名补全必然以它开头——只比对此前缀会误删。指纹必须是本工具独有的四别名完整行
  it('zsh：仅含行业约定首行 "#compdef mihomo" 的第三方补全不被误删', () => {
    const target = path.join(home, '.zsh', 'completions', '_mihomo');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#compdef mihomo\n# 第三方手写补全\n_my_mihomo() { ... }\n');

    const { status, output } = run(['completion', 'uninstall', 'zsh']);
    assert.notEqual(status, 0, output);
    assert.match(output, /不像是 mihomo-cli 生成的/);
    assert.ok(fs.existsSync(target), '第三方补全文件不能被删');
  });

  it('fish：只循环 mihomo 一个命令的手写补全不被弱指纹误删', () => {
    const target = path.join(home, '.config', 'fish', 'completions', 'mihomo.fish');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'for cmd in mihomo\n    complete -c $cmd -a "x"\nend\n');

    const { status, output } = run(['completion', 'uninstall', 'fish']);
    assert.notEqual(status, 0, output);
    assert.match(output, /不像是 mihomo-cli 生成的/);
    assert.ok(fs.existsSync(target));
  });

  it('fish：设置 XDG_CONFIG_HOME 时装在其下，卸载也认同一位置', () => {
    const xdg = path.join(home, 'xdg-config');
    const target = path.join(xdg, 'fish', 'completions', 'mihomo.fish');
    const runXdg = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: xdg,
          MIHOMO_CLI_DIR: path.join(home, 'data'),
          MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(home)}`,
          NO_COLOR: '1',
        },
        timeout: 30_000,
      });
    assert.equal(runXdg(['completion', 'install', 'fish']).status, 0);
    assert.ok(fs.existsSync(target), '应落在 $XDG_CONFIG_HOME/fish/completions');
    assert.equal(fs.existsSync(path.join(home, '.config', 'fish', 'completions', 'mihomo.fish')), false, '不应再写 ~/.config');
    assert.equal(runXdg(['completion', 'uninstall', 'fish']).status, 0);
    assert.equal(fs.existsSync(target), false);
  });

  it('未安装时卸载不报错（幂等）', () => {
    const { status, output } = run(['completion', 'uninstall', 'zsh']);
    assert.equal(status, 0, output);
    assert.match(output, /未安装/);
  });

  it('缺少 shell 参数或 shell 名拼错时报错', () => {
    assert.notEqual(run(['completion', 'uninstall']).status, 0);
    const { status, output } = run(['completion', 'uninstall', 'zsffh']);
    assert.notEqual(status, 0);
    assert.match(output, /zsh/, '拼错应给 did-you-mean');
  });
});
