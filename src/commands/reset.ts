import fs from 'node:fs';
import { colors } from '../colors.js';
import { clearKernelVersionCache } from '../config.js';
import { CliError } from '../errors.js';
import { isOverwriteFilename } from '../overwrite.js';
import { DIRS, ensureDirs, PATHS, rmrf, USER_DATA_DIR } from '../paths.js';
import { getMihomoPids } from '../process-probe.js';
import { cleanupAll } from '../process-stop.js';
import { cleanupLegacyInstallOrThrow, detectLegacySystemInstall, getServiceStatus, recordServiceStopped, stopService, uninstallService } from '../service.js';
import { updateSettings } from '../settings.js';
import type { ResetTarget, Settings } from '../types.js';
import { assertKnownFlags } from '../utils.js';
import { confirmOrThrow } from './shared.js';

/** 目标表只描述数据；服务操作与设置更新由 cmdReset 分阶段处理 */
export const RESET_TARGETS: ResetTarget[] = [
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
    id: 'settings',
    aliases: ['setting', 'settings', 'config'],
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
  const namedTargets = resolveResetTargets(names);
  const targets = args.includes('--full') ? RESET_TARGETS : names.length > 0 ? namedTargets : RESET_TARGETS.filter(t => !t.preserveOnBare);
  const ids = new Set(targets.map(t => t.id));
  const needsStop = targets.some(t => t.needsStop);
  const serviceTargeted = ids.has('service');
  const service = getServiceStatus();
  const serviceActive = service.installed || service.loaded;
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
    console.log(colors.yellow('将停止服务并关闭登录自启（安装保留，mihomo start 可重新启动）'));
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
      hint: ['跳过确认请加 -y: mihomo reset ... -y'],
    }))
  ) {
    console.log('已取消');
    return;
  }

  // 先停止/卸载托管服务，使 KeepAlive 失效，再清理游离内核
  if ((needsStop || serviceTargeted) && legacy) cleanupLegacyInstallOrThrow();
  if (serviceActive) {
    if (serviceTargeted) await uninstallService();
    else if (needsStop) await stopService();
  }
  if (needsStop) {
    const cleanup = await cleanupAll();
    if (cleanup.remaining.length > 0) {
      throw new CliError(cleanup.remaining.join(', '), {
        label: '进程未能停止，重置中止',
        hint: ['请手动运行: sudo pkill -9 mihomo'],
      });
    }
    // 与 cmdStop 的提前返回同族：serviceActive 为假时上面的 stopService/uninstallService
    // 一个都没跑，没有 disable 可执行，但这里即将删掉 runtime/config.yaml 或 kernel/——
    // 并发的慢速 start 若看不到变化，就会 bootstrap 一个内核已被删除的 plist，
    // 落进 KeepAlive 每约 10s 拉起一次的崩溃循环。
    //
    // 无条件记录（哪怕本来什么都没在跑）：reset runtime 在零进程下同样删掉 config.yaml。
    // 必须在上面的 remaining 抛错之后——失败的清理不该中止并发的 start。
    // serviceActive 为真时会与 stopService/uninstallService 重复递增，无害：
    // 判据只问值变没变（uninstallService 本来就 bump 两次）
    recordServiceStopped();
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
  if (ids.has('kernel')) clearKernelVersionCache();
  ensureDirs();
  const labels = targets.filter(t => deleted.has(t.id)).map(t => t.label);
  console.log(labels.length > 0 ? colors.green(`已重置: ${labels.join('、')}`) : '没有需要重置的内容');
}
