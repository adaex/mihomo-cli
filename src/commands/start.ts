import { assertKnownFlags, assertPositionalCount, getNonFlagArg, hasFlag, parseIntArg } from '../argv.js';
import { colors } from '../colors.js';
import { hasKernel } from '../config.js';
import { DEFAULT_AUTO_UPDATE_TIMEOUT } from '../constants.js';
import { CliError } from '../errors.js';
import * as runtime from '../runtime.js';
import {
  captureStopEpochBaseline,
  cleanupLegacyInstallOrThrow,
  detectLegacySystemInstall,
  disableServiceAutoStart,
  getServiceStatus,
  recordServiceStopped,
} from '../service.js';
import { getPorts } from '../settings.js';
import * as subscription from '../subscription.js';
import { printSystemProxyHint } from '../system-proxy.js';
import type { PreparedConfig } from '../types.js';

import { printStatus } from './status.js';

/**
 * 从 argv 解析启动模式。取第一个非 flag token（而非固定 args[1]）：
 * `start -s tun` 里模式在 flag 之后，只看 args[1] 会把它当 flag 丢掉、
 * 静默按 Mixed 启动——正是拼错模式那条报错要防的情形。
 * 与 `sub remove -y foo` 的 getNonFlagArg 口径一致。
 */
export function resolveStartMode(args: string[]): 'tun' | 'mixed' {
  const modeArg = getNonFlagArg(args, 1);
  const modeToken = modeArg?.toLowerCase();
  if (modeToken !== undefined && modeToken !== 'tun' && modeToken !== 'mixed') {
    throw new CliError(`未知的启动模式: ${modeArg}`, { hint: '用法: mihomo-cli start [tun|mixed]（默认 mixed）' });
  }
  return modeToken === 'tun' ? 'tun' : 'mixed';
}

export async function cmdStart(args: string[]): Promise<void> {
  assertKnownFlags(args, ['-s', '--no-update', '-u', '--update-timeout'], 'start [tun|mixed]');
  // 位置参数至多一个（模式）：`start mixed garbage` 此前忽略 garbage 继续执行。
  // 放在 hasKernel 等状态检查之前——参数错误应在任何环境副作用之前报出
  assertPositionalCount(args, 1, 1, 'mihomo-cli start [tun|mixed] [-s] [-u ms]');
  const targetMode = resolveStartMode(args);
  // 选项值非法（-u 5s）必须在任何环境状态检查之前报出：参数错误先于副作用，
  // 也不该让用户先看到「未找到内核」再发现自己选项写错（ow on 已有同款提前校验）
  const skipUpdate = hasFlag(args, '-s', '--no-update');
  const updateTimeout = parseIntArg(args, '-u', '--update-timeout', DEFAULT_AUTO_UPDATE_TIMEOUT);
  // TUN 分支若在弹密码前关了服务自启，启动失败/取消时错误提示要带上自启位的最终状态
  let disabledAutoStartForTun = false;

  if (!hasKernel()) {
    throw new CliError('未找到内核', { hint: '下载内核: mihomo-cli kernel' });
  }

  // 并发判定的基线由 main() 在命令入口捕获（service.ts captureStopEpochBaseline），
  // 不在这里取：它必须早于订阅自动更新等慢速阶段、且不晚于本命令第一次状态观察，
  // main() 的入口位置天然满足。restartToApply（sub use / ow on|off 触发的重启）
  // 会带着原命令的基线重入这里——下载订阅期间发生的并发 stop 因此会被检出并取消
  // 重启，这正是防线的语义（结构不变量锁在 service-concurrency.spec 的
  //「并发基线是命令入口的进程状态」用例，基线挪进本函数即转红）。
  // 注意 TUN 分支的 disableServiceAutoStart() 会 bump，且 bump 之后 TUN 分支不消费
  // 基线（走 startTun()，两个分支互斥）。**若将来 TUN 分支之后还要走
  // launchOrRestart('mixed')，就会检出这个 bump 并自我取消。**
  const serviceBefore = getServiceStatus();

  if (targetMode === 'tun') {
    // 遗留 root daemon 与 TUN 抢同一组端口：KeepAlive 会反复拉起旧内核，
    // 不清理的话 TUN 内核与它互抢，两边都不稳（停止侧的 cmdStop 同样先清它）
    if (detectLegacySystemInstall()) {
      console.log(colors.yellow('检测到旧版本安装的系统级服务（root LaunchDaemon），启动 TUN 前需清理'));
      console.log(colors.gray('  清理需要一次管理员密码（删除 root 拥有的文件）'));
      await cleanupLegacyInstallOrThrow();
      console.log(colors.green('已清理遗留的系统级服务'));
      console.log('');
    }

    // 判据是 loaded 而非 installed：`mh stop` 之后服务虽仍装着但不会被拉起，
    // 此时起 TUN 是正常用法。只看 installed 会把它一并拦掉，与「stop 后可用 tun」矛盾。
    // 快照用入口时值（快）；启动前还有一次现值复核（runtime.assertTunStartNotRaced），
    // 兜住快照之后才被并发 bootstrap 的服务
    if (serviceBefore.loaded) {
      throw runtime.tunBlockedByRunningService();
    }

    // 服务未装载但自启位还开着时，必须先关掉自启再起 TUN。
    //
    // plist 指向的 config.yaml 与 TUN 写的是同一个文件，TUN 一跑它就变成 tun.enable=true。
    // 用户此时不 stop 直接关机，下次开机 launchd 会拿这份 TUN 配置、以普通用户身份启动内核
    // （LaunchAgent 非 root），而创建 utun 需要 root —— 内核崩溃后被 KeepAlive 每约 10 秒
    // 拉起一次，用户开机只看到「代理不通」，完全联想不到是上次用 TUN 留下的。
    //
    // 放在启动前而非启动后：中途失败/被 Ctrl+C 也不会留下「自启开着 + TUN 配置」的组合。
    if (serviceBefore.installed && !serviceBefore.disabled) {
      disableServiceAutoStart();
      disabledAutoStartForTun = true;
      console.log(colors.gray('已临时关闭服务自启（避免重启后服务拿 TUN 配置启动）'));
      console.log(colors.gray('TUN 用完后 mihomo-cli start 可恢复'));
      console.log('');
    } else {
      // disable 位已在（上次 stop/tun 留下，起 TUN 的最常见前置）或服务根本未装——
      // 服务此刻「不会自启且未装载」，这是 recordServiceStopped 不变式的第 2 类证据
      // （读到的状态本身）。bump 是给并发 `start`（mixed）的防线：本命令接下来有
      // 订阅更新（约 10s）与 sudo 密码窗口（最长 60s）两个慢速阶段，期间另一终端
      // start 的话，其锁内会读到计数变化而放弃 enable+bootstrap；没有这道 bump，
      // start 起的服务会被 TUN 脚本的 pkill 杀掉、KeepAlive 拉回后与 root TUN 内核
      // 抢同一组端口。mixed 侧防「stop 被 start 覆盖」的防线（D2）管不到这个反方向
      recordServiceStopped();
    }

    // 两条分支都会递增停止计数（disableServiceAutoStart 在确认 disable 位生效后 bump、
    // recordServiceStopped 同理）。基线在命令入口捕获（D4），不处理的话，下面慢速阶段
    // 之后的启动前复核（runtime.assertTunStartNotRaced）会把自己这次的递增误判成并发
    // 停止。重捕获把「本命令造成的世界状态」设为新基线——他人的 bump（并发
    // stop/install/reset）才触发取消，自己的不算（终态与用户最后一条命令一致）
    captureStopEpochBaseline();
  } else if (!serviceBefore.installed) {
    // Mixed 恒由 launchd 服务托管，没有用户态直启路径。
    // 「plist 已删但任务仍装载」的孤儿态单独指引——此时叫用户 install 只会撞上
    // 「已装载」的旧任务，得先 uninstall 清干净
    if (serviceBefore.loaded) {
      throw new CliError('服务处于异常状态（plist 不存在，但任务仍装载）', {
        hint: ['先清理残留任务，再重新安装:', '  mihomo-cli uninstall', '  mihomo-cli install'],
      });
    }
    throw new CliError('服务未安装', {
      hint: ['Mixed 模式由 launchd 服务托管，需先安装:', '  mihomo-cli install', '', '临时使用可走 TUN: mihomo-cli tun'],
    });
  }

  const sub = subscription.requireActiveSubscription();

  if (!skipUpdate) {
    await subscription.autoUpdateStaleSubscription({ timeout: updateTimeout });
  }

  // 先构建校验、后落盘启动：坏覆写/不合法订阅在这里就抛错，此时运行中的内核还没被动过，
  // 用户维持在可用状态。反过来（先动手后构建）失败就是「已停机 + 无 config.yaml」的半死态。
  let prepared: PreparedConfig;
  try {
    prepared = await subscription.prepareConfigForStart(targetMode, sub.name);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, { label: '配置错误' });
  }

  const configInfo = subscription.commitPreparedConfig(prepared);

  const modeLabel = targetMode === 'tun' ? 'TUN' : 'Mixed';
  console.log([colors.cyan(modeLabel), sub.name, subscription.formatProxySummary(configInfo)].join(' · '));

  try {
    const pid = await runtime.launchOrRestart(targetMode);
    console.log(`${colors.green('已启动')}${pid ? ` (PID ${pid})` : ''}`);
  } catch (e) {
    const lines = (e as Error).message.split('\n');
    const extraHint: string[] = [];
    // sudo 取消/内核没起来时，自启位已经关掉了——只报启动失败会让用户以为一切照旧，
    // 下次开机才发现代理没回来
    if (targetMode === 'tun' && disabledAutoStartForTun) {
      extraHint.push('', '服务自启已被关闭（启动 TUN 前关闭以避免自启失败循环）。', '恢复 Mixed 模式: mihomo-cli start');
    }
    if (e instanceof CliError) {
      throw new CliError(e.message, { label: e.label, hint: [...e.hint, ...extraHint] });
    }
    throw new CliError(lines[0], { label: '启动失败', hint: [...lines.slice(1), ...extraHint] });
  }

  // 状态展示是启动成功后的附加信息：查询撞上瞬时失败（launchctl 超时/抖动）降级为
  // 警告，不让「已启动」以退出码 1 收场——脚本消费方会把假失败当真实失败处理
  try {
    await printStatus();
  } catch (e) {
    console.log(colors.yellow(`状态展示失败（不影响已完成的启动）: ${(e as Error).message.split('\n')[0]}`));
  }

  // Mixed 模式需手动配置系统代理：进程活着 ≠ 流量走代理，这是 Mixed 最大的日常摩擦。
  // TUN 模式由虚拟网卡接管全局流量，无需此步。start 是低频命令（重启/首次），提示不烦。
  // 提示按实际系统代理状态分档（已指向/指向别处/检测不可用），见 system-proxy.ts；
  // 端口取实际配置（settings.ports 可覆盖默认 7890）——提示错了端口用户会直接连不上
  if (targetMode === 'mixed') {
    printSystemProxyHint(getPorts().mixed);
  } else {
    // TUN 是 root 临时进程：关终端、退出 shell 都不会停它，「怎么收掉」必须随成功一起告知
    console.log(colors.gray('TUN 为临时进程，关闭终端不会停止；停止: mihomo-cli stop（之后 mihomo-cli start 恢复 Mixed）'));
  }
  console.log('');
}
