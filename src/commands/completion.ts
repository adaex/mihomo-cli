import { CliError } from '../errors.js';
import { suggestSimilar } from '../utils.js';

/**
 * Shell 补全脚本生成。词表为静态结构（与 registry.ts 的命令保持同步）：
 * 三个 shell 的脚本都从它生成，避免三份手写漂移。
 * 动态部分（订阅名等）不做——解析中文输出太脆，收益也低。
 */

const COMMAND_WORDS: { word: string; desc: string }[] = [
  { word: 'install', desc: '安装服务（Mixed 模式的前置，只需一次）' },
  { word: 'start', desc: '启动代理并开启登录自启' },
  { word: 'stop', desc: '停止代理并关闭登录自启' },
  { word: 'uninstall', desc: '卸载服务' },
  { word: 'status', desc: '查看状态（--json 机器可读）' },
  { word: 'logs', desc: '日志列表/查看' },
  { word: 'ui', desc: '打开 Web UI' },
  { word: 'subscription', desc: '订阅管理' },
  { word: 'overwrite', desc: '覆写配置' },
  { word: 'directory', desc: '数据目录' },
  { word: 'kernel', desc: '更新内核' },
  { word: 'update', desc: '更新 mihomo-cli' },
  { word: 'reset', desc: '重置用户数据' },
  { word: 'doctor', desc: '体检诊断' },
  { word: 'completion', desc: '输出 shell 补全脚本' },
  { word: 'use', desc: '切换订阅（subscription use 快捷方式）' },
  { word: 'tun', desc: '临时 TUN 透明代理（= start tun）' },
  { word: 'help', desc: '显示帮助' },
  { word: 'version', desc: '显示版本' },
];

const SUBCOMMANDS: Record<string, { word: string; desc: string }[]> = {
  subscription: [
    { word: 'use', desc: '切换订阅' },
    { word: 'add', desc: '添加订阅' },
    { word: 'update', desc: '更新订阅' },
    { word: 'remove', desc: '删除订阅' },
    { word: 'rm', desc: '删除订阅' },
    { word: 'delete', desc: '删除订阅' },
  ],
  overwrite: [
    { word: 'on', desc: '启用覆写' },
    { word: 'off', desc: '禁用覆写' },
    { word: 'enable', desc: '启用覆写' },
    { word: 'disable', desc: '禁用覆写' },
  ],
  directory: [{ word: 'open', desc: '打开目录' }],
};

const DIR_TARGETS = ['root', 'subs', 'logs', 'data', 'runtime', 'kernel'];
const UI_NAMES = ['zash', 'dash', 'yacd'];
const SHELLS = ['zsh', 'bash', 'fish'] as const;

function buildZsh(): string {
  const lines: string[] = [
    '#compdef mihomo mhm mh mihomo-cli',
    '',
    '# mihomo-cli zsh 补全（mihomo completion zsh 生成；安装: 写入 ~/.zsh/completions/_mihomo 或 eval "$(mihomo completion zsh)"）',
    '',
    '_mihomo() {',
    '  local -a commands subcmds',
    '  commands=(',
    ...COMMAND_WORDS.map(c => `    '${c.word}:${c.desc.replace(/'/g, "''")}'`),
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
  for (const [group, subs] of Object.entries(SUBCOMMANDS)) {
    const aliases =
      group === 'subscription' ? 'subscription|sub|subs|subscriptions' : group === 'overwrite' ? 'overwrite|ow' : 'directory|dir|dirs|directories';
    lines.push(`        ${aliases})`);
    lines.push('          subcmds=(');
    for (const s of subs) lines.push(`            '${s.word}:${s.desc.replace(/'/g, "''")}'`);
    lines.push('          )');
    lines.push('          if (( CURRENT == 2 )); then');
    lines.push("            _describe 'subcommand' subcmds");
    lines.push('          else');
    lines.push('            _files');
    lines.push('          fi');
    lines.push('          ;;');
  }
  lines.push(
    '        directory|dir|dirs|directories)',
    '          if (( CURRENT == 3 )); then',
    `            _values 'target' ${DIR_TARGETS.join(' ')}`,
    '          fi',
    '          ;;',
    '        logs)',
    "          _arguments '-f[实时跟随]' '-n[显示行数]:行数:' '-o[系统默认程序打开]' '1::编号:'",
    '          ;;',
    '        ui)',
    `          _values 'ui' ${UI_NAMES.join(' ')}`,
    '          ;;',
    '        kernel)',
    "          _arguments '--mirror[走镜像下载]:镜像:' '--no-mirror[直连下载]'",
    '          ;;',
    '        reset)',
    `          _values 'target' subs logs data runtime settings kernel overwrites service`,
    "          _arguments '-y[跳过确认]' '--full[删全部]'",
    '          ;;',
    '        completion)',
    `          _values 'shell' ${SHELLS.join(' ')}`,
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

function buildBash(): string {
  const top = COMMAND_WORDS.map(c => c.word).join(' ');
  return `# mihomo-cli bash 补全（mihomo completion bash 生成；安装: eval "$(mihomo completion bash)"）

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
    subscription|sub|subs|subscriptions)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "use add update remove rm delete" -- "\${cur}") )
      fi
      ;;
    overwrite|ow)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "on off enable disable" -- "\${cur}") )
      fi
      ;;
    directory|dir|dirs|directories)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "open" -- "\${cur}") )
      elif [[ "\${COMP_WORDS[2]}" == "open" ]]; then
        COMPREPLY=( $(compgen -W "${DIR_TARGETS.join(' ')}" -- "\${cur}") )
      fi
      ;;
    logs)
      COMPREPLY=( $(compgen -W "-f -n -o --help" -- "\${cur}") )
      ;;
    ui)
      COMPREPLY=( $(compgen -W "${UI_NAMES.join(' ')}" -- "\${cur}") )
      ;;
    kernel)
      COMPREPLY=( $(compgen -W "--mirror --no-mirror" -- "\${cur}") )
      ;;
    reset)
      COMPREPLY=( $(compgen -W "subs logs data runtime settings kernel overwrites service --full -y" -- "\${cur}") )
      ;;
    completion)
      COMPREPLY=( $(compgen -W "${SHELLS.join(' ')}" -- "\${cur}") )
      ;;
  esac
}
complete -F _mihomo_completions mihomo mhm mh mihomo-cli
`;
}

function buildFish(): string {
  const lines: string[] = [
    '# mihomo-cli fish 补全（mihomo completion fish 生成；安装: mihomo completion fish | source）',
    '',
    'for cmd in mihomo mhm mh mihomo-cli',
  ];
  for (const c of COMMAND_WORDS) {
    lines.push(`    complete -c $cmd -f -a '${c.word}' -d '${c.desc.replace(/'/g, "\\'")}'`);
  }
  const subAliases: Record<string, string> = {
    subscription: 'subscription sub subs subscriptions',
    overwrite: 'overwrite ow',
    directory: 'directory dir dirs directories',
  };
  for (const [group, subs] of Object.entries(SUBCOMMANDS)) {
    for (const s of subs) {
      lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from ${subAliases[group]}" -a '${s.word}' -d '${s.desc}'`);
    }
  }
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from directory dir dirs directories open" -a '${DIR_TARGETS.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from ui" -a '${UI_NAMES.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from completion" -a '${SHELLS.join(' ')}'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from kernel" -a '\\--mirror' -d '走镜像下载'`);
  lines.push(`    complete -c $cmd -n "__fish_seen_subcommand_from kernel" -a '\\--no-mirror' -d '直连下载'`);
  lines.push('end');
  return lines.join('\n');
}

/** 生成指定 shell 的补全脚本；未知 shell 抛 CliError（带 did-you-mean） */
export function buildCompletionScript(shell: string): string {
  switch (shell) {
    case 'zsh':
      return buildZsh();
    case 'bash':
      return buildBash();
    case 'fish':
      return buildFish();
    default: {
      const suggestion = suggestSimilar(shell, [...SHELLS]);
      throw new CliError(`未知的 shell: ${shell}`, {
        label: '参数错误',
        hint: [...(suggestion.length > 0 ? [`是否想输入: ${suggestion.join(' / ')}?`] : []), `用法: mihomo completion <${SHELLS.join('|')}>`],
      });
    }
  }
}

export function cmdCompletion(args: string[]): void {
  const shell = args[1];
  if (!shell) {
    throw new CliError('请指定 shell', {
      hint: [`用法: mihomo completion <${SHELLS.join('|')}>`, '安装: eval "$(mihomo completion zsh)"，或写入对应 shell 的补全目录'],
    });
  }
  console.log(buildCompletionScript(shell));
}
