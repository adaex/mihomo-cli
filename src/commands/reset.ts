import fs from 'node:fs';
import { colors } from '../colors.js';
import { clearKernelVersionCache, hasKernel } from '../config.js';
import { CliError } from '../errors.js';
import { isOverwriteFilename } from '../overwrite.js';
import { DIRS, ensureDirs, PATHS, rmrf, USER_DATA_DIR } from '../paths.js';
import { getMihomoPids } from '../process-probe.js';
import { cleanupAll, PROCESS_WAIT_ATTEMPTS, PROCESS_WAIT_INTERVAL } from '../process-stop.js';
import { detectInstalledDomain, getServiceStatus, stopService, uninstallService } from '../service.js';
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
    id: 'service',
    aliases: ['service', 'daemon'],
    label: '服务',
    // 卸载由确认后的 uninstallsService 段统一处理（系统级需 sudo，受取消保护）；
    // 此处 paths 返回空（plist 不在数据目录里，且不应提前删破坏卸载），
    // onAfter 因幂等守卫成为 no-op，仅作单独 reset 未走前段时的兜底。
    paths: () => [],
    needsStop: false,
    onAfter: () => {
      const domain = detectInstalledDomain();
      if (domain) uninstallService(domain);
    },
    checkEmpty: () => !detectInstalledDomain() && !getServiceStatus().loaded,
    emptyMsg: '服务未安装，无需删除',
  },
];

/**
 * 裸 `mihomo reset`（无参无 flag）保留的目标：用户的配置资产，不删。
 * **必须是具名常量**：此前是内联字符串数组，target id 改名时漏改会让裸 reset
 * 静默把用户的服务安装/设置一并删掉，且不报错。reset.spec.ts 对着它断言。
 */
export const RESET_PRESERVED_ON_BARE = ['settings', 'kernel', 'overwrites', 'service'] as const;

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
    // 留空 = 只删「可再生成的运行数据」，保留用户配置资产（设置/内核/覆写/服务）
    targets = RESET_TARGETS.filter(t => !RESET_PRESERVED_ON_BARE.includes(t.id as (typeof RESET_PRESERVED_ON_BARE)[number]));
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
  // 「停止」与「卸载」必须分开——此前二者混为一谈（一律 disableDaemon）。
  //   needsStop（subs/data/runtime）→ 只 **stop**：删了 config.yaml 而服务还 enabled 的话，
  //     下次登录 launchd 会用不存在的 -f 拉起内核，KeepAlive 每几秒崩溃重启一次刷爆日志。
  //     stop 恒置 disable 位，正好堵住这个组合。但不该顺手把用户的安装卸掉。
  //   kernel → 同样只 stop + 警告（plist 会指向已删的二进制）
  //   service target / --full → 才是真正的 uninstall
  const kernelTargeted = targets.some(t => t.id === 'kernel');
  const serviceTargeted = targets.some(t => t.id === 'service');
  const uninstallsService = serviceTargeted;
  const stopsService = needsStop || kernelTargeted;

  const serviceStatus = getServiceStatus();
  const serviceActive = serviceStatus.installed || serviceStatus.loaded;

  const pids = needsStop || warnRunning ? getMihomoPids() : [];

  // 确认前只做只读警告，不做任何破坏性操作（停止进程/卸载服务）——用户取消时环境须原样保留
  if (warnRunning && pids.length > 0) {
    console.log(colors.yellow(`警告: mihomo 正在运行 (PID ${pids.join(', ')})，删除内核后将无法重新启动`));
  }
  if (uninstallsService && serviceActive) {
    console.log(colors.yellow('将卸载 launchd 服务（移除开机自启，Mixed 模式需重新 install 才能使用）'));
  } else if (stopsService && serviceActive) {
    console.log(colors.yellow('将停止服务并关闭开机自启（安装保留，mihomo start 可重新启动）'));
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

  // 确认后再执行破坏性操作。服务在跑时必须先停（使 KeepAlive 失效），
  // 否则后续 cleanupAll 裸杀会被立即拉起。系统级服务需 sudo：用户取消（密码错误/Ctrl-C）
  // 则中止重置，避免部分删除后环境不一致。
  if ((uninstallsService || stopsService) && serviceActive) {
    try {
      const domain = serviceStatus.domain ?? 'user';
      if (uninstallsService) {
        uninstallService(domain);
      } else {
        stopService(domain);
      }
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError((e as Error).message.split('\n')[0], { label: '服务操作已取消，重置中止' });
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
