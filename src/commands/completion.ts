import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { colors } from '../colors.js';
import { MIRROR_ALIASES, UI_URLS } from '../constants.js';
import { CliError } from '../errors.js';
import { DIRECTORY_TARGETS } from '../paths.js';
import { assertKnownFlags, assertPositionalCount, suggestSimilar } from '../utils.js';
import { SUBCOMMANDS as DIRECTORY_SUBCOMMANDS } from './directory.js';
import { SUBCOMMANDS as OVERWRITE_SUBCOMMANDS } from './overwrite.js';
import type { Command } from './registry.js';
import { RESET_TARGETS } from './reset.js';
import type { SubCommand } from './shared.js';
import { SUBCOMMANDS as SUBSCRIPTION_SUBCOMMANDS } from './subscription.js';

/**
 * Shell 补全脚本生成。词表**从命令注册表派生**（cmdCompletion 传入 COMMANDS），
 * 子命令词表从各命令模块导出的 SUBCOMMANDS 派生（含别名展开），
 * 目录目标/UI 名单/镜像别名/reset 目标分别派生自 DIRECTORY_TARGETS/UI_URLS/
 * MIRROR_ALIASES/RESET_TARGETS——不手写第二份词表，新增命令/子命令/目标/别名
 * 自动出现在补全里。三个 shell 的脚本结构各自手写，词表同源。
 *
 * completion.ts 不 import registry 的运行时（registry import 本模块的 cmdCompletion，
 * 反向 import 会成环）；Command 仅作类型导入。reset.ts 的依赖链不经过 commands/
 * 目录（核心模块不反向 import），故 import RESET_TARGETS 不成环。
 */

interface CompletionWord {
  word: string;
  desc: string;
}

/** 命令词表：注册表中所有命令（含别名），desc 取首条用法行说明 */
function commandWords(commands: Command[]): CompletionWord[] {
  return commands.flatMap(c => [
    { word: c.name, desc: c.usage[0]?.description ?? '' },
    ...c.aliases.map(a => ({ word: a, desc: c.usage[0]?.description ?? '' })),
  ]);
}

/** 子命令词表：主名 + 别名展开，desc 取 SubCommand.description */
function subWords(subs: SubCommand[]): CompletionWord[] {
  return subs.flatMap(s => [{ word: s.name, desc: s.description ?? '' }, ...(s.aliases ?? []).map(a => ({ word: a, desc: s.description ?? '' }))]);
}

interface SubGroup {
  /** 触发该组的命令 token（主名 + 别名），用于 zsh/bash/fish 的 case 匹配 */
  tokens: string[];
  words: CompletionWord[];
}

/** 子命令组：从注册表取命令的主名+别名作为触发 token，子命令词表从 SUBCOMMANDS 派生 */
function subGroups(commands: Command[]): SubGroup[] {
  const groupOf = (name: string, subs: SubCommand[]): SubGroup => {
    const cmd = commands.find(c => c.name === name);
    return { tokens: cmd ? [cmd.name, ...cmd.aliases] : [name], words: subWords(subs) };
  };
  return [groupOf('subscription', SUBSCRIPTION_SUBCOMMANDS), groupOf('overwrite', OVERWRITE_SUBCOMMANDS), groupOf('directory', DIRECTORY_SUBCOMMANDS)];
}

// 以下词表全部从单一真相源派生（此前是四份硬编码副本：paths/constants/reset
// 加条目时 `dir open`/`--mirror`/`reset` 认、补全静默不提示，且无测试兜底）
const DIR_TARGETS = Object.keys(DIRECTORY_TARGETS);
const UI_NAMES = Object.keys(UI_URLS);
const MIRROR_NAMES = Object.keys(MIRROR_ALIASES);
// reset 认主名也认别名（sub/log/ow/config/core 等），补全词表从同一份别名表派生，
// 不只给 id——否则「命令认、补全不提示」又是一份漂移副本
const RESET_TARGET_NAMES = [...new Set(RESET_TARGETS.flatMap(t => t.aliases))];
const SHELLS = ['zsh', 'bash', 'fish'] as const;

/**
 * 转义要放进 zsh **单引号**字符串的文本。
 *
 * 必须是 `'\''`（闭合 → 转义的字面撇号 → 重开），**不能用 `''`**：后者只在
 * `RC_QUOTES` 选项开启时才是转义，而该选项**默认关闭**。默认下 `'it''s'` 是两个
 * 相邻单引号串的拼接，撇号被静默吃掉——实测 `print -r -- 'it''s a test'` 输出
 * `its a test`（开 RC_QUOTES 才是 `it's a test`）。
 *
 * 后果不是语法错误而是**描述文本损坏**：`_describe` 拿到的说明少了撇号，用户看到
 * 的补全提示是错的，且没有任何报错。fish 分支两个函数之外用的是 `\'`（在 fish 里
 * 正确），两处写法不同更容易让人以为 zsh 这边也是对的。
 *
 * 当前注册表里没有带撇号的描述，故这是给下一个写描述的人排的雷，不是现存可触发的 bug。
 */
function zshSingleQuote(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function buildZsh(commands: Command[], groups: SubGroup[]): string {
  const lines: string[] = [
    '#compdef mihomo mhm mh mihomo-cli',
    '',
    '# mihomo-cli zsh 补全（mihomo completion zsh 生成；安装: mihomo completion install zsh，或 eval "$(mihomo completion zsh)"）',
    '',
    '_mihomo() {',
    '  local -a commands subcmds',
    '  commands=(',
    ...commandWords(commands).map(c => `    '${c.word}:${zshSingleQuote(c.desc)}'`),
    '  )',
    '',
    '  _arguments -C \\',
    "    '1: :->cmd' \\",
    "    '*::arg:->args'",
    '',
    '  case $state in',
    '    cmd)',
    "      _describe 'command' commands",
    '      ;;',
    '    args)',
    '      case ${words[1]} in',
  ];
  for (const group of groups) {
    const aliases = group.tokens.join('|');
    const isDirectory = group.tokens.includes('directory');
    lines.push(`        ${aliases})`);
    lines.push('          subcmds=(');
    for (const s of group.words) lines.push(`            '${s.word}:${zshSingleQuote(s.desc)}'`);
    lines.push('          )');
    lines.push('          if (( CURRENT == 2 )); then');
    lines.push("            _describe 'subcommand' subcmds");
    if (isDirectory) {
      // dir open <TAB> 补目标列表（此前硬编码了一个同名 case，但 zsh 取第一个匹配，
      // group 分支先生成、硬编码分支永不可达，dir open <TAB> 补的是本地文件）
      lines.push('          elif (( CURRENT == 3 )) && [[ ${words[2]} == open ]]; then');
      lines.push(`            _values 'target' ${DIR_TARGETS.join(' ')}`);
      lines.push('          else');
      lines.push('            _files');
    } else {
      lines.push('          else');
      lines.push('            _files');
    }
    lines.push('          fi');
    lines.push('          ;;');
  }
  lines.push(
    '        logs)',
    "          _arguments '-f[实时跟随]' '-n[显示行数]:行数:' '-o[系统默认程序打开]' '1::编号:'",
    '          ;;',
    '        ui)',
    `          _values 'ui' ${UI_NAMES.join(' ')}`,
    '          ;;',
    '        kernel)',
    `          _arguments '--mirror[走镜像下载]:镜像:(${MIRROR_NAMES.join(' ')})'`,
    '          ;;',
    '        reset)',
    `          _values 'target' ${RESET_TARGET_NAMES.join(' ')}`,
    "          _arguments '-y[跳过确认]' '--yes[跳过确认]' '--full[删全部]'",
    '          ;;',
    '        completion)',
    '          if (( CURRENT == 2 )); then',
    `            _values 'action' install uninstall ${SHELLS.join(' ')}`,
    '          elif (( CURRENT == 3 )) && [[ ${words[2]} == (install|uninstall) ]]; then',
    `            _values 'shell' ${SHELLS.join(' ')}`,
    '          fi',
    '          ;;',
    '        *)',
    '          _files',
    '          ;;',
    '      esac',
    '      ;;',
    '  esac',
    '}',
    '',
    // 结尾必须是 compdef 注册，**不能是裸调用 `_mihomo "$@"`**。
    //
    // 两条安装路径对结尾行的要求不同，而裸调用只满足其中一条：
    // - 放进 fpath（`completion install zsh`）：compinit 按 `#compdef` 首行自动注册，
    //   函数体被 autoload，结尾写什么都行——两种写法实测都能注册全部四个别名
    // - `eval "$(mihomo completion zsh)"`（README 与下方 CLI 提示都推荐）：`#compdef`
    //   只是条注释、不起作用，而裸调用会在补全上下文之外执行 `_arguments`，实测报
    //   `_arguments:comparguments:327: can only be called from completion function`，
    //   且 `_comps[mihomo]` 前后都是 0 —— 补全完全没注册，eval 却返回 0。
    //   用户照文档做了、看到没报错（错误在 stderr 一闪而过）、补全就是不工作。
    //
    // compdef 同时满足两条：实测 eval 后四个别名 `_comps` 全部为 1，fpath 安装不受影响。
    'compdef _mihomo mihomo mhm mh mihomo-cli',
  );
  return lines.join('\n');
}

function buildBash(commands: Command[], groups: SubGroup[]): string {
  const top = commandWords(commands)
    .map(c => c.word)
    .join(' ');
  const subCase = groups
    .map(group => {
      const aliases = group.tokens.join('|');
      const words = group.words.map(w => w.word).join(' ');
      if (group.tokens[0] === 'directory') {
        // 子命令词表用 `words`（派生自 DIRECTORY_SUBCOMMANDS），不硬编码 "open"：
        // 此前这里写死了 open，而同函数的通用分支（下方）用的是派生词表——`dir` 新增
        // 子命令时通用分支自动跟上、这条不会，正是本模块头部注释声称不存在的第二份词表
        return `    ${aliases})
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${words}" -- "\${cur}") )
      elif [[ "\${COMP_WORDS[2]}" == "open" ]]; then
        COMPREPLY=( $(compgen -W "${DIR_TARGETS.join(' ')}" -- "\${cur}") )
      fi
      ;;`;
      }
      return `    ${aliases})
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "${words}" -- "\${cur}") )
      fi
      ;;`;
    })
    .join('\n');
  return `# mihomo-cli bash 补全（mihomo completion bash 生成；安装: mihomo completion install bash，或 eval "$(mihomo completion bash)"）

_mihomo_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${top}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
${subCase}
    logs)
      COMPREPLY=( $(compgen -W "-f -n -o --lines --follow --open" -- "\${cur}") )
      ;;
    ui)
      COMPREPLY=( $(compgen -W "${UI_NAMES.join(' ')}" -- "\${cur}") )
      ;;
    kernel)
      if [[ "\${prev}" == "--mirror" ]]; then
        COMPREPLY=( $(compgen -W "${MIRROR_NAMES.join(' ')}" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "--mirror" -- "\${cur}") )
      fi
      ;;
    reset)
      COMPREPLY=( $(compgen -W "${RESET_TARGET_NAMES.join(' ')} --full -y --yes" -- "\${cur}") )
      ;;
    completion)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "install uninstall ${SHELLS.join(' ')}" -- "\${cur}") )
      elif [[ \${COMP_CWORD} -eq 3 ]] && [[ "\${COMP_WORDS[2]}" == install || "\${COMP_WORDS[2]}" == uninstall ]]; then
        COMPREPLY=( $(compgen -W "${SHELLS.join(' ')}" -- "\${cur}") )
      fi
      ;;
  esac
}
complete -F _mihomo_completions mihomo mhm mh mihomo-cli
`;
}

/**
 * 转义要放进 fish **单引号**字符串的文本。
 *
 * fish 的单引号里只有两个转义序列：`\'` 与 `\\`。故**反斜杠必须先转义**，否则以
 * 反斜杠结尾的描述会生成 `-d 'desc\'`——末尾的 `\'` 被读作转义撇号，字符串不闭合，
 * 整份补全语法错误（实测生成形态确认）。先替换 `\` 再替换 `'`，顺序不能反：
 * 反过来会把刚插入的转义反斜杠再转义一次。
 *
 * 与 zshSingleQuote 是同族但规则不同的两个函数，刻意不合并：两个 shell 的引号
 * 语义本就不同（zsh 单引号内无任何转义序列，只能靠闭合-重开），合并成一个「通用
 * 转义」必然要在里面再分支，反而更容易写错。
 */
function fishSingleQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildFish(commands: Command[], groups: SubGroup[]): string {
  const lines: string[] = [
    '# mihomo-cli fish 补全（mihomo completion fish 生成；安装: mihomo completion install fish，或 mihomo completion fish | source）',
    '',
    'for cmd in mihomo mhm mh mihomo-cli',
  ];
  for (const c of commandWords(commands)) {
    lines.push(`    complete -c $cmd -f -a '${c.word}' -d '${fishSingleQuote(c.desc)}'`);
  }
  for (const group of groups) {
    const seen = group.tokens.join(' ');
    // directory 组的子命令行加 not-gating：`dir open <TAB>` 后不再重复提供 open，
    // 对齐 bash/zsh 的「第二位置参数为空才补子命令」语义
    const condition = group.tokens.includes('directory') ? `${seen}; and not __fish_seen_subcommand_from open` : seen;
    for (const s of group.words) {
      lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from ${condition}" -a '${s.word}' -d '${fishSingleQuote(s.desc)}'`);
    }
  }
  // 目录目标只在 open 已被敲下之后提供（bash 查 COMP_WORDS[2]、zsh 查 words[2]）；
  // 此前 seen 名单含 open，`dir <TAB>` 时 dir 已被 seen，目标与 open 一起挤进只有 open 合法的位置。
  // 触发 token 取自 groups（注册表派生），不硬编码四个别名——给 directory 加/改别名时
  // 子命令行会跟上而这行不会，两边就此分叉（实测注入一个新别名可复现）
  const directoryTokens = groups.find(g => g.tokens.includes('directory'))?.tokens.join(' ') ?? 'directory';
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from ${directoryTokens}; and __fish_seen_subcommand_from open" -a '${DIR_TARGETS.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from ui; and not __fish_seen_subcommand_from ${UI_NAMES.join(' ')}" -a '${UI_NAMES.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from completion" -a 'install uninstall ${SHELLS.join(' ')}' -d '安装/卸载补全'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from completion; and __fish_seen_subcommand_from install uninstall" -a '${SHELLS.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from kernel" -l mirror -d '走镜像下载' -a '${MIRROR_NAMES.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from reset" -a '${RESET_TARGET_NAMES.join(' ')}'`);
  // -y 与 --full 此前被绑成同一行（-s y -l full = --full 的短写是 y），--yes 完全缺失，
  // 与 reset 实际接受的选项不符；拆成两个独立选项
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from reset" -s y -l yes -d '跳过确认'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from reset" -l full -d '删全部'`);
  lines.push('end');
  return lines.join('\n');
}

/** 生成指定 shell 的补全脚本；未知 shell 抛 CliError（带 did-you-mean） */
export function buildCompletionScript(shell: string, commands: Command[]): string {
  const groups = subGroups(commands);
  switch (shell) {
    case 'zsh':
      return buildZsh(commands, groups);
    case 'bash':
      return buildBash(commands, groups);
    case 'fish':
      return buildFish(commands, groups);
    default: {
      const suggestion = suggestSimilar(shell, [...SHELLS]);
      throw new CliError(`未知的 shell: ${shell}`, {
        label: '参数错误',
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), `用法: mihomo completion <${SHELLS.join('|')}>`],
      });
    }
  }
}

/** bash 追加安装的幂等标记：~/.bash_completion 是共享文件，不能覆盖用户自己的内容 */
const BASH_MARKER = '# >>> mihomo-cli completion (append)';
/** 结束标记，与起始标记成对；uninstall 按这一对切出自己那段 */
const BASH_END_MARKER = BASH_MARKER.replace('>>>', '<<<');

/**
 * 文件里是否有**成对且顺序正确**的标记块。
 *
 * install 的幂等判据与 uninstall 的切割判据必须是同一条：只看起始标记的话，
 * 半截块（用户手工编辑删掉了后半段，或上次写入中途失败）会让两条命令互相甩锅——
 * install 说「已安装过，跳过」、uninstall 说「未找到标记，未做改动」，双双退出 0
 * 且都不碰文件，用户没有任何 CLI 路径能修好它（实测复现）。
 * 判成「无完整块」后 install 会照常追加一段完好的，uninstall 随后也能正常剥离。
 */
function hasBashMarkerBlock(content: string): boolean {
  const start = content.indexOf(BASH_MARKER);
  const end = content.indexOf(BASH_END_MARKER);
  return start !== -1 && end !== -1 && end > start;
}

/**
 * zsh/fish 产物的指纹：**本工具独有的完整行**，install 与 uninstall 共用同一判据。
 *
 * 不能取行业约定的公共前缀——zsh 任何 `_mihomo` 补全（用户手写或第三方分发）首行
 * 都必须是 `#compdef mihomo`，只比对前缀会把别人的文件认成自己的。fish 同理取完整
 * 的四别名循环行。与 buildCompletionScript 的产物逐字对齐。
 *
 * 收口成一处而非两边各写一份：install 的覆盖闸门与 uninstall 的删除闸门必须是同一
 * 条判据，否则会出现「uninstall 拒绝删的文件，install 照样覆盖」这种自相矛盾
 * （v4.12.0 前就是如此，见 installCompletion 的注释）。
 */
function productFingerprint(shell: string): string | null {
  if (shell === 'zsh') return '#compdef mihomo mhm mh mihomo-cli';
  if (shell === 'fish') return 'for cmd in mihomo mhm mh mihomo-cli';
  return null;
}

/** 各 shell 的补全落盘位置：独占文件名的 shell（zsh/fish）直接覆盖写，天然幂等 */
function completionInstallPath(shell: string): string | null {
  const home = os.homedir();
  switch (shell) {
    case 'zsh':
      return path.join(home, '.zsh', 'completions', '_mihomo');
    case 'bash':
      return path.join(home, '.bash_completion');
    case 'fish': {
      // fish 遵循 XDG_CONFIG_HOME：设了就落在 $XDG_CONFIG_HOME/fish，否则 ~/.config/fish
      const fishConfigDir = process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, 'fish') : path.join(home, '.config', 'fish');
      return path.join(fishConfigDir, 'completions', 'mihomo.fish');
    }
    default:
      return null;
  }
}

function installCompletion(shell: string | undefined, commands: Command[]): void {
  if (!shell) {
    throw new CliError('请指定 shell', { hint: [`用法: mihomo completion install <${SHELLS.join('|')}>`] });
  }
  const target = completionInstallPath(shell);
  if (!target) {
    // 复用 buildCompletionScript 的 did-you-mean 报错（它会因未知 shell 抛错）
    buildCompletionScript(shell, commands);
    return;
  }

  const script = buildCompletionScript(shell, commands);
  console.log(`安装 ${shell} 补全: ${target}`);

  try {
    if (shell === 'bash') {
      // ~/.bash_completion 可能已有用户自己的补全：含**完整**标记块则幂等跳过，否则追加。
      // 判据要求成对标记（hasBashMarkerBlock）：只看起始标记会让半截块变成死锁——
      // install 说「已装过」、uninstall 说「没找到标记」，两边都不动手
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      if (hasBashMarkerBlock(existing)) {
        console.log('已安装过（~/.bash_completion 已包含 mihomo 补全），跳过');
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `\n${BASH_MARKER}\n${script}${BASH_END_MARKER}\n`);
      console.log(colors.green('已追加到 ~/.bash_completion（重新打开终端生效）'));
      return;
    }

    // zsh: #compdef 必须是文件首行（compinit 的约定），标记无处放——故用整文件指纹把关。
    //
    // **覆盖前必须确认这个文件是我们自己的**，判据与 uninstall 完全相同
    // （productFingerprint）。此前这里是无条件 writeFileSync，理由写的是「独占文件名，
    // 直接覆盖天然幂等」——但「文件名归我们」正是 uninstall 明确拒绝做的假设：
    // 用户手写或第三方分发的 `~/.zsh/completions/_mihomo` 会被 install 静默销毁，
    // 而销毁之后 uninstall 反而删得干干净净（那时它确实已经是我们的产物了）。
    // 一边守得严、一边直接覆盖，守的那道就没有意义（实测可复现）。
    // 已是本工具产物时照常覆盖——那才是真正的幂等，也让升级后重装能更新脚本内容。
    const fingerprint = productFingerprint(shell);
    if (fingerprint && fs.existsSync(target)) {
      const existing = fs.readFileSync(target, 'utf8');
      if (!existing.includes(fingerprint)) {
        throw new CliError(`${target} 已存在且不像是 mihomo-cli 生成的补全，已跳过安装`, {
          label: '安装中止',
          hint: [
            '该文件可能是你自己或其他工具写的，覆盖会造成不可恢复的丢失。',
            '确认无用后先手动删除，再重新安装:',
            `  rm ${target}`,
            `  mihomo completion install ${shell}`,
            '',
            '或改为手动输出到别处:',
            `  mihomo completion ${shell} > <你选择的路径>`,
          ],
        });
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, script, { mode: 0o644 });
    console.log(colors.green('已写入（重新打开终端生效）'));
  } catch (e) {
    throw new CliError(`补全安装失败: ${(e as Error).message}`, {
      label: '安装失败',
      hint: ['请检查目标目录的写权限，或手动重定向补全脚本:', `  mihomo completion ${shell} >> ${target}`],
    });
  }

  if (shell === 'zsh') {
    // ~/.zsh/completions 不在 zsh 默认 fpath 里（oh-my-zsh 默认包含）：
    // 只提示、不自动改 .zshrc——动用户的 rc 文件比让用户复制一行风险大得多
    console.log(colors.gray('若补全不生效，在 ~/.zshrc 中加一行: fpath=(~/.zsh/completions $fpath)'));
  }
}

/**
 * 卸载补全：install 的逆操作。
 *
 * bash 与 zsh/fish 的策略不同，因为落盘方式本就不同：
 * - bash 写的是**共享文件** `~/.bash_completion`，只能剥掉自己那段标记块，用户自己的
 *   补全必须原样留下
 * - zsh/fish 独占文件名，可以整个删——但**必须先确认那是本工具生成的**。用户可能自己
 *   写过同名补全，误删别人的文件比留下一个孤儿文件糟得多
 *
 * 不改用户的 rc 文件（install 也没改过，只是提示 fpath）：那超出「卸载补全」的范围。
 */
function uninstallCompletion(shell: string | undefined, commands: Command[]): void {
  if (!shell) {
    throw new CliError('请指定 shell', { hint: [`用法: mihomo completion uninstall <${SHELLS.join('|')}>`] });
  }
  const target = completionInstallPath(shell);
  if (!target) {
    // 复用 buildCompletionScript 的 did-you-mean 报错（它会因未知 shell 抛错）
    buildCompletionScript(shell, commands);
    return;
  }

  if (!fs.existsSync(target)) {
    console.log(`未安装 ${shell} 补全（${target} 不存在）`);
    return;
  }

  console.log(`卸载 ${shell} 补全: ${target}`);

  try {
    if (shell === 'bash') {
      const existing = fs.readFileSync(target, 'utf8');
      const endMarker = BASH_END_MARKER;
      const start = existing.indexOf(BASH_MARKER);
      const end = existing.indexOf(endMarker);
      if (start === -1 || end === -1 || end < start) {
        console.log(colors.yellow('未找到 mihomo 补全标记，未做改动'));
        console.log(colors.gray(`  若曾手动安装，请自行编辑 ${target}`));
        return;
      }
      // 连同 install 追加的前导换行与末尾换行一并去掉，避免反复装卸堆积空行
      const before = existing.slice(0, start).replace(/\n+$/, '\n');
      const after = existing.slice(end + endMarker.length).replace(/^\n/, '');
      const rest = `${before}${after}`;
      // 只剩空白说明这个文件本就是我们建的，删掉比留个空文件干净
      if (rest.trim() === '') {
        fs.rmSync(target);
        console.log(colors.green('已移除（文件已空，一并删除；重新打开终端生效）'));
        return;
      }
      fs.writeFileSync(target, rest);
      console.log(colors.green('已移除 mihomo 补全段，保留文件中其余内容（重新打开终端生效）'));
      return;
    }

    // zsh/fish：独占文件名，但删之前必须确认是本工具生成的。
    // 判据收口在 productFingerprint，与 installCompletion 的覆盖闸门是同一条——
    // 两边各写一份迟早漂移，而漂移的形态就是「一边守、一边不守」
    const existing = fs.readFileSync(target, 'utf8');
    const fingerprint = productFingerprint(shell);
    if (!fingerprint || !existing.includes(fingerprint)) {
      throw new CliError(`${target} 不像是 mihomo-cli 生成的补全，已跳过删除`, {
        label: '卸载中止',
        hint: ['该文件可能是你自己或其他工具写的。确认无用后手动删除:', `  rm ${target}`],
      });
    }
    fs.rmSync(target);
    console.log(colors.green('已删除（重新打开终端生效）'));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`补全卸载失败: ${(e as Error).message}`, {
      label: '卸载失败',
      hint: ['请检查目标文件的权限，或手动删除:', `  rm ${target}`],
    });
  }
}

/** completion 命令入口。词表由 registry 传入（避免 import 成环）。 */
export function cmdCompletion(args: string[], commands: Command[]): void {
  assertKnownFlags(args.slice(1), [], 'completion');
  // 各形态的位置参数至多一个（install/uninstall 的 shell 在 args[2]，直接输出的 shell 在 args[1]），
  // `completion install zsh extra` 此前静默忽略 extra；校验先于任何文件写入
  if (args[1] === 'install') {
    assertPositionalCount(args, 1, 2, `mihomo completion install <${SHELLS.join('|')}>`);
    installCompletion(args[2], commands);
    return;
  }
  if (args[1] === 'uninstall') {
    assertPositionalCount(args, 1, 2, `mihomo completion uninstall <${SHELLS.join('|')}>`);
    uninstallCompletion(args[2], commands);
    return;
  }
  assertPositionalCount(args, 1, 1, `mihomo completion <${SHELLS.join('|')}>`);
  const shell = args[1];
  if (!shell) {
    throw new CliError('请指定 shell', {
      hint: [
        `用法: mihomo completion <${SHELLS.join('|')}>`,
        `安装到默认位置: mihomo completion install <${SHELLS.join('|')}>`,
        `卸载: mihomo completion uninstall <${SHELLS.join('|')}>`,
        '临时启用: eval "$(mihomo completion zsh)"',
      ],
    });
  }
  console.log(buildCompletionScript(shell, commands));
}
