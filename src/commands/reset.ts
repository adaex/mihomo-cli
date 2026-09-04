import fs from 'node:fs';
import { colors } from '../colors.js';
import { clearKernelVersionCache, hasKernel } from '../config.js';
import { disableDaemon, isDaemonEnabled } from '../daemon.js';
import { CliError } from '../errors.js';
import { isOverwriteFilename } from '../overwrite.js';
import { DIRS, ensureDirs, PATHS, rmrf, USER_DATA_DIR } from '../paths.js';
import { getMihomoPids } from '../process-probe.js';
import { cleanupAll, PROCESS_WAIT_ATTEMPTS, PROCESS_WAIT_INTERVAL } from '../process-stop.js';
import { invalidateSettingsCache, writeSettings } from '../settings.js';
import type { ResetTarget } from '../types.js';
import { confirmOrThrow } from './shared.js';

/**
 * 重置目标注册表。**顺序即执行顺序**（`resolveResetTargets` 会按本数组排序），
 * 带 `onAfter: writeSettings` 的目标必须排在 `settings` 之前，否则会把刚删掉的
 * settings.json 重建成 `{}`——`subs` 受此约束，有单测锁定。
 */
export const RESET_TARGETS: ResetTarget[] = [
  {
    id: 'subs',
    aliases: ['sub', 'subs', 'subscription', 'subscriptions'],
    label: '订阅',
    paths: () => [DIRS.subscriptions],
    needsStop: true,
    // 同步清空 settings 里的订阅列表：只删缓存文件会留下"列表存在但无配置"的半重置状态
    // （start 会报"未找到订阅配置"）。active_subscription 一并清除
    onAfter: () => writeSettings({ subscriptions: undefined, active_subscription: undefined }),
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
    // 同时删 .bak：readSettings 遇格式损坏会备份原文件（settings.ts），里面含
    // controller_secret 与订阅 URL 的 token。只删主文件会让 "已重置: 设置" 名不副实，
    // 凭据仍明文留在数据目录（cache.json.bak 在 subscriptions/ 内，随整目录删除，无需单列）
    paths: () => [PATHS.settingsFile, `${PATHS.settingsFile}.bak`],
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
  // 按注册表顺序执行，与用户输入顺序无关：subs 的 onAfter 会 writeSettings 重建 settings.json，
  // 若 settings 排在 subs 之前被删，文件会被重建成 {}，"已重置: 设置" 与实际不符
  matched.sort((a, b) => RESET_TARGETS.indexOf(a) - RESET_TARGETS.indexOf(b));
  return { matched, unmatched };
}

export async function cmdReset(args: string[]): Promise<void> {
  const flags = (args || []).filter(a => a.startsWith('-'));
  const names = (args || []).slice(1).filter(a => !a.startsWith('-'));

  // 已知标志白名单：未知标志一律报错退出（避免 --ful 拼错被静默忽略后走默认删除）。
  // 注意：-f 不再是 --full 的别名——删全部只能显式 --full，免确认统一用 -y/--yes，
  // 防止与常见 -f=force 直觉混淆导致误删设置/内核/覆写。
  const KNOWN_FLAGS = new Set(['--full', '--yes', '-y']);
  const unknownFlags = flags.filter(f => !KNOWN_FLAGS.has(f));
  if (unknownFlags.length > 0) {
    throw new CliError(`未知的选项: ${unknownFlags.join(', ')}`, { hint: ['', '可用选项: --full（删全部）, -y/--yes（跳过确认）'] });
  }

  const fullReset = flags.includes('--full');
  const skipConfirm = flags.includes('--yes') || flags.includes('-y');

  let targets: ResetTarget[];

  if (fullReset) {
    targets = RESET_TARGETS;
  } else if (names.length > 0) {
    const { matched, unmatched } = resolveResetTargets(names);
    if (unmatched.length > 0) {
      throw new CliError(`未知的重置目标: ${unmatched.join(', ')}`, {
        hint: [
          '',
          `可用目标: ${RESET_TARGETS.map(t => t.aliases[0]).join(', ')}`,
          '',
          '示例:',
          '  mihomo reset sub log      # 删除订阅和日志',
          '  mihomo reset kernel       # 只删内核',
          '  mihomo reset --full       # 删除全部',
          '  mihomo reset              # 删除全部（保留设置、内核、覆写）',
        ],
      });
    }
    targets = matched;
  } else {
    // 留空 = 只删「可再生成的运行数据」，保留用户配置资产（设置/内核/覆写/保活）
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

  const pids = needsStop || warnRunning ? getMihomoPids() : [];

  // 确认前只做只读警告，不做任何破坏性操作（停止进程/卸载保活）——用户取消时环境须原样保留
  if (warnRunning && pids.length > 0) {
    console.log(colors.yellow(`警告: mihomo 正在运行 (PID ${pids.join(', ')})，删除内核后将无法重新启动`));
  }
  if (disablesDaemon && isDaemonEnabled()) {
    console.log(colors.yellow('保活已启用，重置将一并关闭保活（移除开机自启）'));
  }

  console.log(`将删除: ${targets.map(t => t.label).join('、')}`);

  if (!skipConfirm) {
    // 非交互环境无法应答：报错退出而非静默「已取消」，避免脚本误判重置已完成
    if (
      !(await confirmOrThrow('确认?', {
        nonTtyMessage: '非交互环境无法确认',
        hint: ['跳过确认请加 -y: mihomo reset ... -y'],
      }))
    ) {
      console.log('已取消');
      return;
    }
  }

  // 确认后再执行破坏性操作。保活开启时必须先卸载（使 KeepAlive 失效），
  // 否则后续 cleanupAll 裸杀会被立即拉起。daemon target 的卸载由其 onAfter 兜底，
  // 但停止段早于删除循环，故这里对"需停止/删内核 + 保活开启"统一先卸载（含 --full）。
  // disableDaemon 现需 sudo：用户取消（密码错误/Ctrl-C）则中止重置，避免部分删除后环境不一致。
  if (disablesDaemon && isDaemonEnabled()) {
    try {
      disableDaemon();
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError((e as Error).message.split('\n')[0], { label: '保活关闭已取消，重置中止' });
    }
  }

  if (needsStop && getMihomoPids().length > 0) {
    console.log('停止进程...');
    const cleanup = await cleanupAll();
    for (let i = 0; i < PROCESS_WAIT_ATTEMPTS; i++) {
      if (getMihomoPids().length === 0) break;
      await new Promise(r => setTimeout(r, PROCESS_WAIT_INTERVAL));
    }
    // 必须确认真的停了才继续删数据：cleanupAll 遇 root 实例（TUN）走 sudo pkill，
    // 用户取消密码或 kill 失败时它只把 pid 记进 failed 并返回，此前被整个丢弃 →
    // 残留的 root 代理进程会继续跑在已删除的配置上，且用户毫不知情
    const remaining = getMihomoPids();
    if (remaining.length > 0) {
      throw new CliError(remaining.join(', '), {
        label: '进程未能停止，重置中止',
        hint: [
          `未终止的进程: ${remaining.join(', ')}${cleanup.failed > 0 ? `（${cleanup.failed} 个终止失败）` : ''}`,
          '请手动运行: sudo pkill -9 mihomo',
          '否则残留进程会继续使用即将删除的配置。',
        ],
      });
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
