import fs from 'node:fs';
import readline from 'node:readline';
import { clearKernelVersionCache, hasKernel } from '../config.js';
import { DIRS, ensureDirs, fsExistsSync, PATHS, rmrf, USER_DATA_DIR } from '../paths.js';
import * as processManager from '../process.js';
import { invalidateSettingsCache } from '../settings.js';
import type { ResetTarget } from '../types.js';
import { colors } from '../utils.js';

const RESET_TARGETS: ResetTarget[] = [
  {
    id: 'subs',
    aliases: ['sub', 'subs', 'subscription', 'subscriptions'],
    label: '订阅',
    paths: () => [DIRS.subscriptions],
    needsStop: true,
  },
  {
    id: 'logs',
    aliases: ['log', 'logs'],
    label: '日志',
    paths: () => [DIRS.logs],
    needsStop: false,
  },
  {
    id: 'data',
    aliases: ['data'],
    label: '运行数据',
    paths: () => [DIRS.data],
    needsStop: true,
  },
  {
    id: 'runtime',
    aliases: ['runtime'],
    label: '运行时',
    paths: () => [DIRS.runtime],
    needsStop: true,
  },
  {
    id: 'settings',
    aliases: ['setting', 'settings', 'config'],
    label: '设置',
    paths: () => [PATHS.settingsFile],
    needsStop: false,
  },
  {
    id: 'kernel',
    aliases: ['kernel', 'core'],
    label: '内核',
    paths: () => [DIRS.kernel],
    needsStop: false,
    onAfter: () => clearKernelVersionCache(),
    checkEmpty: () => !hasKernel(),
    emptyMsg: '内核未安装，无需删除',
    warnIfRunning: true,
  },
  {
    id: 'overwrites',
    aliases: ['overwrite', 'overwrites', 'ow'],
    label: '覆写',
    paths: () => {
      const dir = USER_DATA_DIR;
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter(f => f === 'overwrite.yaml' || /^overwrite\..+\.ya?ml$/.test(f))
        .map(f => `${dir}/${f}`);
    },
    needsStop: false,
  },
];

function resolveResetTargets(names: string[]): { matched: ResetTarget[]; unmatched: string[] } {
  const matched: ResetTarget[] = [];
  const unmatched: string[] = [];
  for (const name of names) {
    const t = RESET_TARGETS.find(t => t.aliases.includes(name.toLowerCase()));
    if (t) {
      if (!matched.find(m => m.id === t.id)) matched.push(t);
    } else {
      unmatched.push(name);
    }
  }
  return { matched, unmatched };
}

async function confirmPrompt(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question(`${question} (y/N) `, a => {
      rl.close();
      resolve(a);
    });
  });
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

export async function cmdReset(args: string[]): Promise<void> {
  const flags = (args || []).filter(a => a.startsWith('-'));
  const names = (args || []).slice(1).filter(a => !a.startsWith('-'));
  const fullReset = flags.includes('--full') || flags.includes('-f');
  const skipConfirm = flags.includes('--yes') || flags.includes('-y');

  let targets: ResetTarget[];

  if (fullReset) {
    targets = RESET_TARGETS;
  } else if (names.length > 0) {
    const { matched, unmatched } = resolveResetTargets(names);
    if (unmatched.length > 0) {
      console.error(`错误: 未知的重置目标: ${unmatched.join(', ')}`);
      console.log('');
      console.log(`可用目标: ${RESET_TARGETS.map(t => t.aliases[0]).join(', ')}`);
      console.log('');
      console.log('示例:');
      console.log('  mihomo reset sub log      # 删除订阅和日志');
      console.log('  mihomo reset kernel       # 只删内核');
      console.log('  mihomo reset --full       # 删除全部');
      console.log('  mihomo reset              # 删除全部（保留设置、内核、覆写）');
      process.exit(1);
    }
    targets = matched;
  } else {
    targets = RESET_TARGETS.filter(t => !['settings', 'kernel', 'overwrites'].includes(t.id));
  }

  for (const t of targets) {
    if (t.checkEmpty?.()) {
      if (targets.length === 1) {
        console.log(t.emptyMsg);
        return;
      }
    }
  }

  const needsStop = targets.some(t => t.needsStop);
  const warnRunning = targets.some(t => t.warnIfRunning);

  const pids = needsStop || warnRunning ? processManager.getAllMihomoPids() : [];

  if (needsStop && pids.length > 0) {
    console.log(`停止 ${pids.length} 个进程...`);
    processManager.cleanupAll();
    for (let i = 0; i < processManager.PROCESS_WAIT_ATTEMPTS; i++) {
      if (processManager.getAllMihomoPids().length === 0) break;
      await new Promise(r => setTimeout(r, processManager.PROCESS_WAIT_INTERVAL));
    }
  } else if (warnRunning && pids.length > 0) {
    console.log(colors.yellow(`警告: mihomo 正在运行 (PID ${pids.join(', ')})，删除内核后将无法重新启动`));
  }

  console.log(`将删除: ${targets.map(t => t.label).join('、')}`);

  if (!skipConfirm && !(await confirmPrompt('确认?'))) {
    console.log('已取消');
    return;
  }

  for (const t of targets) {
    for (const p of t.paths()) {
      if (fsExistsSync(p)) {
        try {
          rmrf(p);
        } catch (e) {
          console.warn(`  警告: 无法删除 ${p}: ${(e as Error).message}`);
        }
      }
    }
    t.onAfter?.();
  }

  ensureDirs();
  if (targets.some(t => t.id === 'settings')) {
    invalidateSettingsCache();
  }

  console.log(colors.green(`已重置: ${targets.map(t => t.label).join('、')}`));
}
