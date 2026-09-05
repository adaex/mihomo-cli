import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCompletionScript } from './commands/completion.js';
import { CliError } from './errors.js';

describe('buildCompletionScript', () => {
  for (const shell of ['zsh', 'bash', 'fish'] as const) {
    it(`${shell} 脚本包含全部命令名与子命令`, () => {
      const script = buildCompletionScript(shell);
      assert.ok(script.length > 100);
      for (const word of ['install', 'start', 'stop', 'status', 'subscription', 'doctor', 'completion']) {
        assert.ok(script.includes(word), `${shell} 脚本缺少命令 ${word}`);
      }
      for (const sub of ['use', 'add', 'update', 'remove']) {
        assert.ok(script.includes(sub), `${shell} 脚本缺少子命令 ${sub}`);
      }
    });
  }

  it('zsh 脚本带 compdef 声明且覆盖全部别名', () => {
    const script = buildCompletionScript('zsh');
    assert.ok(script.startsWith('#compdef mihomo mhm mh mihomo-cli'));
  });

  it('bash 脚本注册全部别名', () => {
    const script = buildCompletionScript('bash');
    assert.ok(script.includes('complete -F _mihomo_completions mihomo mhm mh mihomo-cli'));
  });

  it('未知 shell 抛 CliError 并给 did-you-mean', () => {
    assert.throws(
      () => buildCompletionScript('zahs'),
      (e: unknown) => e instanceof CliError && /zsh/.test((e as CliError).hint.join(' ')),
    );
  });
});
