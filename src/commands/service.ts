import fs from 'node:fs';
import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { CliError } from '../errors.js';
import { PATHS } from '../paths.js';
import { getMihomoPids } from '../process-probe.js';
import * as runtime from '../runtime.js';
import {
  cleanupLegacyInstallOrThrow,
  detectLegacySystemInstall,
  getServiceStatus,
  installService,
  readStopEpoch,
  SERVICE_BINARY_NAME,
  shouldAbortStartOnDisable,
  uninstallService,
} from '../service.js';
import { assertKnownFlags, assertPositionalCount } from '../utils.js';

/**
 * 服务的安装与卸载。启停在 start.ts / stop.ts。
 *
 * install 只负责「装」，不启动——与 ssh-socks-install 同语义。这样「装」和「跑」
 * 是两个可独立推理的状态，用户重启后服务是否回来只取决于 start/stop 置的 enable 位。
 */

/**
 * 遗留的系统级安装（v3.0–v4.0 的 `daemon on`）会与用户级服务抢端口，
 * 且带 KeepAlive 会持续拉起内核。安装前必须先清掉，否则两个实例互相打架。
 */
async function handleLegacyInstall(): Promise<void> {
  if (!detectLegacySystemInstall()) return;

  console.log(colors.yellow('检测到旧版本安装的系统级服务（root LaunchDaemon）'));
  console.log(colors.gray('  它会与新的用户级服务抢占同一组端口，需先清理'));
  console.log(colors.gray('  清理需要一次管理员密码（删除 root 拥有的文件）'));
  console.log('');

  cleanupLegacyInstallOrThrow();

  console.log(`${colors.green('已清理遗留的系统级服务')}`);
  console.log('');
}

/**
 * 「装好了，但没恢复运行，因为期间有人停了它」。两个消费点共用（installService 锁内判据、
 * 健康确认失败后复读），文案只此一份。
 *
 * 说「停止操作」而非「执行了 mihomo stop」：递增点不止 stop，tun 与 install 首装同样
 * 会关闭自启并递增，说成 stop 是在讲一件没发生的事。
 */
function printRestoreSkipped(): void {
  console.log(colors.yellow('未恢复运行：安装期间检测到停止操作'));
  console.log(colors.gray('  另一个终端关闭了服务自启，已按最后一条命令保持停止'));
  console.log(colors.gray('  启动: mihomo start'));
  console.log('');
}

export async function cmdInstall(args: string[]): Promise<void> {
  assertKnownFlags(args.slice(1), [], 'install');
  assertPositionalCount(args, 0, 1, 'mihomo install');
  if (!hasKernel()) {
    throw new CliError('未找到内核', { hint: '下载内核: mihomo kernel' });
  }

  // 停止计数的快照必须取在这里——**任何慢速阶段之前**，与 cmdStart 同一约定。
  // 下面的 handleLegacyInstall 可能卡在交互式 sudo 密码输入上（时长无上界），
  // installService 内部又有 bootout + 等待卸载（最多 5s）；取晚了，这些窗口里
  // 发生的 stop 就被算进基线，重装的恢复运行会把它覆盖掉
  const stopEpochBefore = readStopEpoch();

  await handleLegacyInstall();

  // 重装保持原运行状态：不这么做的话，「代理开着时更新内核后重装」会静默把代理关掉
  const wasRunning = getServiceStatus().running;

  const { restoreSkipped } = await installService(wasRunning, stopEpochBefore);

  console.log(`${colors.green('已安装服务')}`);
  console.log(colors.gray(`  plist: ${PATHS.userAgentPlist}`));
  console.log(colors.gray(`  登录项与扩展中显示为: ${SERVICE_BINARY_NAME}`));
  console.log('');

  if (restoreSkipped) {
    // 并发的 stop 在重装期间跑完。安装成功、恢复运行被取消，两件事都要说清楚——
    // 不能走下面的健康确认分支，那会把用户自己的 stop 报成「恢复运行失败」
    printRestoreSkipped();
    return;
  }

  if (wasRunning) {
    // bootstrap 返回 0 ≠ 内核活着（v4.2.0 实测的崩溃循环形态）：
    // 重装恢复运行与 start 走同一套健康确认，缺了它就是「已按原状态重新启动」的静默谎报
    try {
      await runtime.assertServiceHealthy('恢复运行失败');
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      // 与 launchOrRestart 同族：bootstrap 之后的健康观察窗（1.2–3s）完全在锁外，
      // 期间的并发 stop 会把任务 bootout，健康确认于是失败。此时报「恢复运行失败」
      // 是把用户自己的 stop 说成故障，必须复读计数区分——判据仍是那唯一一份
      if (shouldAbortStartOnDisable(stopEpochBefore, readStopEpoch())) {
        printRestoreSkipped();
        return;
      }
      throw new CliError(e.message, {
        label: e.label,
        hint: [...e.hint, '', '服务已安装成功，仅恢复运行失败；修正配置后可执行 mihomo start 重试。'],
      });
    }
    console.log(colors.green('已按原状态重新启动'));
  } else {
    console.log('启动: mihomo start');
    // 装完就提示没订阅，好过用户执行 start 才撞墙
    if (!fs.existsSync(PATHS.configFile)) {
      console.log(colors.gray('  尚无运行时配置，start 会先要求添加订阅'));
    }
  }
  console.log('');
}

export async function cmdUninstall(args: string[]): Promise<void> {
  assertKnownFlags(args.slice(1), [], 'uninstall');
  assertPositionalCount(args, 0, 1, 'mihomo uninstall');
  const status = getServiceStatus();
  const legacy = detectLegacySystemInstall();
  const residue = getMihomoPids();

  // 幂等判据必须涵盖全部残留形态，不能只看 plist：用户手动删掉 plist 后任务仍处
  // bootstrapped 状态，KeepAlive 会继续把内核拉起——只看文件会直接返回、永不执行
  // bootout，用户陷入「永远停不掉且 CLI 无路可走」的死胡同
  if (!status.installed && !status.loaded && !legacy && residue.length === 0) {
    console.log('服务未安装');
    return;
  }

  if (!status.installed && status.loaded) {
    console.log(colors.yellow('未找到 plist，但服务仍处装载状态（plist 可能被手动删除）'));
    console.log('将执行 launchctl bootout 卸载残留任务');
  }

  if (status.installed || status.loaded) {
    await uninstallService();
    console.log(colors.green('已卸载服务'));
  }

  if (legacy) {
    console.log(colors.gray('检测到旧版本的系统级服务，清理需要一次管理员密码'));
    cleanupLegacyInstallOrThrow();
    console.log(colors.green('已清理遗留的系统级服务'));
  }

  const remaining = getMihomoPids();
  if (remaining.length > 0) {
    console.log('');
    console.log(colors.yellow(`仍有内核进程残留 (PID ${remaining.join(', ')})`));
    console.log('手动清理: sudo pkill -9 mihomo');
  }

  console.log(colors.gray('重新安装: mihomo install'));
  // 卸服务 ≠ 清数据：订阅/内核/日志还在数据目录，npm 包也还在——想彻底移除的用户
  // 需要知道三条路径，否则最常见的结局是「以为卸载了，目录和包都留着」
  console.log(colors.gray('彻底移除 mihomo-cli:'));
  console.log(colors.gray('  mihomo reset --full      # 删除全部数据（订阅/内核/日志等）'));
  console.log(colors.gray('  npm uninstall -g mihomo-cli'));
  console.log('');
}
