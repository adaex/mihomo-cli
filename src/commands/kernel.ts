import { colors } from '../colors.js';
import { AVAILABLE_MIRRORS } from '../constants.js';
import { CliError } from '../errors.js';
import * as kernel from '../kernel.js';
import { getRunningState } from '../runtime.js';
import { readSettings, writeSettings } from '../settings.js';
import { withSpinner } from '../spinner.js';
import { parseMirrorArg } from '../utils.js';

/**
 * 拒绝未知选项（同 reset 的 KNOWN_FLAGS 口径）。
 * `--mirror` 敲错一个字母（`--miror`）此前会静默按直连下载：不报错但行为不对，
 * 而镜像正是这条命令最常用的选项，直连慢才是用它的理由。
 * `parseMirrorArg` 已为已移除的 `--mirror-all` 单独抛错，此处补上其余拼写。
 */
function assertKnownKernelFlags(args: string[]): void {
  const KNOWN_FLAGS = new Set(['--mirror', '--no-mirror', '--direct']);
  const unknown = args
    .slice(1)
    .filter(a => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !a.startsWith('--mirror='))
    // --mirror-all 留给 parseMirrorArg：它有解释「为何移除」的专门文案，
    // 比通用的「未知选项」更有用，别让这里抢先吞掉
    .filter(a => a !== '--mirror-all' && !a.startsWith('--mirror-all='));
  if (unknown.length > 0) {
    throw new CliError(`未知的选项: ${unknown.join(', ')}`, {
      label: '参数错误',
      hint: [
        '',
        '可用选项:',
        '  --mirror [镜像]   下载走镜像（默认 v6.gh-proxy.org）',
        '  --no-mirror       显式直连（默认行为）',
        '',
        `可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`,
      ],
    });
  }
}

export async function cmdKernel(args: string[]): Promise<void> {
  assertKnownKernelFlags(args);
  const savedMirror = readSettings().kernel_mirror ?? null;
  const mirrorInfo = parseMirrorArg(args, savedMirror);
  const effectiveMirror = mirrorInfo.mirror;

  // 显式 --mirror 记住偏好（下次裸 mihomo kernel 默认走镜像）；--no-mirror 清除
  if (mirrorInfo.remember) {
    writeSettings({ kernel_mirror: mirrorInfo.mirror ?? undefined });
  } else if (mirrorInfo.clearSaved && savedMirror) {
    writeSettings({ kernel_mirror: undefined });
  }

  if (effectiveMirror) {
    const host = effectiveMirror.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const note = mirrorInfo.remember
      ? '已记住偏好，后续默认走镜像（--no-mirror 直连并清除偏好）'
      : !mirrorInfo.isOverride
        ? '已记住的偏好（--no-mirror 直连并清除偏好）'
        : '仅下载走镜像，版本查询恒直连';
    console.log(`镜像: ${host} (${note})`);
    console.log('');
  }

  let info: Awaited<ReturnType<typeof kernel.checkUpdate>>;
  try {
    info = await withSpinner('检查内核更新（GitHub 直连，国内网络可能较慢）', () => kernel.checkUpdate());
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
    // 平时不打扰；仅直连失败时提示镜像用法
    if (!effectiveMirror) {
      hint.push(
        '',
        '提示: 直连失败或下载过慢时可使用镜像:',
        '  mihomo kernel --mirror [镜像]   # 下载走镜像（默认 v6.gh-proxy.org），一次使用后记住偏好',
        `  可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`,
      );
    }
    throw new CliError(err.message, { label: '更新失败', hint });
  }
  console.log(`当前: ${info.current}`);
  console.log(`最新: ${info.latest}`);

  if (!info.needsUpdate) {
    console.log('已是最新版本');
  } else {
    console.log('\n正在下载...');
    const result = await kernel.downloadKernel(msg => console.log(msg), mirrorInfo.mirror, info.release);
    console.log(`\n已更新到 ${result.version}`);
    // 运行中的内核仍是旧二进制（进程持有旧 inode），提醒重启生效
    if (getRunningState().running) {
      console.log(colors.yellow('提示: 运行中的内核仍是旧版本，执行 mihomo start 重启后生效'));
    }
  }
}
