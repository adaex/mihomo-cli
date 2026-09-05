import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCompletionScript } from './commands/completion.js';
import { COMMANDS } from './commands/registry.js';
import { CliError } from './errors.js';

describe('buildCompletionScript', () => {
  for (const shell of ['zsh', 'bash', 'fish'] as const) {
    it(`${shell} 脚本包含注册表中全部非 hidden 命令`, () => {
      const script = buildCompletionScript(shell, COMMANDS);
      assert.ok(script.length > 100);
      for (const cmd of COMMANDS.filter(c => !c.hidden)) {
        assert.ok(script.includes(cmd.name), `${shell} 脚本缺少命令 ${cmd.name}`);
      }
    });

    it(`${shell} 脚本包含订阅子命令`, () => {
      const script = buildCompletionScript(shell, COMMANDS);
      for (const sub of ['use', 'add', 'update', 'remove']) {
        assert.ok(script.includes(sub), `${shell} 脚本缺少子命令 ${sub}`);
      }
    });
  }

  it('zsh 脚本带 compdef 声明且覆盖全部别名', () => {
    const script = buildCompletionScript('zsh', COMMANDS);
    assert.ok(script.startsWith('#compdef mihomo mhm mh mihomo-cli'));
  });

  it('bash 脚本注册全部别名', () => {
    const script = buildCompletionScript('bash', COMMANDS);
    assert.ok(script.includes('complete -F _mihomo_completions mihomo mhm mh mihomo-cli'));
  });

  it('hidden 命令（墓碑/隐藏别名）不出现在补全词表', () => {
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      const script = buildCompletionScript(shell, COMMANDS);
      for (const cmd of COMMANDS.filter(c => c.hidden)) {
        // 墓碑命令名不应作为补全词出现（出现在注释/字符串里不算，这里粗查整词边界）
        const re = new RegExp(`['"]${cmd.name}['":]`);
        assert.ok(!re.test(script), `${shell} 脚本不应包含 hidden 命令 ${cmd.name}`);
      }
    }
  });

  it('未知 shell 抛 CliError 并给 did-you-mean', () => {
    assert.throws(
      () => buildCompletionScript('zahs', COMMANDS),
      (e: unknown) => e instanceof CliError && /zsh/.test((e as CliError).hint.join(' ')),
    );
  });
});
