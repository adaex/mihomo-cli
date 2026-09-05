import fs from 'node:fs';

import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { CliError } from '../errors.js';
import { PATHS } from '../paths.js';
import { getMihomoPids } from '../process-probe.js';
import { cleanupLegacySystemInstall, detectLegacySystemInstall, getServiceStatus, installService, SERVICE_BINARY_NAME, uninstallService } from '../service.js';

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

  try {
    cleanupLegacySystemInstall();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, {
      label: '清理遗留服务失败',
      hint: ['也可手动清理:', `  sudo launchctl bootout system/$(basename ${PATHS.systemDaemonPlist} .plist)`, `  sudo rm -f ${PATHS.systemDaemonPlist}`],
    });
  }

  console.log(`${colors.green('已清理遗留的系统级服务')}`);
  console.log('');
}

export async function cmdInstall(_args: string[]): Promise<void> {
  if (!hasKernel()) {
    throw new CliError('未找到内核', { hint: '下载内核: mihomo kernel' });
  }

  await handleLegacyInstall();

  // 重装保持原运行状态：不这么做的话，「代理开着时更新内核后重装」会静默把代理关掉
  const wasRunning = getServiceStatus().running;

  installService(wasRunning);

  console.log(`${colors.green('已安装服务')}`);
  console.log(colors.gray(`  plist: ${PATHS.userAgentPlist}`));
  console.log(colors.gray(`  登录项与扩展中显示为: ${SERVICE_BINARY_NAME}`));
  console.log('');

  if (wasRunning) {
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

export async function cmdUninstall(_args: string[]): Promise<void> {
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
    uninstallService();
    console.log(colors.green('已卸载服务'));
  }

  if (legacy) {
    console.log(colors.gray('检测到旧版本的系统级服务，清理需要一次管理员密码'));
    cleanupLegacySystemInstall();
    console.log(colors.green('已清理遗留的系统级服务'));
  }

  const remaining = getMihomoPids();
  if (remaining.length > 0) {
    console.log('');
    console.log(colors.yellow(`仍有内核进程残留 (PID ${remaining.join(', ')})`));
    console.log('手动清理: sudo pkill -9 mihomo');
  }

  console.log(colors.gray('重新安装: mihomo install'));
  console.log('');
}
