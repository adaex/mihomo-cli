import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { compareVersions } from 'compare-versions';
import { clearKernelVersionCache, getKernelVersion } from './config.js';
import { createHttpClient } from './http.js';
import { DIRS, ensureDirs, PATHS } from './paths.js';
import type { GitHubAsset, GitHubRelease, KernelUpdateInfo } from './types.js';

const GITHUB_REPO = 'MetaCubeX/mihomo';
const KERNEL_HTTP_TIMEOUT = 120_000;
const KERNEL_DOWNLOAD_TIMEOUT = 180_000;

const HTTP_CLIENT = createHttpClient({ timeout: KERNEL_HTTP_TIMEOUT });

/** 给 GitHub 下载地址套镜像前缀；非 GitHub 地址原样返回（调用前必须已过 assertTrustedAssetUrl）。 */
function withMirror(url: string, mirror: string | null): string {
  if (mirror && url.startsWith('https://github.com/')) {
    return mirror + url;
  }
  return url;
}

/** 允许直接下载内核产物的上游 host（GitHub release 资产的真实落点）。 */
const ALLOWED_ASSET_HOSTS = new Set(['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

/**
 * 校验 release 资产的下载地址确实指向 GitHub，且是 https。
 *
 * 为什么必须有：`withMirror` 对非 github 的 URL **原样放行**，故一个被篡改的
 * `browser_download_url` 能让 CLI 下载任意二进制。该产物随后被 `chmod 755`，
 * 并在 TUN / daemon 模式下**以 root 运行**——这是比「无 checksum」更实际的缺口
 * （上游 release 确实不提供 checksums，无法做哈希校验，故把来源钉死是主要防线）。
 * API 恒直连已消除镜像伪造该字段的路径，此校验是纵深防御的第二道。
 *
 * 校验必须针对**加镜像前**的上游 URL：加了前缀后整串以镜像域名开头，无从判断来源。
 */
function assertTrustedAssetUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`内核下载地址无法解析: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`内核下载地址必须是 https: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_ASSET_HOSTS.has(host)) {
    throw new Error(`内核下载地址的主机不在白名单内: ${host}\n  仅允许: ${[...ALLOWED_ASSET_HOSTS].join(', ')}`);
  }
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

  // 标准版尾缀为版本号（mihomo-darwin-arm64-v1.x.y.gz）；-compatible/-go 变体也满足尾缀形态，
  // 需显式排除——否则字母序靠前的 compatible 版会被优先选中（Intel Mac 上性能低于标准版）。
  // 无标准版时回退 matchingAssets[0]，仍能装上可用内核。
  const standardAsset = matchingAssets.find(a => {
    const nameWithoutGz = a.name.slice(0, -3);
    const parts = nameWithoutGz.split('-');
    const lastPart = parts[parts.length - 1];
    return /^v?\d+\.\d+\.\d+/.test(lastPart) && !nameWithoutGz.includes('-go') && !nameWithoutGz.includes('-compatible');
  });

  return standardAsset || matchingAssets[0];
}

/** 拉取 release 列表。**恒直连 GitHub API**：镜像只用于产物下载，见 assertTrustedAssetUrl 的说明。 */
async function getLatestRelease(repo: string): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${repo}/releases`;
  const response = await HTTP_CLIENT.get<GitHubRelease[]>(url, { responseType: 'json' });
  const releases = response.data;

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

export async function checkUpdate(): Promise<KernelUpdateInfo> {
  const currentVersion = getKernelVersion();
  const latest = await getLatestRelease(GITHUB_REPO);
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

/**
 * 在解压目录里找内核二进制。
 *
 * 用 `lstatSync` 而非 `statSync`：后者**跟随符号链接**。归档里一个名为 `mihomo`、
 * linkname 指向 `/任意/路径` 的 symlink 成员，条目名合法（不含 `..`、非绝对路径）
 * 故能通过解压前的路径穿越守卫，随后被当成二进制返回，最终 `chmodSync(target, 0o755)`
 * 沿链接作用到受害文件——实测把 `chmod 600` 的文件改成了 755。
 * 用 lstat 后 symlink 既不会被当目录递归，也不会被当二进制返回。
 */
function findBinaryInDir(dir: string, maxDepth = 4): string | null {
  if (maxDepth <= 0) return null;
  const files = fs.readdirSync(dir);

  for (const f of files) {
    const fullPath = path.join(dir, f);
    const stat = fs.lstatSync(fullPath);

    if (stat.isDirectory()) {
      const found = findBinaryInDir(fullPath, maxDepth - 1);
      if (found) return found;
      continue;
    }

    // 只认普通文件：symlink / fifo / socket 等一律跳过
    if (!stat.isFile()) continue;

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

  const latest = releaseInfo || (await getLatestRelease(GITHUB_REPO));
  const arch = getArch();
  const platform = process.platform;

  const asset = findMatchingAsset(latest.assets, platform, arch);

  if (!asset) {
    const available = latest.assets.map(a => a.name).join(', ');
    let hint = '';
    if (available) hint = `\n  可用版本: ${available}`;
    throw new Error(`未找到匹配的内核文件\n  平台: ${platform}, 架构: ${arch}${hint}`);
  }

  // 先钉死上游来源，再套镜像前缀（顺序不可换：加了前缀就看不出原始 host 了）
  assertTrustedAssetUrl(asset.browser_download_url);
  const downloadUrl = withMirror(asset.browser_download_url, mirror);
  // basename 剥离 asset.name 里的任何目录成分：API 响应/镜像若被篡改带 ../ 可写出 kernel 目录外
  const tempPath = path.join(DIRS.kernel, path.basename(asset.name));
  const sizeMB = (asset.size / 1024 / 1024).toFixed(2);

  if (mirror && progressCallback) {
    progressCallback('提示: 经第三方镜像中转下载，无法验证来源完整性，建议直连或自行校验产物');
  }

  if (progressCallback) {
    progressCallback(`下载内核: ${asset.name} (${sizeMB} MB)`);
  }

  // --proto '=https' / --proto-redir '=https': curl -L 默认跟随任意协议的重定向,
  // 实测会跟着 302 降级到明文 http 并把响应落盘。产物随后以 root 运行,
  // 故全链路(含重定向)强制 https。--max-filesize 防止被喂超大文件撑爆磁盘。
  const maxBytes = Number.isFinite(asset.size) && asset.size > 0 ? Math.floor(asset.size * 2 + 1024 * 1024) : 512 * 1024 * 1024;
  const curlResult = spawnSync(
    'curl',
    [
      '-L',
      '--proto',
      '=https',
      '--proto-redir',
      '=https',
      '--max-filesize',
      String(maxBytes),
      '--progress-bar',
      '--connect-timeout',
      '30',
      '--max-time',
      String(Math.floor(KERNEL_DOWNLOAD_TIMEOUT / 1000)),
      '-o',
      tempPath,
      downloadUrl,
    ],
    { stdio: 'inherit' },
  );

  if (curlResult.error) {
    if ((curlResult.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('未找到 curl 命令，请先安装 curl 后重试');
    }
    throw new Error(`下载失败: ${curlResult.error.message}`);
  }

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

  // 比对 API 声明的资产大小：`asset.size` 此前只用于显示。不匹配说明下载被截断
  // （网络中断留下半个文件）或内容被替换。无 checksum 可校验时这是唯一的完整性信号——
  // 强度有限（攻击者可填充到同样字节数），但能挡住截断与不等长的偷换。
  // 要求精确相等：release 资产是不可变的，字节数不该有任何偏差。
  if (Number.isFinite(asset.size) && asset.size > 0) {
    const actual = fs.statSync(tempPath).size;
    if (actual !== asset.size) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
      throw new Error(
        `下载的文件大小与 release 元数据不符（期望 ${asset.size} 字节，实际 ${actual} 字节）\n  可能是下载被截断或内容被替换，请重试或改用 --no-mirror 直连`,
      );
    }
  }

  if (progressCallback) {
    progressCallback('解压内核...');
  }

  const extractPath = DIRS.kernel;
  let extractedBinary: string | null = null;

  try {
    if (tempPath.endsWith('.tar.gz') || tempPath.endsWith('.tgz')) {
      // 两道守卫，各用一种列表格式（刻意分开：-tv 的条目名在含空格的文件名下无法可靠切出，
      // 而 -t 又不带类型信息，硬从 -tv 里解析名字会误判）：
      //
      // 1) -tzf 给出干净的条目名（一行一个，无附加列）→ 查路径穿越
      const listResult = spawnSync('tar', ['-tzf', tempPath], { encoding: 'utf8', timeout: 60_000 });
      if (listResult.error) throw listResult.error;
      if (listResult.status !== 0) throw new Error(`tar 列表退出码 ${listResult.status}`);
      for (const entry of (listResult.stdout || '').split('\n').filter(Boolean)) {
        if (entry.startsWith('/') || entry.split('/').includes('..')) {
          throw new Error(`归档含非法路径条目: ${entry}`);
        }
      }

      // 2) -tvzf 的首列权限串首字符给出条目类型 → 拒绝符号/硬链接成员。
      // 名为 mihomo、linkname 指向任意路径的 symlink 条目名完全合法，能通过上面的路径检查，
      // 后续却会让 chmod 755 沿链接作用到受害文件（findBinaryInDir 的 lstat 是第二道防线）
      const typeResult = spawnSync('tar', ['-tvzf', tempPath], { encoding: 'utf8', timeout: 60_000 });
      if (typeResult.error) throw typeResult.error;
      if (typeResult.status !== 0) throw new Error(`tar 列表退出码 ${typeResult.status}`);
      for (const line of (typeResult.stdout || '').split('\n').filter(Boolean)) {
        const typeChar = line[0];
        // - 普通文件、d 目录；l 符号链接、h 硬链接及其余特殊类型一律拒绝
        if (typeChar !== '-' && typeChar !== 'd') {
          throw new Error(`归档含非普通文件条目（类型 "${typeChar}"）: ${line}`);
        }
      }

      // --no-same-owner: 即便前面漏判也不让归档改变属主
      const tarResult = spawnSync('tar', ['--no-same-owner', '-xzf', tempPath, '-C', extractPath], {
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 60_000,
      });
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
