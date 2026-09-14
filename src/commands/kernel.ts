import { colors } from '../colors.js';
import { AVAILABLE_MIRRORS } from '../constants.js';
import { CliError } from '../errors.js';
import { VALUE_FLAGS } from '../flags.js';
import * as kernel from '../kernel.js';
import { getRunningState } from '../runtime.js';
import { getPorts } from '../settings.js';
import { withSpinner } from '../spinner.js';
import { assertPositionalCount, parseMirrorArg } from '../utils.js';

/**
 * kernel 的位置参数口径：`--mirror` 的值（如 `--mirror cdn` 的 cdn）不算位置参数。
 * `--mirror` 是可选值选项、故意不在 VALUE_FLAGS 里（见 flags.ts 注释），
 * 故这里单独补一张含 `--mirror` 的表，否则合法的 `kernel --mirror cdn` 会被误判。
 */
const KERNEL_VALUE_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, '--mirror']);

export async function cmdKernel(args: string[]): Promise<void> {
  const mirrorInfo = parseMirrorArg(args);
  // 不接受位置参数：`kernel garbage` 此前被静默忽略；校验放在 parseMirrorArg 之后
  // （flag 侧的错误优先报出）、checkUpdate 之前（不碰网络）
  assertPositionalCount(args, 0, 1, 'mihomo kernel [--mirror [镜像]]', KERNEL_VALUE_FLAGS);
  const effectiveMirror = mirrorInfo.mirror;

  // 下载通道：显式 --mirror / --mirror direct 手动覆盖最高优先，默认 gh > 本机代理 > 直连。
  // 镜像选择不持久化——每次按当前环境独立决策（gh/代理是否可用）；裸 --mirror 固定走
  // 裸域，不再枚举网卡猜 IPv6（有 v6 地址不代表 v6 路由通），需要 v6 子域显式 --mirror v6。
  // 运行状态由命令层探测后注入——kernel.ts 不依赖 runtime/settings，通道决策保持纯函数可测
  const proxyRunning = getRunningState().running;
  const proxyPort = proxyRunning ? getPorts().mixed : null;
  const forceDirect = mirrorInfo.isOverride && !mirrorInfo.mirror;
  const channel = kernel.resolveDownloadChannel({
    mirror: mirrorInfo.mirror,
    isOverride: mirrorInfo.isOverride,
    ghAvailable: kernel.hasGh(),
    proxyRunning,
    proxyPort,
  });

  if (channel.kind === 'gh') {
    console.log('下载通道: gh（GitHub CLI 直连）');
    console.log('');
  } else if (channel.kind === 'proxy') {
    console.log(`下载通道: 本机代理 127.0.0.1:${channel.port}`);
    console.log('');
  } else if (channel.kind === 'mirror') {
    const host = channel.mirror.replace(/^https?:\/\//, '').replace(/\/$/, '');
    console.log(`镜像: ${host}`);
    console.log('');
  }

  let info: Awaited<ReturnType<typeof kernel.checkUpdate>>;
  try {
    // 版本查询（GitHub API）在代理开着时也经本机代理：本地代理只是传输层，TLS 端到端，
    // 镜像仍绝不碰 API。--mirror direct 强制直连（含 API），绕过代理
    const useProxyForApi = proxyRunning && !forceDirect;
    const spinnerText = useProxyForApi ? '检查内核更新（经本机代理访问 GitHub）' : '检查内核更新（GitHub 直连，国内网络可能较慢）';
    info = await withSpinner(spinnerText, () => kernel.checkUpdate(useProxyForApi ? proxyPort : null));
  } catch (e) {
    if (e instanceof CliError) throw e;
    const err = e as Error & { response?: { data?: { message?: string; documentation_url?: string } } };
    const hint: string[] = [];
    if (err.response?.data?.message) {
      hint.push(`原因: ${err.response.data.message}`);
    }
    if (err.response?.data?.documentation_url) {
      hint.push(`文档: ${err.response.data.documentation_url}`);
    }
    if (!effectiveMirror) {
      if (proxyRunning && !forceDirect) {
        hint.push('', '提示: 经本机代理查询 GitHub 失败，可检查代理状态（mihomo status），或 mihomo kernel --mirror direct 重试直连');
      } else {
        // 平时不打扰；仅直连失败时提示镜像用法
        hint.push(
          '',
          '提示: 直连失败或下载过慢时可使用镜像:',
          '  mihomo kernel --mirror [镜像]   # 强制走镜像（裸 --mirror 固定裸域，可用 v6/v4/cdn 等别名）',
          `  可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`,
        );
      }
    }
    throw new CliError(err.message, { label: '更新失败', hint });
  }
  console.log(`当前: ${info.current}`);
  console.log(`最新: ${info.latest}`);

  if (!info.needsUpdate) {
    console.log('已是最新版本');
  } else {
    console.log('\n正在下载...');
    let result: Awaited<ReturnType<typeof kernel.downloadKernel>>;
    try {
      result = await kernel.downloadKernel(msg => console.log(msg), channel, info.release);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError((e as Error).message, {
        label: '下载失败',
        hint: [
          '',
          '下载通道按优先级自动选择: gh（GitHub CLI）> 本机代理 > 直连',
          '手动指定: mihomo kernel --mirror [镜像]（强制镜像）/ mihomo kernel --mirror direct（强制直连）',
        ],
      });
    }
    console.log(`\n已更新到 ${result.version}`);
    // 运行中的内核仍是旧二进制（进程持有旧 inode），提醒重启生效。
    // TUN 在跑时裸 start 会静默切回 Mixed（还要一次 sudo），必须给 start tun——
    // 与 sub update 的重启提示同判据
    const state = getRunningState();
    if (state.running) {
      const restartCommand = state.kind === 'tun' ? 'mihomo start tun' : 'mihomo start';
      console.log(colors.yellow(`提示: 运行中的内核仍是旧版本，执行 ${restartCommand} 重启后生效`));
    }
    // ad-hoc 签名的 Go 二进制被替换后，macOS 可能按新可执行文件重新要求本地网络授权；
    // 只影响指向局域网地址的节点，提示一次胜过连不通时翻 README
    console.log(colors.gray('提示: 若使用局域网节点（192.168/10.x/*.local），首次启动可能重新弹出「本地网络」授权'));
  }
}
