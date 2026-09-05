import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { suggestSimilar } from '../utils.js';
import { SUBCOMMANDS as DIRECTORY_SUBCOMMANDS } from './directory.js';
import { SUBCOMMANDS as OVERWRITE_SUBCOMMANDS } from './overwrite.js';
import type { Command } from './registry.js';
import type { SubCommand } from './shared.js';
import { SUBCOMMANDS as SUBSCRIPTION_SUBCOMMANDS } from './subscription.js';

/**
 * Shell 补全脚本生成。词表**从命令注册表派生**（cmdCompletion 传入 COMMANDS），
 * 子命令词表从各命令模块导出的 SUBCOMMANDS 派生（含别名展开）——
 * 不再手写第二份词表，新增命令/子命令自动出现在补全里。
 * 三个 shell 的脚本结构各自手写，词表同源。
 *
 * completion.ts 不 import registry 的运行时（registry import 本模块的 cmdCompletion，
 * 反向 import 会成环）；Command 仅作类型导入。
 */

interface CompletionWord {
  word: string;
  desc: string;
}

/** 命令词表：注册表中所有非 hidden 命令（含别名），desc 取首条用法行说明 */
function commandWords(commands: Command[]): CompletionWord[] {
  return commands
    .filter(c => !c.hidden)
    .flatMap(c => [{ word: c.name, desc: c.usage[0]?.description ?? '' }, ...c.aliases.map(a => ({ word: a, desc: c.usage[0]?.description ?? '' }))]);
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

const DIR_TARGETS = ['root', 'subs', 'logs', 'data', 'runtime', 'kernel'];
const UI_NAMES = ['zash', 'dash', 'yacd'];
const SHELLS = ['zsh', 'bash', 'fish'] as const;

function buildZsh(commands: Command[], groups: SubGroup[]): string {
  const lines: string[] = [
    '#compdef mihomo mhm mh mihomo-cli',
    '',
    '# mihomo-cli zsh 补全（mihomo completion zsh 生成；安装: mihomo completion install zsh，或 eval "$(mihomo completion zsh)"）',
    '',
    '_mihomo() {',
    '  local -a commands subcmds',
    '  commands=(',
    ...commandWords(commands).map(c => `    '${c.word}:${c.desc.replace(/'/g, "''")}'`),
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
    for (const s of group.words) lines.push(`            '${s.word}:${s.desc.replace(/'/g, "''")}'`);
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
    "          _arguments '--mirror[走镜像下载]:镜像:(cdn v4 v6 axisnow)'",
    '          ;;',
    '        reset)',
    `          _values 'target' subs logs data runtime settings kernel overwrites service`,
    "          _arguments '-y[跳过确认]' '--full[删全部]'",
    '          ;;',
    '        completion)',
    '          if (( CURRENT == 2 )); then',
    `            _values 'action' install ${SHELLS.join(' ')}`,
    '          elif (( CURRENT == 3 )) && [[ ${words[2]} == install ]]; then',
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
    '_mihomo "$@"',
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
        return `    ${aliases})
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "open" -- "\${cur}") )
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
      COMPREPLY=( $(compgen -W "--mirror" -- "\${cur}") )
      ;;
    reset)
      COMPREPLY=( $(compgen -W "subs logs data runtime settings kernel overwrites service --full -y" -- "\${cur}") )
      ;;
    completion)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "install ${SHELLS.join(' ')}" -- "\${cur}") )
      elif [[ \${COMP_CWORD} -eq 3 ]] && [[ "\${COMP_WORDS[2]}" == install ]]; then
        COMPREPLY=( $(compgen -W "${SHELLS.join(' ')}" -- "\${cur}") )
      fi
      ;;
  esac
}
complete -F _mihomo_completions mihomo mhm mh mihomo-cli
`;
}

function buildFish(commands: Command[], groups: SubGroup[]): string {
  const lines: string[] = [
    '# mihomo-cli fish 补全（mihomo completion fish 生成；安装: mihomo completion install fish，或 mihomo completion fish | source）',
    '',
    'for cmd in mihomo mhm mh mihomo-cli',
  ];
  for (const c of commandWords(commands)) {
    lines.push(`    complete -c $cmd -f -a '${c.word}' -d '${c.desc.replace(/'/g, "\\'")}'`);
  }
  for (const group of groups) {
    const seen = group.tokens.join(' ');
    for (const s of group.words) {
      lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from ${seen}" -a '${s.word}' -d '${s.desc.replace(/'/g, "\\'")}'`);
    }
  }
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from directory dir dirs directories open" -a '${DIR_TARGETS.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from ui" -a '${UI_NAMES.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from completion" -a 'install ${SHELLS.join(' ')}' -d '安装补全到默认位置'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from completion; and __fish_seen_subcommand_from install" -a '${SHELLS.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from kernel" -a '\\--mirror' -d '走镜像下载'`);
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

/** 各 shell 的补全落盘位置：独占文件名的 shell（zsh/fish）直接覆盖写，天然幂等 */
function completionInstallPath(shell: string): string | null {
  const home = os.homedir();
  switch (shell) {
    case 'zsh':
      return path.join(home, '.zsh', 'completions', '_mihomo');
    case 'bash':
      return path.join(home, '.bash_completion');
    case 'fish':
      return path.join(home, '.config', 'fish', 'completions', 'mihomo.fish');
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
      // ~/.bash_completion 可能已有用户自己的补全：含标记则幂等跳过，否则追加
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      if (existing.includes(BASH_MARKER)) {
        console.log('已安装过（~/.bash_completion 已包含 mihomo 补全），跳过');
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `\n${BASH_MARKER}\n${script}${BASH_MARKER.replace('>>>', '<<<')}\n`);
      console.log(colors.green('已追加到 ~/.bash_completion（重新打开终端生效）'));
      return;
    }

    // zsh: #compdef 必须是文件首行（compinit 的约定），标记无处放——独占文件名直接覆盖
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

/** completion 命令入口。词表由 registry 传入（避免 import 成环）。 */
export function cmdCompletion(args: string[], commands: Command[]): void {
  if (args[1] === 'install') {
    installCompletion(args[2], commands);
    return;
  }
  const shell = args[1];
  if (!shell) {
    throw new CliError('请指定 shell', {
      hint: [
        `用法: mihomo completion <${SHELLS.join('|')}>`,
        `安装到默认位置: mihomo completion install <${SHELLS.join('|')}>`,
        '临时启用: eval "$(mihomo completion zsh)"',
      ],
    });
  }
  console.log(buildCompletionScript(shell, commands));
}
