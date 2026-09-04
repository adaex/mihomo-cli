import fs from 'node:fs';

import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { CliError } from '../errors.js';
import { PATHS } from '../paths.js';
import { getMihomoPids } from '../process-probe.js';
import {
  detectInstalledDomain,
  getDomainSpec,
  getServiceStatus,
  hasBothDomainsInstalled,
  installService,
  SERVICE_BINARY_NAME,
  uninstallService,
} from '../service.js';
import type { ServiceDomain } from '../types.js';
import { hasFlag } from '../utils.js';

/**
 * 服务的安装与卸载。启停在 start.ts / stop.ts。
 *
 * install 只负责「装」，不启动——与 ssh-socks-install 同语义。这样「装」和「跑」
 * 是两个可独立推理的状态，用户重启后服务是否回来只取决于 start/stop 置的 enable 位。
 */

export async function cmdInstall(args: string[]): Promise<void> {
  const useSystem = hasFlag(args, '--system');
  const targetDomain: ServiceDomain = useSystem ? 'system' : 'user';

  if (!hasKernel()) {
    throw new CliError('未找到内核', { hint: '下载内核: mihomo kernel' });
  }

  // 已装在另一个域：两个实例会抢同一组端口，且用户态操作动不了 root 那个。
  // 不自动替用户卸载——那是一次隐式的破坏性操作（系统级卸载还要密码）
  const existing = detectInstalledDomain();
  if (existing && existing !== targetDomain) {
    const from = getDomainSpec(existing);
    const to = getDomainSpec(targetDomain);
    throw new CliError(`服务已安装为${from.label}，无法直接改装为${to.label}`, {
      hint: ['两者会抢占同一组端口，需先卸载再安装：', '  mihomo uninstall', `  mihomo install${useSystem ? ' --system' : ''}`],
    });
  }

  // 重装保持原运行状态：不这么做的话，「代理开着时更新内核后重装」会静默把代理关掉
  const before = getServiceStatus();
  const wasRunning = before.running;

  const spec = getDomainSpec(targetDomain);
  if (spec.needsSudo) {
    console.log(colors.gray('系统级安装需要管理员权限（以 root 运行，局域网访问天然豁免）'));
  }

  installService(targetDomain, wasRunning);

  console.log(`${colors.green('已安装服务')} · ${spec.label}`);
  console.log(colors.gray(`  plist: ${spec.plistPath}`));
  console.log(colors.gray(`  登录项与扩展中显示为: ${SERVICE_BINARY_NAME}`));
  console.log('');

  if (wasRunning) {
    console.log(`${colors.green('已按原状态重新启动')}`);
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
  const residue = getMihomoPids();

  // 幂等判据必须是三者皆空，不能只看 plist：用户手动删掉 plist 后任务仍处 bootstrapped
  // 状态，KeepAlive 会继续把内核拉起——只看文件会直接返回、永不执行 bootout，
  // 用户陷入「永远停不掉且 CLI 无路可走」的死胡同
  if (!status.installed && !status.loaded && residue.length === 0) {
    console.log('服务未安装');
    return;
  }

  const domain = status.domain ?? 'user';
  const spec = getDomainSpec(domain);

  if (!status.installed && status.loaded) {
    console.log(colors.yellow('未找到 plist，但服务仍处装载状态（plist 可能被手动删除）'));
    console.log('将执行 launchctl bootout 卸载残留任务');
  }
  if (spec.needsSudo) {
    console.log(colors.gray('卸载系统级服务需要管理员权限'));
  }

  uninstallService(domain);

  console.log(`${colors.green('已卸载服务')} · ${spec.label}`);

  const remaining = getMihomoPids();
  if (remaining.length > 0) {
    console.log('');
    console.log(colors.yellow(`仍有内核进程残留 (PID ${remaining.join(', ')})`));
    console.log('手动清理: sudo pkill -9 mihomo');
  }

  if (hasBothDomainsInstalled()) {
    console.log('');
    console.log(colors.yellow('检测到另一个域仍有安装，再执行一次 mihomo uninstall 可清理'));
  }

  console.log(colors.gray('重新安装: mihomo install'));
  console.log('');
}
