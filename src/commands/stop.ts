import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { getMihomoPids } from '../process-probe.js';
import { stop } from '../process-stop.js';
import { cleanupLegacyInstallOrThrow, detectLegacySystemInstall, getServiceStatus, recordServiceStopped, stopService } from '../service.js';
import type { StopResult } from '../types.js';
import { assertKnownFlags, assertPositionalCount } from '../utils.js';

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
  assertKnownFlags(args.slice(1), [], 'stop');
  // 不接受位置参数（`stop tun` 之类的写法此前被静默忽略）；校验先于任何服务操作
  assertPositionalCount(args, 0, 1, 'mihomo stop');
  // 遗留 root daemon 带 KeepAlive：不清理它，下面杀掉的内核约 10s 后就被拉回，
  // 「已停止」即成谎报（与 v4.2.2 修的 gui/0 缺陷同一签名，幽灵换成 legacy daemon）。
  // detectLegacySystemInstall 只查 plist 文件，不要求任务在跑，幂等清理无副作用
  if (detectLegacySystemInstall()) {
    console.log(colors.yellow('检测到旧版本安装的系统级服务（root LaunchDaemon），停止前需清理'));
    console.log(colors.gray('  清理需要一次管理员密码（删除 root 拥有的文件）'));
    cleanupLegacyInstallOrThrow();
    console.log(colors.green('已清理遗留的系统级服务'));
    console.log('');
  }

  const status = getServiceStatus();
  const pids = getMihomoPids();

  // 三者皆空才是真的无事可做。判据必须含 !disabled 的反面——服务未装载但 enable 位还在时，
  // 登录后仍会自启，此时「已停止」是谎报，必须补上 disable
  const needsServiceWork = status.loaded || (status.installed && !status.disabled);
  if (!needsServiceWork && pids.length === 0) {
    // 这条路径什么都没做，但**结论是确定的**（刚读到：未装载、未安装或已 disabled、无内核
    // 进程），而并发的慢速 start 正等着这个信号——不记的话它随后 enable + bootstrap，
    // 终态与用户最后一条命令相反，且两个终端都成功退出。见 recordServiceStopped
    recordServiceStopped();
    console.log(colors.yellow('不在运行'));
    return;
  }

  if (!needsServiceWork) {
    // 只有游离内核（TUN 或手动实例），没有服务要动：走原有清理路径，
    // 有 root 属主进程时它内部会提权，纯用户态进程则全程免密
    console.log(`停止 ${pids.length} 个进程...`);
    handleStopResult(await stop());
    // 必须在 handleStopResult **之后**：它在有进程杀不掉时抛错，抢在前面记录就会让一次
    // 失败的停止白白中止并发的 start。另注 stop() 会 rmrf(runtime/) 连带删掉 config.yaml，
    // 并发的 start 更需要这个信号
    recordServiceStopped();
    console.log(colors.green('已停止'));
    return;
  }

  // 这条路径由 stopService → disableServiceAutoStart 递增，别在这里再记一次
  await stopService();

  const remaining = getMihomoPids();
  if (remaining.length > 0) {
    throw new CliError(remaining.join(', '), {
      label: '部分进程未终止',
      hint: ['请手动运行: sudo pkill -9 mihomo'],
    });
  }

  console.log(`${colors.green('已停止')}${colors.gray('（已关闭登录自启，mihomo start 可重新启动）')}`);
}
