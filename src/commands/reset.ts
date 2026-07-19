import fs from 'node:fs';
import readline from 'node:readline';
import { clearKernelVersionCache, hasKernel } from '../config.js';
import { disableDaemon, isDaemonEnabled } from '../daemon.js';
import { isOverwriteFilename } from '../overwrite.js';
import { DIRS, ensureDirs, PATHS, rmrf, USER_DATA_DIR } from '../paths.js';
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
        .filter(isOverwriteFilename)
        .map(f => `${dir}/${f}`);
    },
    needsStop: false,
  },
  {
    id: 'daemon',
    aliases: ['daemon'],
    label: '保活',
    // 卸载由确认后的 disablesDaemon 段统一处理（需 sudo，受取消保护）；
    // 此处 paths 返回空（plist 在系统目录，用户态删不掉，且不应提前删破坏卸载），
    // onAfter 因幂等守卫（plist 已删）成为 no-op，仅作单独 reset 未走前段时的兜底。
    paths: () => [],
    needsStop: false,
    onAfter: () => disableDaemon(),
    checkEmpty: () => !isDaemonEnabled(),
    emptyMsg: '保活未启用，无需删除',
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
    targets = RESET_TARGETS.filter(t => !['settings', 'kernel', 'overwrites', 'daemon'].includes(t.id));
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
  // 删内核会让保活 plist 指向已删二进制（KeepAlive 空转）；需停止进程的重置也要求保活先卸载；
  // 直接重置 daemon target 本身也要卸载。三种情况统一走确认后的 disableDaemon（受 sudo 取消保护），
  // 使 daemon target 的 onAfter 因幂等守卫成为 no-op，避免重复弹密码或未捕获抛错冒泡。
  const kernelTargeted = targets.some(t => t.id === 'kernel');
  const daemonTargeted = targets.some(t => t.id === 'daemon');
  const disablesDaemon = needsStop || kernelTargeted || daemonTargeted;

  const pids = needsStop || warnRunning ? processManager.getMihomoPids() : [];

  // 确认前只做只读警告，不做任何破坏性操作（停止进程/卸载保活）——用户取消时环境须原样保留
  if (warnRunning && pids.length > 0) {
    console.log(colors.yellow(`警告: mihomo 正在运行 (PID ${pids.join(', ')})，删除内核后将无法重新启动`));
  }
  if (disablesDaemon && isDaemonEnabled()) {
    console.log(colors.yellow('保活已启用，重置将一并关闭保活（移除开机自启）'));
  }

  console.log(`将删除: ${targets.map(t => t.label).join('、')}`);

  if (!skipConfirm && !(await confirmPrompt('确认?'))) {
    console.log('已取消');
    return;
  }

  // 确认后再执行破坏性操作。保活开启时必须先卸载（使 KeepAlive 失效），
  // 否则后续 cleanupAll 裸杀会被立即拉起。daemon target 的卸载由其 onAfter 兜底，
  // 但停止段早于删除循环，故这里对"需停止/删内核 + 保活开启"统一先卸载（含 --full）。
  // disableDaemon 现需 sudo：用户取消（密码错误/Ctrl-C）则中止重置，避免部分删除后环境不一致。
  if (disablesDaemon && isDaemonEnabled()) {
    try {
      disableDaemon();
    } catch (e) {
      console.error(`${colors.red('保活关闭已取消，重置中止:')} ${(e as Error).message.split('\n')[0]}`);
      return;
    }
  }

  if (needsStop && processManager.getMihomoPids().length > 0) {
    console.log('停止进程...');
    processManager.cleanupAll();
    for (let i = 0; i < processManager.PROCESS_WAIT_ATTEMPTS; i++) {
      if (processManager.getMihomoPids().length === 0) break;
      await new Promise(r => setTimeout(r, processManager.PROCESS_WAIT_INTERVAL));
    }
  }

  for (const t of targets) {
    for (const p of t.paths()) {
      if (fs.existsSync(p)) {
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
