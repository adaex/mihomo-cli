import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { compareVersions } from 'compare-versions';
import { clearKernelVersionCache, getKernelVersion } from './config.js';
import { DIRS, ensureDirs, PATHS } from './paths.js';
import type { GitHubAsset, GitHubRelease, KernelUpdateInfo } from './types.js';
import { createHttpClient } from './utils.js';

const GITHUB_REPO = 'MetaCubeX/mihomo';
const KERNEL_HTTP_TIMEOUT = 120_000;
const KERNEL_DOWNLOAD_TIMEOUT = 180_000;

const HTTP_CLIENT = createHttpClient({ timeout: KERNEL_HTTP_TIMEOUT });

function withMirror(url: string, mirror: string | null): string {
  if (mirror && (url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/'))) {
    return mirror + url;
  }
  return url;
}

function getArch(): string {
  const arch = process.arch;
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'amd64';
  return arch;
}

function findMatchingAsset(assets: GitHubAsset[], platform: string, arch: string): GitHubAsset | null {
  const prefix = `mihomo-${platform}-${arch}`;
  const matchingAssets = assets.filter(
    a => (a.name.startsWith(prefix) && a.name.endsWith('.gz')) || (a.name.startsWith(`${prefix}-`) && a.name.endsWith('.gz')),
  );

  if (matchingAssets.length === 0) return null;
  if (matchingAssets.length === 1) return matchingAssets[0];

  const standardAsset = matchingAssets.find(a => {
    const nameWithoutGz = a.name.slice(0, -3);
    const parts = nameWithoutGz.split('-');
    const lastPart = parts[parts.length - 1];
    return /^v?\d+\.\d+\.\d+/.test(lastPart) && !nameWithoutGz.includes('-go');
  });

  return standardAsset || matchingAssets[0];
}

async function getLatestRelease(repo: string, mirror: string | null): Promise<GitHubRelease> {
  const url = withMirror(`https://api.github.com/repos/${repo}/releases`, mirror);
  const response = await HTTP_CLIENT.get(url, { responseType: 'json' });
  const releases = response.data as unknown as GitHubRelease[];

  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error('无法获取版本信息');
  }

  const stableReleases = releases.filter(
    r =>
      !r.prerelease &&
      !r.tag_name.toLowerCase().includes('alpha') &&
      !r.tag_name.toLowerCase().includes('beta') &&
      !r.tag_name.toLowerCase().includes('prerelease'),
  );

  return stableReleases.length > 0 ? stableReleases[0] : releases[0];
}

export async function checkUpdate(mirror: string | null): Promise<KernelUpdateInfo> {
  const currentVersion = getKernelVersion();
  const latest = await getLatestRelease(GITHUB_REPO, mirror);
  const latestVersion = latest.tag_name;

  let needsUpdate = false;
  const currentDisplay = currentVersion || '未安装';

  if (!currentVersion) {
    needsUpdate = true;
  } else {
    try {
      needsUpdate = compareVersions(latestVersion.replace(/^v/, ''), currentVersion.replace(/^v/, '')) > 0;
    } catch {
      needsUpdate = latestVersion !== currentVersion;
    }
  }

  return {
    current: currentDisplay,
    latest: latestVersion,
    needsUpdate,
    assets: latest.assets,
    release: latest,
  };
}

function findBinaryInDir(dir: string, maxDepth = 4): string | null {
  if (maxDepth <= 0) return null;
  const files = fs.readdirSync(dir);

  for (const f of files) {
    const fullPath = path.join(dir, f);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const found = findBinaryInDir(fullPath, maxDepth - 1);
      if (found) return found;
      continue;
    }

    if (f === 'mihomo') return fullPath;
    if (f.includes('mihomo') && !f.endsWith('.gz')) return fullPath;
  }

  return null;
}

export async function downloadKernel(
  progressCallback: ((msg: string) => void) | null,
  mirror: string | null,
  releaseInfo?: GitHubRelease,
): Promise<{ version: string; path: string }> {
  ensureDirs();

  const latest = releaseInfo || (await getLatestRelease(GITHUB_REPO, mirror));
  const arch = getArch();
  const platform = process.platform;

  const asset = findMatchingAsset(latest.assets, platform, arch);

  if (!asset) {
    const available = latest.assets.map(a => a.name).join(', ');
    let hint = '';
    if (available) hint = `\n  可用版本: ${available}`;
    throw new Error(`未找到匹配的内核文件\n  平台: ${platform}, 架构: ${arch}${hint}`);
  }

  const downloadUrl = withMirror(asset.browser_download_url, mirror);
  const tempPath = path.join(DIRS.kernel, asset.name);
  const sizeMB = (asset.size / 1024 / 1024).toFixed(2);

  if (mirror && progressCallback) {
    progressCallback('提示: 经第三方镜像中转下载，无法验证来源完整性，建议直连或自行校验产物');
  }

  if (progressCallback) {
    progressCallback(`下载内核: ${asset.name} (${sizeMB} MB)`);
  }

  const curlResult = spawnSync(
    'curl',
    ['-L', '--progress-bar', '--connect-timeout', '30', '--max-time', String(Math.floor(KERNEL_DOWNLOAD_TIMEOUT / 1000)), '-o', tempPath, downloadUrl],
    { stdio: 'inherit' },
  );

  if (curlResult.status !== 0) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw new Error(`下载失败 (curl 退出码 ${curlResult.status})`);
  }

  if (!fs.existsSync(tempPath)) {
    throw new Error('下载失败: 文件未生成');
  }

  if (progressCallback) {
    progressCallback('解压内核...');
  }

  const extractPath = DIRS.kernel;
  let extractedBinary: string | null = null;

  try {
    if (tempPath.endsWith('.tar.gz') || tempPath.endsWith('.tgz')) {
      const tarResult = spawnSync('tar', ['-xzf', tempPath, '-C', extractPath], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60_000 });
      if (tarResult.error) throw tarResult.error;
      if (tarResult.status !== 0) throw new Error(`tar 退出码 ${tarResult.status}`);
    } else if (tempPath.endsWith('.gz')) {
      const baseName = path.basename(tempPath, '.gz');
      const outputPath = path.join(extractPath, baseName);
      // gzip -dc 输出到 stdout，捕获为 buffer 后写文件，避免 shell 重定向（注入风险）
      const gzipResult = spawnSync('gzip', ['-dc', tempPath], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
      if (gzipResult.error) throw gzipResult.error;
      if (gzipResult.status !== 0) throw new Error(`gzip 退出码 ${gzipResult.status}`);
      fs.writeFileSync(outputPath, gzipResult.stdout, { mode: 0o755 });
      extractedBinary = outputPath;
    }
  } catch (e) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw new Error(`解压失败: ${(e as Error).message}`);
  }

  const foundBinary = extractedBinary || findBinaryInDir(extractPath);

  if (!foundBinary) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw new Error('解压后未找到可执行文件');
  }

  const targetPath = PATHS.mihomoBinary;

  if (foundBinary !== targetPath) {
    if (fs.existsSync(targetPath)) {
      fs.chmodSync(targetPath, 0o755);
      try {
        fs.unlinkSync(targetPath);
      } catch {
        /* ignore */
      }
    }
    fs.renameSync(foundBinary, targetPath);
  }

  fs.chmodSync(targetPath, 0o755);

  // 下载后自检：跑一次 -v 确认二进制可执行且未损坏/架构匹配（上游 release 不提供 checksums，无法哈希校验）
  if (progressCallback) {
    progressCallback('校验内核...');
  }
  const check = spawnSync(targetPath, ['-v'], { encoding: 'utf8', timeout: 5000 });
  const checkOutput = `${check.stdout || ''}${check.stderr || ''}`.trim();
  if (check.error || check.status !== 0 || !/v?\d+\.\d+\.\d+/.test(checkOutput)) {
    try {
      fs.unlinkSync(targetPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw new Error(`内核自检失败（可能下载损坏或架构不匹配），已删除\n  退出码: ${check.status}\n  输出: ${checkOutput || '(空)'}`);
  }

  try {
    fs.unlinkSync(tempPath);
  } catch {
    /* ignore */
  }

  clearKernelVersionCache();

  return { version: latest.tag_name, path: targetPath };
}
