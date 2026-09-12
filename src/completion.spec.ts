import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCompletionScript } from './commands/completion.js';
import { COMMANDS } from './commands/registry.js';
import { RESET_TARGETS } from './commands/reset.js';
import { MIRROR_ALIASES, UI_URLS } from './constants.js';
import { CliError } from './errors.js';
import { DIRECTORY_TARGETS } from './paths.js';

describe('buildCompletionScript', () => {
  for (const shell of ['zsh', 'bash', 'fish'] as const) {
    it(`${shell} 脚本包含注册表中全部命令`, () => {
      const script = buildCompletionScript(shell, COMMANDS);
      assert.ok(script.length > 100);
      for (const cmd of COMMANDS) {
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

  it('未知 shell 抛 CliError 并给 did-you-mean', () => {
    assert.throws(
      () => buildCompletionScript('zahs', COMMANDS),
      (e: unknown) => e instanceof CliError && /zsh/.test((e as CliError).hint.join(' ')),
    );
  });
});

describe('buildCompletionScript 的词表接线（单一真相源派生）', () => {
  // 期望值同样从真相源 import 派生（不在测试里再抄字面量）：锁的是「接线」而非「内容快照」——
  // 真相源加条目时，本组测试自动要求新成员出现在三个 shell 的补全里，防止词表再漂移。
  // 断言整份清单串而非单个词：kernel/logs/subs 等词因命令名本就在脚本里，逐词断言有假阳性
  const dirTargets = Object.keys(DIRECTORY_TARGETS).join(' ');
  const uiNames = Object.keys(UI_URLS).join(' ');
  const mirrorAliases = Object.keys(MIRROR_ALIASES).join(' ');
  // 与生成侧同为 aliases 派生：reset 认的主名与别名都该出现在补全里
  const resetTargets = [...new Set(RESET_TARGETS.flatMap(t => t.aliases))].join(' ');

  it('三个 shell 都包含派生自 DIRECTORY_TARGETS 的完整目录目标清单', () => {
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      const script = buildCompletionScript(shell, COMMANDS);
      assert.ok(script.includes(dirTargets), `${shell} 缺少目录目标清单 "${dirTargets}"（应派生自 DIRECTORY_TARGETS）`);
    }
  });

  it('三个 shell 都包含派生自 UI_URLS 的完整 UI 名单', () => {
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      const script = buildCompletionScript(shell, COMMANDS);
      assert.ok(script.includes(uiNames), `${shell} 缺少 UI 名单 "${uiNames}"（应派生自 UI_URLS）`);
    }
  });

  it('三个 shell 都包含派生自 MIRROR_ALIASES 的完整镜像别名', () => {
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      const script = buildCompletionScript(shell, COMMANDS);
      assert.ok(script.includes(mirrorAliases), `${shell} 缺少镜像别名 "${mirrorAliases}"（应派生自 MIRROR_ALIASES）`);
    }
  });

  it('三个 shell 都包含派生自 RESET_TARGETS 的完整 reset 目标清单（含别名）', () => {
    for (const shell of ['zsh', 'bash', 'fish'] as const) {
      const script = buildCompletionScript(shell, COMMANDS);
      assert.ok(script.includes(resetTargets), `${shell} 缺少 reset 目标清单 "${resetTargets}"（应派生自 RESET_TARGETS）`);
    }
  });

  it('reset 的 --yes 在 zsh/bash 以 --yes、在 fish 以 -l yes 出现（旧实现漏 --yes）', () => {
    for (const shell of ['zsh', 'bash'] as const) {
      assert.ok(buildCompletionScript(shell, COMMANDS).includes('--yes'), `${shell} 应提示 --yes`);
    }
    assert.ok(buildCompletionScript('fish', COMMANDS).includes('-l yes'), 'fish 应提示 --yes');
  });

  it('fish 的 -y/--yes 与 --full 是两个独立选项（旧实现绑成了一行）', () => {
    const script = buildCompletionScript('fish', COMMANDS);
    assert.ok(script.includes('-s y -l yes'), '应有独立的 -y/--yes 行');
    assert.ok(script.includes('-l full'), '应有独立的 --full 行');
    assert.ok(!script.includes('-s y -l full'), '不得再把 -y 绑成 --full 的短写');
  });
});

describe('fish 补全的目录目标 gating', () => {
  // 本机无 fish，无法执行校验（CODE_REVIEW 已声明该边界）：对生成后的脚本做字符串级断言。
  // 命令触发名单从注册表派生，与生成逻辑同源
  const dirCmd = COMMANDS.find(c => c.name === 'directory');
  if (!dirCmd) throw new Error('注册表缺少 directory 命令');
  const dirTokens = [dirCmd.name, ...dirCmd.aliases].join(' ');
  const dirTargets = Object.keys(DIRECTORY_TARGETS).join(' ');
  const uiNames = Object.keys(UI_URLS).join(' ');

  it('目录目标清单出现在「open 已被 seen」的条件分支内，而不是 dir 子命令分支内', () => {
    const script = buildCompletionScript('fish', COMMANDS);
    // 断言脚本结构：目标行的 -n 条件必须是「dir 命令已 seen **且** open 已 seen」，
    // 与 bash 的 COMP_WORDS[2] == open、zsh 的 words[2] == open 表达同一语义
    assert.ok(
      script.includes(`-n "__fish_seen_subcommand_from ${dirTokens}; and __fish_seen_subcommand_from open" -a '${dirTargets}'`),
      '目录目标清单应挂在 open 已 seen 的条件分支上',
    );
    // 旧缺陷形态：open 混进命令 seen 名单，`mihomo dir <TAB>` 时 dir 已被 seen、条件恒真，
    // 目标与 open 一起挤进只有 open 合法的位置——不得回归
    assert.ok(
      !script.includes(`-n "__fish_seen_subcommand_from ${dirTokens} open" -a '${dirTargets}'`),
      '目录目标清单不得挂在 dir 子命令分支上（缺少 open gating）',
    );
  });

  it('dir 子命令行带 not-open gating：open 已敲后不再重复提供 open', () => {
    const script = buildCompletionScript('fish', COMMANDS);
    assert.ok(
      script.includes(`-n "__fish_seen_subcommand_from ${dirTokens}; and not __fish_seen_subcommand_from open" -a 'open'`),
      '`dir open <TAB>` 后不应再次提供 open 子命令',
    );
  });

  it('ui 名单行带 not-gating：已选过 UI 后不再重复提供名单', () => {
    const script = buildCompletionScript('fish', COMMANDS);
    assert.ok(
      script.includes(`-n "__fish_seen_subcommand_from ui; and not __fish_seen_subcommand_from ${uiNames}" -a '${uiNames}'`),
      '`ui zash <TAB>` 后不应再次提供 UI 名单',
    );
  });
});
