import { assertPositionalCount } from '../argv.js';
import { colors } from '../colors.js';
import { AVAILABLE_MIRRORS } from '../constants.js';
import { CliError } from '../errors.js';
import { VALUE_FLAGS } from '../flags.js';
import type { DownloadChannel } from '../kernel.js';
import * as kernel from '../kernel.js';
import { parseMirrorArg, parseProxyArg } from '../kernel-args.js';
import { getRunningState } from '../runtime.js';
import { getPorts } from '../settings.js';
import { withSpinner } from '../spinner.js';

/**
 * kernel 的位置参数口径：`--mirror` 的值（如 `--mirror cdn` 的 cdn）不算位置参数。
 * `--mirror` 是可选值选项、故意不在 VALUE_FLAGS 里（见 flags.ts 注释），故这里单独补；
 * `--proxy` 是标准带值选项，已随登记表进 VALUE_FLAGS。
 */
const KERNEL_VALUE_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, '--mirror']);

/** 通道的人类可读标签（失败汇总用） */
function channelLabel(channel: DownloadChannel): string {
  switch (channel.kind) {
    case 'gh':
      return 'gh';
    case 'proxy':
      return `代理 ${channel.proxy}`;
    case 'mirror':
      return `镜像 ${channel.mirror}`;
    case 'direct':
      return '直连';
  }
}

/** 打印一行通道信息；isExplicitProxy 区分「代理」与「本机代理」措辞 */
function printChannelLine(channel: DownloadChannel, isExplicitProxy: boolean): void {
  if (channel.kind === 'gh') {
    console.log('下载通道: gh（GitHub CLI）');
  } else if (channel.kind === 'proxy') {
    console.log(`下载通道: ${isExplicitProxy ? '代理' : '本机代理'} ${channel.proxy}`);
  } else if (channel.kind === 'mirror') {
    const host = channel.mirror.replace(/^https?:\/\//, '').replace(/\/$/, '');
    console.log(`镜像: ${host}${channel.proxy ? `（经代理 ${channel.proxy}）` : ''}`);
  }
  console.log('');
}

export async function cmdKernel(args: string[]): Promise<void> {
  const mirrorInfo = parseMirrorArg(args);
  const proxyInfo = parseProxyArg(args);
  // 不接受位置参数：`kernel garbage` 此前被静默忽略；校验放在两个 flag 解析之后
  // （flag 侧的错误优先报出）、checkUpdate 之前（不碰网络）
  assertPositionalCount(args, 0, 1, 'mihomo-cli kernel [--mirror [镜像]] [--proxy <端口|地址>]', KERNEL_VALUE_FLAGS);

  // --mirror direct 的语义是「绕过一切代理直连」，与 --proxy 正交冲突，同时给出必是误解
  if (proxyInfo.proxy && mirrorInfo.isOverride && !mirrorInfo.mirror) {
    throw new CliError('--mirror direct 与 --proxy 不能同时使用', {
      label: '参数错误',
      hint: ['--mirror direct 强制不经代理直连，需走代理时去掉它:', '  mihomo-cli kernel --proxy <端口|地址>'],
    });
  }

  // 下载候选通道（按尝试顺序，首个成功即用）：显式 --mirror/--proxy 只有一个候选；
  // 默认本机代理在跑时 proxy 首选、gh 回退（回退只换客户端，节点通常不变，
  // 见 kernel.resolveDownloadChannels 的局限说明）。
  // 镜像选择不持久化，每次按当前环境独立决策；裸 --mirror 固定走裸域，
  // 不枚举网卡猜 IPv6（有 v6 地址不代表 v6 路由通），需要 v6 子域显式 --mirror v6。
  // 运行状态由命令层探测后注入——kernel.ts 不依赖 runtime/settings，通道决策保持纯函数可测
  const proxyRunning = getRunningState().running;
  // 端口只用于选通道，settings.ports 损坏（getPorts 抛错）时降级为「不探测本机代理」
  // 走 gh/直连——与 doctor/status 对同一调用的降级姿态一致，不该在做任何下载前就中止
  let proxyPort: number | null = null;
  if (proxyRunning) {
    try {
      proxyPort = getPorts().mixed;
    } catch {
      proxyPort = null;
    }
  }
  const forceDirect = mirrorInfo.isOverride && !mirrorInfo.mirror;
  const ghAvailable = kernel.hasGh();
  const channels = kernel.resolveDownloadChannels({
    mirror: mirrorInfo.mirror,
    isOverride: mirrorInfo.isOverride,
    ghAvailable,
    proxyRunning,
    proxyPort,
    proxyOverride: proxyInfo.proxy,
  });
  printChannelLine(channels[0], proxyInfo.proxy !== null);

  // 版本查询（GitHub API）的出网方式：代理可用（显式 --proxy 或本机在跑）时**直接经代理**
  // ——代理在跑说明出网路径已定，先试 gh 直连再回退会把「直连被墙」的等待白白叠加在
  // 可用的代理前面（spinner 也会说「经代理」而实际在等 gh）。gh 认证只在无代理可用时
  // 介入——那正是未认证直连撞 403 限流的场景（配额 5000 次/时 vs 60）。
  // --mirror direct 连 gh 一起绕过（「强制直连」含 API）。镜像仍绝不碰 API——
  // 内核二进制在 TUN 下以 root 运行，下载地址必须由 GitHub 官方 API 给出
  const apiProxy = proxyInfo.proxy ?? (proxyRunning && !forceDirect && proxyPort !== null ? `http://127.0.0.1:${proxyPort}` : null);
  const useGh = apiProxy === null && !forceDirect && ghAvailable;

  let info: Awaited<ReturnType<typeof kernel.checkUpdate>>;
  try {
    const spinnerText = apiProxy
      ? `检查内核更新（经代理 ${apiProxy}）`
      : useGh
        ? '检查内核更新（gh 认证通道）'
        : '检查内核更新（GitHub 直连，国内网络可能较慢）';
    info = await withSpinner(spinnerText, () => kernel.checkUpdate({ proxy: apiProxy, useGh }));
  } catch (e) {
    if (e instanceof CliError) throw e;
    const err = e as Error & { response?: { status?: number; data?: { message?: string; documentation_url?: string } } };
    const hint: string[] = [];
    if (err.response?.data?.message) {
      hint.push(`原因: ${err.response.data.message}`);
    }
    if (err.response?.data?.documentation_url) {
      hint.push(`文档: ${err.response.data.documentation_url}`);
    }
    // GitHub 对未认证 API 请求限流 60 次/时，403 + rate limit 文案在共享出口 IP 上是常态。
    // 镜像解决不了它（API 绝不经镜像），提示必须指向真正的出路：等重置或走 gh 认证
    if (err.response?.status === 403 && /rate limit/i.test(err.response.data?.message ?? '')) {
      hint.push(
        '',
        '提示: GitHub 对未认证 API 请求限流（约 60 次/时，共享出口 IP 常触发）；镜像只作用于下载，解决不了版本查询的限流',
        '等待限流重置（约 1 小时）后重试，或安装并登录 GitHub CLI 走认证查询（配额 5000 次/时）:',
        '  brew install gh && gh auth login',
      );
      if (useGh) {
        hint.push('', '本次已先尝试 gh 认证通道、失败后才回退直连，可检查 gh 登录状态: gh auth status');
      }
    } else if (!mirrorInfo.mirror) {
      if (apiProxy) {
        hint.push('', '提示: 经代理查询 GitHub 失败，可检查代理是否可用，或 mihomo-cli kernel --mirror direct 重试直连');
      } else {
        // 平时不打扰；仅直连失败时提示镜像/代理用法
        hint.push(
          '',
          '提示: 直连失败或下载过慢时可使用镜像或代理:',
          '  mihomo-cli kernel --mirror [镜像]   # 强制走镜像（裸 --mirror 固定裸域，可用 v6/v4/cdn 等别名）',
          `  可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`,
          '  mihomo-cli kernel --proxy <端口>    # 经本机其他代理工具出网',
        );
      }
    } else if (apiProxy) {
      // 显式镜像 + 版本查询经代理失败：镜像按设计绝不碰 API，失败与镜像无关，
      // 只提示检查代理本身
      hint.push('', '提示: 版本查询（GitHub API）经代理失败，可检查代理是否可用；镜像只作用于内核下载，与查询无关');
    } else if (useGh) {
      // useGh 意味着 gh 认证通道已先试过、失败才回退直连——两边都不通
      hint.push('', '提示: gh 认证通道与直连都失败了，可检查 gh 登录状态: gh auth status');
    } else {
      // 显式镜像、无代理可用：正是「直连 API 不通才需要镜像」的网络形态，
      // 而版本查询按设计直连 GitHub API、绝不经过镜像——不给指引就只剩裸「更新失败」
      hint.push(
        '',
        '提示: 镜像只作用于内核下载，版本查询仍需直连 GitHub API（当前不通）。出路:',
        '  安装并登录 GitHub CLI（认证配额 5000 次/时）:',
        '    brew install gh && gh auth login',
        '  或经本机代理工具查询: mihomo-cli kernel --proxy <端口>',
      );
    }
    throw new CliError(err.message, { label: '更新失败', hint });
  }
  // 首选 gh 认证查询、实际却回退直连成功：spinner 说的是「gh 认证通道」，
  // 不点明的话用户无法核对版本信息实际来自哪条路
  if (info.ghFallbackToDirect) {
    console.log(colors.gray('gh 查询不可用，已回退直连 GitHub API 获取版本信息'));
  }
  console.log(`当前: ${info.current}`);
  console.log(`最新: ${info.latest}`);

  if (!info.needsUpdate) {
    console.log('已是最新版本');
  } else {
    console.log('\n正在下载...');
    // 逐个尝试候选通道：失败时记录原因、继续下一通道；任一成功即使用
    let result: Awaited<ReturnType<typeof kernel.downloadKernel>> | undefined;
    const failures: string[] = [];
    for (let attempt = 0; attempt < channels.length; attempt++) {
      if (attempt > 0) {
        console.log('上一通道失败，切换为:');
        printChannelLine(channels[attempt], proxyInfo.proxy !== null);
      }
      try {
        result = await kernel.downloadKernel(msg => console.log(msg), channels[attempt], info.release);
      } catch (e) {
        failures.push(`  ${channelLabel(channels[attempt])}: ${(e as Error).message.split('\n')[0]}`);
        continue;
      }
      break;
    }
    if (!result) {
      throw new CliError('全部下载通道均失败', {
        label: '下载失败',
        hint: [
          ...failures,
          '',
          '若两条通道都是低速失败：问题在当前选中的机场节点（url-test 只按握手延迟选、不测带宽），',
          '在面板里手动给 Default Proxy 换个线路或节点后重试；也可换个时间等 url-test 重选',
          '',
          '通道选择：本机代理在跑时自动优先（含低速快速失败），回退 gh；',
          '手动指定: mihomo-cli kernel --mirror [镜像]（强制镜像）/ mihomo-cli kernel --mirror direct（强制直连）',
          '          mihomo-cli kernel --proxy <端口>（经本机其他代理工具出网）',
        ],
      });
    }
    console.log(`\n已更新到 ${result.version}`);
    // 运行中的内核仍是旧二进制（进程持有旧 inode），提醒重启生效。
    // TUN 在跑时裸 start 会静默切回 Mixed（还要一次 sudo），必须给 start tun——
    // 与 sub update 的重启提示同判据
    const state = getRunningState();
    if (state.running) {
      const restartCommand = state.kind === 'tun' ? 'mihomo-cli start tun' : 'mihomo-cli start';
      console.log(colors.yellow(`提示: 运行中的内核仍是旧版本，执行 ${restartCommand} 重启后生效`));
    }
    // ad-hoc 签名的 Go 二进制被替换后，macOS 可能按新可执行文件重新要求本地网络授权；
    // 只影响指向局域网地址的节点，提示一次胜过连不通时翻 README
    console.log(colors.gray('提示: 若使用局域网节点（192.168/10.x/*.local），首次启动可能重新弹出「本地网络」授权'));
  }
}
