import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { getMihomoPids } from '../process-probe.js';
import { stop } from '../process-stop.js';
import { getDomainSpec, getServiceStatus, stopService } from '../service.js';
import type { StopResult } from '../types.js';
import { assertNoRemovedSshFlag } from '../utils.js';

/** 检查停止结果：若有进程未终止则报错并退出。 */
export function handleStopResult(result: StopResult): void {
  if (result.remaining && result.remaining.length > 0) {
    throw new CliError(result.remaining.join(', '), { label: '部分进程未终止', hint: '请手动运行: sudo pkill -9 mihomo' });
  }
}

/**
 * 停止代理：服务 bootout + disable（禁止自启），并收掉 TUN 等残留内核。
 *
 * `disable` 不能省，这是「停止」与「暂时杀掉」的区别：只 bootout 的话 enable 位还在，
 * 下次登录 launchd 扫到 plist 又会拉起——而 CLI 已经打印了「已停止」。
 */
export async function cmdStop(args: string[]): Promise<void> {
  assertNoRemovedSshFlag(args);

  const status = getServiceStatus();
  const pids = getMihomoPids();

  // 三者皆空才是真的无事可做。判据必须含 !disabled 的反面——服务未装载但 enable 位还在时，
  // 登录后仍会自启，此时「已停止」是谎报，必须补上 disable
  const needsServiceWork = status.loaded || (status.installed && !status.disabled);
  if (!needsServiceWork && pids.length === 0) {
    console.log(colors.yellow('不在运行'));
    return;
  }

  if (!needsServiceWork) {
    // 只有游离内核（TUN 或手动实例），没有服务要动：走原有清理路径，
    // 有 root 属主进程时它内部会提权，纯用户态进程则全程免密
    console.log(`停止 ${pids.length} 个进程...`);
    handleStopResult(await stop());
    console.log(colors.green('已停止'));
    return;
  }

  const domain = status.domain ?? 'user';
  const spec = getDomainSpec(domain);
  if (spec.needsSudo) {
    console.log(colors.gray('停止系统级服务需要管理员权限'));
  }

  stopService(domain);

  const remaining = getMihomoPids();
  if (remaining.length > 0) {
    throw new CliError(remaining.join(', '), {
      label: '部分进程未终止',
      hint: ['请手动运行: sudo pkill -9 mihomo'],
    });
  }

  console.log(`${colors.green('已停止')}${colors.gray('（已关闭开机自启，mihomo start 可重新启动）')}`);
}
