import { AVAILABLE_MIRRORS } from '../constants.js';
import * as kernel from '../kernel.js';
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
    }
  } catch (e) {
    console.error(`\n更新失败: ${(e as Error).message}`);
    const err = e as Error & { response?: { data?: { message?: string; documentation_url?: string } } };
    if (err.response?.data) {
      if (err.response.data.message) {
        console.error(`原因: ${err.response.data.message}`);
      }
      if (err.response.data.documentation_url) {
        console.error(`文档: ${err.response.data.documentation_url}`);
      }
    }
    // 平时不打扰；仅直连失败时提示镜像用法
    if (!effectiveMirror) {
      console.error('');
      console.error('提示: 直连失败或下载过慢时可使用镜像:');
      console.error('  mihomo kernel --mirror [镜像]     # 下载走镜像（默认 v6.gh-proxy.org）');
      console.error('  mihomo kernel --mirror-all [镜像] # API 和下载都走镜像');
      console.error(`  可用镜像: ${AVAILABLE_MIRRORS.join(', ')}`);
    }
    process.exit(1);
  }
}
