import fs from 'node:fs';
import { assertKnownFlags } from '../argv.js';
import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { isOverwriteFilename, listTypoOverwriteFiles } from '../overwrite.js';
import { DIRS, ensureDirs, PATHS, rmrf, USER_DATA_DIR } from '../paths.js';
import { getMihomoPids } from '../process-probe.js';
import { cleanupAll, MANUAL_PKILL_HINT, printResidueWarning } from '../process-stop.js';
import {
  cleanupLegacyInstallOrThrow,
  detectLegacySystemInstall,
  getServiceStatus,
  recordServiceStopped,
  stopService,
  uninstallService,
  warnResidueCleanup,
} from '../service.js';
import { updateSettings } from '../settings.js';
import type { CleanupResult, ResetTarget, Settings } from '../types.js';
import { confirmOrThrow } from './shared.js';

/** 目标表只描述数据；服务操作与设置更新由 cmdReset 分阶段处理 */
const RESET_TARGETS: ResetTarget[] = [
  { id: 'subs', aliases: ['sub', 'subs', 'subscription', 'subscriptions'], label: '订阅', paths: () => [DIRS.subscriptions], needsStop: true },
  { id: 'logs', aliases: ['log', 'logs'], label: '日志', paths: () => [DIRS.logs], needsStop: true },
  { id: 'data', aliases: ['data'], label: '运行数据', paths: () => [DIRS.data], needsStop: true },
  { id: 'runtime', aliases: ['runtime'], label: '运行时', paths: () => [DIRS.runtime], needsStop: true },
  {
    id: 'overwrites',
    aliases: ['overwrite', 'overwrites', 'ow'],
    label: '覆写',
    needsStop: false,
    preserveOnBare: true,
    paths: () =>
      fs.existsSync(USER_DATA_DIR)
        ? fs
            .readdirSync(USER_DATA_DIR)
            .filter(isOverwriteFilename)
            .map(f => `${USER_DATA_DIR}/${f}`)
        : [],
  },
  {
    // 别名刻意不含 'config'：用户从 `mihomo-cli config` 命令得到的直觉是「运行配置」
    // （那属于 runtime 目标），而这里删的是 settings（订阅列表/端口/密钥）——
    // 静默对撞会让 reset config -y 删超预期的数据。未知目标报错 + 目标列表兜底
    id: 'settings',
    aliases: ['setting', 'settings'],
    label: '设置',
    needsStop: false,
    preserveOnBare: true,
    // 损坏备份也包含订阅凭据，需要一起删除
    paths: () => [PATHS.settingsFile, `${PATHS.settingsFile}.bak`],
  },
  { id: 'kernel', aliases: ['kernel', 'core'], label: '内核', paths: () => [DIRS.kernel], needsStop: true, preserveOnBare: true },
  { id: 'service', aliases: ['service'], label: '服务', paths: () => [], needsStop: false, preserveOnBare: true },
];

function resolveResetTargets(names: string[]): ResetTarget[] {
  const matched = new Set<ResetTarget>();
  for (const name of names) {
    const target = RESET_TARGETS.find(t => t.aliases.includes(name.toLowerCase()));
    if (!target) {
      throw new CliError(`未知的重置目标: ${name}`, { hint: [`可用目标: ${RESET_TARGETS.map(t => t.id).join(', ')}`] });
    }
    matched.add(target);
  }
  return [...matched];
}

export async function cmdReset(args: string[]): Promise<void> {
  assertKnownFlags(args, ['--full', '--yes', '-y'], 'reset [目标...] [--full] [-y]');
  const names = args.slice(1).filter(a => !a.startsWith('-'));
  // 目标与 --full 互斥：此前 `reset subs --full` 静默忽略 subs、扩成全量重置——
  // 用户给具体目标再补 --full，本意多半是「彻底删这个目标」，静默放大到删设置/
  // 内核/服务远超预期。矛盾输入显式报错，与全仓同姿态
  if (names.length > 0 && args.includes('--full')) {
    throw new CliError('不能同时指定重置目标与 --full', {
      hint: [`只删指定目标: mihomo-cli reset ${names.join(' ')}`, '重置全部: mihomo-cli reset --full'],
    });
  }
  const namedTargets = resolveResetTargets(names);
  const targets = args.includes('--full') ? RESET_TARGETS : names.length > 0 ? namedTargets : RESET_TARGETS.filter(t => !t.preserveOnBare);
  const ids = new Set(targets.map(t => t.id));
  const needsStop = targets.some(t => t.needsStop);
  const serviceTargeted = ids.has('service');
  const service = getServiceStatus();
  let serviceActive = service.installed || service.loaded;
  const legacy = detectLegacySystemInstall();

  if (targets.length === 1) {
    if (serviceTargeted && !serviceActive && !legacy) {
      console.log('服务未安装，无需删除');
      return;
    }
  }

  // 确认前只读取状态和展示计划，不停止进程或删除数据
  if (ids.has('kernel') && getMihomoPids().length > 0) {
    console.log(colors.yellow('将停止正在运行的内核，删除后需重新下载才能启动'));
  }
  if (serviceTargeted && serviceActive) {
    console.log(colors.yellow('将卸载 launchd 服务（Mixed 模式需重新 install 才能使用）'));
  } else if (needsStop && serviceActive) {
    console.log(colors.yellow('将停止服务并关闭登录自启（安装保留，mihomo-cli start 可重新启动）'));
  }
  if ((needsStop || serviceTargeted) && legacy) {
    console.log(colors.yellow('将清理遗留的系统级服务（root LaunchDaemon，需要一次管理员密码）'));
  }
  console.log(`将删除: ${targets.map(t => t.label).join('、')}`);
  // 「订阅」两个字传达不出删掉的是找不回的机场链接——裸 reset 的默认集就含它，
  // 必须把不可恢复性挑明（数据保护段 README 有流程说明，确认瞬间用户只看得到这行）
  if (ids.has('subs')) {
    console.log(colors.yellow('订阅链接与本地配置将被删除且无法恢复，需重新从机场获取订阅地址'));
  }
  if (
    !args.includes('-y') &&
    !args.includes('--yes') &&
    !(await confirmOrThrow('确认?', {
      nonTtyMessage: '非交互环境无法确认',
      hint: ['跳过确认请加 -y: mihomo-cli reset ... -y'],
    }))
  ) {
    console.log('已取消');
    return;
  }

  // 先停止/卸载托管服务，使 KeepAlive 失效，再清理游离内核
  if ((needsStop || serviceTargeted) && legacy) await cleanupLegacyInstallOrThrow();

  // 服务状态在 legacy 清理之后、停止/卸载判定之前重读：交互确认的等待与 legacy 清理的
  // sudo 密码窗（最长约 60s）期间，另一终端 install+start 都可能把服务装上。按确认前
  // 快照判定 serviceActive=false 会既不停也不卸载，直接删 config/kernel 目录——已
  // bootstrap 的服务不受下方 recordServiceStopped 的 epoch 防线保护（它只拦
  // 「enable/bootstrap 之前」的并发 start），KeepAlive 会对着已删文件落入崩溃循环。
  // 与 start.ts 的「快照 + 现值」双读同姿态（D2/D4 的并发防线精神）
  const current = getServiceStatus();
  serviceActive = current.installed || current.loaded;

  // 服务路径的 cleanupAll 已在 stopService/uninstallService 内跑过（warn/throw 也已在
  // 那一层统一渲染），结果直接透传——不再跑第二次：两次之间没有任何状态变化，第二遍只
  // 多一次 pgrep 与死亡等待，root 脚本失败时还可能再要一次密码，并把同一 warn 打印成
  // 两份互相矛盾的文案。无服务分支才需要在这里自己清理一次
  let cleanup: CleanupResult | null = null;
  if (serviceActive) {
    if (serviceTargeted) cleanup = await uninstallService();
    else if (needsStop) cleanup = await stopService();
  } else if (needsStop) {
    cleanup = await cleanupAll();
  }
  if (needsStop && cleanup !== null) {
    if (cleanup.remaining.length > 0) {
      throw new CliError(cleanup.remaining.join(', '), {
        label: '进程未能停止，重置中止',
        hint: [MANUAL_PKILL_HINT],
      });
    }
    // remaining 已空但有收尾错误（classifyResidueCleanup 的 warn 档）：服务分支已由
    // 服务层打印，无服务分支在此补同一出口的渲染——scriptError 优先于 pidError 的归因
    // 已在 buildRootResidueCleanupError 内，这里不再自组第二份文案
    if (!serviceActive && (cleanup.scriptError !== null || cleanup.pidError !== null)) {
      warnResidueCleanup(cleanup, { mainOutcome: '重置继续执行', retryCommand: 'mihomo-cli stop' });
    }
    // 与 cmdStop 的提前返回同族：serviceActive 为假时上面的 stopService/uninstallService
    // 一个都没跑，没有 disable 可执行，但这里即将删掉 runtime/config.yaml 或 kernel/——
    // 并发的慢速 start 若看不到变化，就会 bootstrap 一个内核已被删除的 plist，
    // 落进 KeepAlive 每约 10s 拉起一次的崩溃循环。
    //
    // 无条件记录（哪怕本来什么都没在跑）：reset runtime 在零进程下同样删掉 config.yaml。
    // 必须在上面的 remaining 抛错之后——失败的清理不该中止并发的 start。
    // serviceActive 为真时会与 stopService/uninstallService 锁内的递增重复，无害：
    // 判据只问值变没变
    recordServiceStopped();
  }

  // 纯 `reset service`（needsStop=false）此前把 uninstallService 透传的 remaining 整个
  // 丢弃：同一份残留态在 cmdStop 抛「部分进程未终止」、cmdUninstall 黄字列 PID，唯独
  // 这里无声通过——「已重置: 服务」成了谎报。卸载已完成，「重置中止」同样不成立，
  // 与 cmdUninstall 共用 printResidueWarning（classifyResidueCleanup 的 throw 档已在
  // 那层拦过，走到这里的只剩用户态残留）
  if (!needsStop && serviceTargeted && cleanup !== null && cleanup.remaining.length > 0) {
    printResidueWarning(cleanup.remaining);
  }

  const deleted = new Set<string>();
  for (const target of targets) {
    let hadContent = target.id === 'service' && (serviceActive || legacy);
    for (const filePath of target.paths()) {
      if (!fs.existsSync(filePath)) continue;
      try {
        rmrf(filePath);
      } catch (e) {
        throw new CliError(`无法删除 ${filePath}: ${(e as Error).message}`, { label: '重置失败' });
      }
      hadContent = true;
    }
    if (hadContent) deleted.add(target.id);
  }

  // 最后统一处理设置；删除整个设置时绝不再写回，与用户给出目标的顺序无关
  if (!ids.has('settings') && (ids.has('subs') || ids.has('overwrites'))) {
    updateSettings(settings => {
      const patch: Partial<Settings> = {};
      if (ids.has('subs') && (settings.subscriptions !== undefined || settings.active_subscription !== undefined)) {
        patch.subscriptions = undefined;
        patch.active_subscription = undefined;
        deleted.add('subs');
      }
      if (ids.has('overwrites') && settings.overwrite_enabled !== undefined) {
        patch.overwrite_enabled = undefined;
        deleted.add('overwrites');
      }
      return patch;
    });
  }
  ensureDirs();
  const labels = targets.filter(t => deleted.has(t.id)).map(t => t.label);
  console.log(labels.length > 0 ? colors.green(`已重置: ${labels.join('、')}`) : '没有需要重置的内容');

  // 近失文件（overwrite.yml / overwrite.ts / 大小写变体）不被 isOverwriteFilename 认、
  // 不在删除集里——reset 后它们残留且每次命令继续刷「不会被加载」警告。
  // 保守删除一贯有理（文件名近失不等于意图确定），但用户刚要求重置覆写，必须让他知道
  // 还有几个疑似文件没动、在哪
  if (ids.has('overwrites')) {
    const typos = listTypoOverwriteFiles();
    if (typos.length > 0) {
      console.log(colors.yellow(`另有 ${typos.length} 个疑似覆写文件未被识别、保留未删: ${typos.join('、')}`));
      console.log(colors.gray('  这些文件名不会被加载（合法：overwrite.yaml、overwrite.*.yaml/yml、overwrite.js 等）；确认无用可手动删除'));
    }
  }
}
