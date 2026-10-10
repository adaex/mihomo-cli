import { assertKnownFlags, assertPositionalCount } from '../argv.js';
import { colors } from '../colors.js';
import { CliError } from '../errors.js';
import { getMihomoPids } from '../process-probe.js';
import { MANUAL_PKILL_HINT, stop } from '../process-stop.js';
// getMihomoPids 用于停止前的无事可做判定；服务路径的停止后复核消费 stopService 返回的
// cleanup 结果，不再重发 pgrep
import { getServiceStatus, recordServiceStopped, stopService } from '../service.js';
import type { StopResult } from '../types.js';

/**
 * 检查停止结果：若有进程未终止则报错并退出。只消费 remaining——服务路径只有
 * pid 复核结果（无 StopResult 全字段），与 stop() 的结果共用同一出口，改一处文案
 * 两边同步
 */
function handleStopResult(result: StopResult): void {
  if (result.remaining && result.remaining.length > 0) {
    throw new CliError(result.remaining.join(', '), { label: '部分进程未终止', hint: MANUAL_PKILL_HINT });
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
  assertPositionalCount(args, 0, 1, 'mihomo-cli stop');

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

  // 这条路径由 stopService → disableServiceAutoStart 递增，别在这里再记一次。
  // remaining 取自 cleanupAll 死亡等待后的同一份复核，不再重新 pgrep（warn/throw
  // 已由服务层按 cleanupKernelsOrThrow 统一渲染，这里只管用户态残留的硬失败）
  const cleanup = await stopService();

  handleStopResult(cleanup);

  console.log(`${colors.green('已停止')}${colors.gray('（已关闭登录自启，mihomo-cli start 可重新启动）')}`);
}
