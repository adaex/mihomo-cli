import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCompletionScript } from './commands/completion.js';
import { SUBCOMMANDS as DIRECTORY_SUBCOMMANDS } from './commands/directory.js';
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

/**
 * 描述文本的引号转义。
 *
 * 三个 shell 的单引号语义各不相同，而描述是人写的自由文本——迟早有人写出带撇号的
 * 说明。这组用例用注入的特殊描述把三份生成器的转义规则钉死。当前注册表里没有这类
 * 字符，故这些是给「下一个写描述的人」排的雷，不是现存可触发的缺陷。
 */
describe('补全脚本的描述文本转义', () => {
  const mkCommands = (desc: string) =>
    [
      { name: 'demo', aliases: [], group: 'system' as const, usage: [{ signature: 'demo', description: desc }], handler: () => {} },
    ] as unknown as typeof COMMANDS;

  it("zsh 用 '\\'' 而非 ''：后者仅在 RC_QUOTES 下才是转义，默认会把撇号吃掉", () => {
    const script = buildCompletionScript('zsh', mkCommands("it's a test"));
    const line = script.split('\n').find(l => l.includes('demo:'));
    // 实测依据（zsh 5.9，RC_QUOTES 默认关闭）：
    //   print -r -- 'it''s a test'   → its a test   （撇号被静默吞掉）
    //   setopt RC_QUOTES 后           → it's a test
    // 后果是描述损坏而非语法错误，`zsh -n` 照样通过、运行时也不报错
    assert.ok(line?.includes("it'\\''s a test"), `zsh 撇号应转义成 '\\'' ：${line}`);
    assert.ok(!line?.includes("it''s"), "不得使用 RC_QUOTES 专用的 '' 写法");
  });

  it('fish 先转义反斜杠再转义撇号：以反斜杠结尾的描述不会让字符串失闭合', () => {
    const endsWithBackslash = buildCompletionScript('fish', mkCommands('ends with backslash\\'));
    const line1 = endsWithBackslash.split('\n').find(l => l.includes("-a 'demo'"));
    // 不转义时生成 -d 'ends with backslash\'，末尾 \' 被 fish 读作转义撇号 → 字符串不闭合
    assert.ok(line1?.includes("-d 'ends with backslash\\\\'"), `fish 反斜杠应转义：${line1}`);

    const mixed = buildCompletionScript('fish', mkCommands("mix\\ and ' quote"));
    const line2 = mixed.split('\n').find(l => l.includes("-a 'demo'"));
    assert.ok(line2?.includes("-d 'mix\\\\ and \\' quote'"), `fish 混合转义应两者都处理：${line2}`);
  });

  it('反引号与 $(...) 只落在单引号内，不构成命令注入', () => {
    // 实测：含 `touch` 与 $(touch) 的描述经 zsh -n 校验通过且不创建文件——
    // 单引号内两者都不求值。这条锁住「危险文本不得跑到双引号或裸上下文里」
    for (const shell of ['zsh', 'fish'] as const) {
      const script = buildCompletionScript(shell, mkCommands('run `touch /tmp/x` and $(touch /tmp/y)'));
      const line = script.split('\n').find(l => l.includes('demo'));
      assert.ok(line?.includes("'"), `${shell}: 描述应处于单引号上下文：${line}`);
      assert.ok(!line?.includes('"run `touch'), `${shell}: 描述不得落进双引号上下文：${line}`);
    }
  });
});

/**
 * zsh 脚本结尾必须是 compdef 注册，不能是裸调用。
 *
 * 两条安装路径对结尾的要求不同，裸调用 `_mihomo "$@"` 只满足 fpath 那条：
 * `eval "$(mihomo completion zsh)"`（README 与 CLI 提示都推荐）下 `#compdef` 是
 * 注释、不生效，裸调用则在补全上下文之外执行 `_arguments`，实测报
 * `can only be called from completion function`，`_comps[mihomo]` 前后都是 0——
 * 补全没注册，eval 却返回 0，用户照文档做了却发现不工作且看不到原因。
 *
 * 这里断言生成形态；行为层面已用真实 zsh 验证过两条路径（见该行上方注释）。
 */
describe('zsh 补全的注册方式', () => {
  it('结尾用 compdef 注册四个别名，而非裸调用 _mihomo "$@"', () => {
    const script = buildCompletionScript('zsh', COMMANDS);
    assert.match(script, /^compdef _mihomo mihomo mhm mh mihomo-cli$/m, 'zsh 脚本应以 compdef 注册结尾');
    assert.ok(!/^_mihomo "\$@"$/m.test(script), '裸调用在 eval 模式下不注册补全，且会在补全上下文外执行 _arguments');
  });

  it('bash 同样是注册式（complete -F），两个 shell 的 eval 用法都成立', () => {
    const script = buildCompletionScript('bash', COMMANDS);
    assert.match(script, /^complete -F _mihomo_completions mihomo mhm mh mihomo-cli$/m);
  });
});

/**
 * 词表派生的两处历史缺口：bash 的 dir 分支硬编码 `open`、fish 的目录目标行硬编码
 * 四个 directory 别名。模块头部注释声称「不手写第二份词表」，这两处是反例——
 * 给 directory 加别名或加子命令时，相邻的派生分支会跟上而它们不会，就此分叉。
 *
 * 用注入一个额外别名的假注册表来验证：新别名必须同时出现在两处。
 */
describe('补全词表全部从注册表派生（无第二份硬编码）', () => {
  const withExtraAlias = COMMANDS.map(c => (c.name === 'directory' ? { ...c, aliases: [...c.aliases, 'folder'] } : c));

  it('fish 的目录目标行跟随 directory 的别名变化', () => {
    const script = buildCompletionScript('fish', withExtraAlias);
    const targetLine = script.split('\n').find(l => l.includes('__fish_seen_subcommand_from open') && l.includes('-a '));
    assert.ok(targetLine?.includes('folder'), `目标行应包含新别名 folder：${targetLine}`);
  });

  it('bash 的 dir 分支子命令词表派生自 DIRECTORY_SUBCOMMANDS，不写死 open', () => {
    const script = buildCompletionScript('bash', COMMANDS);
    // 词表来自 SUBCOMMANDS（当前只有 open，但必须是派生来的而非字面量）：
    // 加子命令时这里要自动跟上，与同函数的通用分支同构
    const dirSubWords = DIRECTORY_SUBCOMMANDS.flatMap(s => [s.name, ...(s.aliases ?? [])]).join(' ');
    assert.ok(script.includes(`compgen -W "${dirSubWords}"`), `bash dir 分支应使用派生词表 "${dirSubWords}"`);
  });
});
