import { colors } from '../colors.js';
import { AVAILABLE_MIRRORS } from '../constants.js';
import { CliError } from '../errors.js';
import * as kernel from '../kernel.js';
import { getRunningState } from '../runtime.js';
import { getPorts, readSettings, writeSettings } from '../settings.js';
import { withSpinner } from '../spinner.js';
import { parseMirrorArg } from '../utils.js';

/**
 * 拒绝未知选项（同 reset 的 KNOWN_FLAGS 口径）。
 * `--mirror` 敲错一个字母（`--miror`）此前会静默按直连下载：不报错但行为不对，
 * 而镜像正是这条命令最常用的选项，直连慢才是用它的理由。
 * `parseMirrorArg` 已为已移除的 `--mirror-all`、`--no-mirror`/`--direct` 单独抛错，
 * 此处补上其余拼写——已移除选项要放行到 parseMirrorArg，它的迁移指引比通用「未知选项」更有用。
 */
function assertKnownKernelFlags(args: string[]): void {
  const KNOWN_FLAGS = new Set(['--mirror']);
  const unknown = args
    .slice(1)
    .filter(a => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !a.startsWith('--mirror='))
    // --mirror-all / --no-mirror / --direct 留给 parseMirrorArg：它们有解释「为何移除」的专门文案，
    // 比通用的「未知选项」更有用，别让这里抢先吞掉
    .filter(a => a !== '--mirror-all' && !a.startsWith('--mirror-all='))
    .filter(a => a !== '--no-mirror' && a !== '--direct');
  if (unknown.length > 0) {
    throw new CliError(`未知的选项: ${unknown.join(', ')}`, {
      label: '参数错误',
      hint: [
        '',
        '可用选项:',
        '  --mirror [镜像]   强制走镜像（默认按网络选 v6/裸域），并记住偏好',
        '',
        '不带选项时自动选择通道: gh > 本机代理 > 已记住的镜像偏好 > 直连',
        '',
        `可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`,
        '短别名: --mirror cdn | v4 | v6 | axisnow',
      ],
    });
  }
}

export async function cmdKernel(args: string[]): Promise<void> {
  assertKnownKernelFlags(args);
  const savedMirror = readSettings().kernel_mirror ?? null;
  const mirrorInfo = parseMirrorArg(args, savedMirror);
  const effectiveMirror = mirrorInfo.mirror;

  // 显式 --mirror 记住偏好（下次裸 mihomo kernel 在 gh/代理都不可用时默认走镜像）；--mirror direct 清除
  if (mirrorInfo.remember) {
    writeSettings({ kernel_mirror: mirrorInfo.mirror ?? undefined });
  } else if (mirrorInfo.clearSaved && savedMirror) {
    writeSettings({ kernel_mirror: undefined });
  }

  // 下载通道：显式手动覆盖最高优先，默认 gh > 本机代理 > 已存镜像偏好 > 直连。
  // 运行状态（gh 是否存在、代理是否在跑）由命令层探测后注入——kernel.ts 不依赖
  // runtime/settings，通道决策保持纯函数可测
  const proxyRunning = getRunningState().running;
  const proxyPort = proxyRunning ? getPorts().mixed : null;
  const forceDirect = mirrorInfo.clearSaved === true;
  const channel = kernel.resolveDownloadChannel({
    mirror: mirrorInfo.mirror,
    isOverride: mirrorInfo.isOverride,
    clearSaved: mirrorInfo.clearSaved ?? false,
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
    const note = mirrorInfo.remember
      ? '已记住偏好：gh/本机代理不可用时默认走镜像（--mirror direct 清除偏好）'
      : !mirrorInfo.isOverride
        ? '已记住的偏好：gh/本机代理不可用时生效（--mirror direct 清除偏好）'
        : '仅本次下载走镜像';
    console.log(`镜像: ${host} (${note})`);
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
          '  mihomo kernel --mirror [镜像]   # 强制走镜像（默认按网络选 v6/裸域），一次使用后记住偏好',
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
          '下载通道按优先级自动选择: gh（GitHub CLI）> 本机代理 > 镜像 > 直连',
          '手动指定: mihomo kernel --mirror [镜像]（强制镜像）/ mihomo kernel --mirror direct（强制直连）',
        ],
      });
    }
    console.log(`\n已更新到 ${result.version}`);
    // 运行中的内核仍是旧二进制（进程持有旧 inode），提醒重启生效
    if (getRunningState().running) {
      console.log(colors.yellow('提示: 运行中的内核仍是旧版本，执行 mihomo start 重启后生效'));
    }
  }
}
