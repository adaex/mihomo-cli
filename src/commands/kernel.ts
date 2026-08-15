import { colors } from '../colors.js';
import { AVAILABLE_MIRRORS } from '../constants.js';
import { CliError } from '../errors.js';
import * as kernel from '../kernel.js';
import { getRunningState } from '../runtime.js';
import { parseMirrorArg } from '../utils.js';

export async function cmdKernel(args: string[]): Promise<void> {
  const mirrorInfo = parseMirrorArg(args);
  const effectiveMirror = mirrorInfo.mirror;

  if (effectiveMirror) {
    const mirrorDesc = mirrorInfo.type === 'all' ? ' (API和下载均使用镜像)' : ' (下载时使用镜像)';
    console.log(`镜像: ${effectiveMirror}${mirrorDesc}`);
    console.log('');
  }

  console.log('检查内核更新...');

  try {
    const apiMirror = mirrorInfo.type === 'all' ? effectiveMirror : null;
    const info = await kernel.checkUpdate(apiMirror);
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
        '  mihomo kernel --mirror [镜像]     # 下载走镜像（默认 v6.gh-proxy.org）',
        '  mihomo kernel --mirror-all [镜像] # API 和下载都走镜像',
        `  可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`,
      );
    }
    throw new CliError(err.message, { label: '更新失败', hint });
  }
}
