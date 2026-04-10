import { AVAILABLE_MIRRORS } from '../constants.js';
import * as kernel from '../kernel.js';
import { parseMirrorArg } from '../utils.js';

export async function cmdKernel(args: string[]): Promise<void> {
  const mirrorInfo = parseMirrorArg(args);
  const effectiveMirror = mirrorInfo.mirror;

  if (effectiveMirror) {
    const mirrorDesc = mirrorInfo.type === 'all' ? ' (API和下载均使用镜像)' : ' (下载时使用镜像)';
    console.log(`镜像: ${effectiveMirror}${mirrorDesc}`);
  }

  console.log('\n提示: 如果下载速度过慢或直连失败，可使用 --mirror 参数通过镜像下载');
  console.log('\n用法:');
  console.log('  mihomo kernel                    # 直连');
  console.log('  mihomo kernel --mirror           # 下载使用默认镜像 (v6.gh-proxy.org)');
  console.log('  mihomo kernel --mirror hk.gh-proxy.org  # 下载使用指定镜像');
  console.log('  mihomo kernel --mirror-all       # API请求和下载都使用默认镜像');
  console.log('  mihomo kernel --mirror-all hk.gh-proxy.org  # API和下载都使用指定镜像');

  console.log('\n可用镜像:');
  for (const m of AVAILABLE_MIRRORS) {
    const isCurrent = effectiveMirror && (effectiveMirror.includes(`//${m}/`) || effectiveMirror.includes(`//${m}:`) || effectiveMirror.endsWith(`//${m}`));
    console.log(`  ${m}${isCurrent ? ' (当前)' : ''}`);
  }
  console.log('');

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
    process.exit(1);
  }
}
