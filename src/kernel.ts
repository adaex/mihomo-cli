import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { compareVersions } from 'compare-versions';
import { clearKernelVersionCache, getKernelVersion } from './config.js';
import { VERSION } from './constants.js';
import { createHttpClient } from './http.js';
import { DIRS, ensureDirs, PATHS } from './paths.js';
import type { GitHubAsset, GitHubRelease, KernelUpdateInfo } from './types.js';
import { escapeRegExp } from './utils.js';

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
 * 并在 TUN / 系统级服务下**以 root 运行**——这是比「无 checksum」更实际的缺口
 * （上游 release 确实不提供 checksums，无法做哈希校验，故把来源钉死是主要防线）。
 * API 不经过镜像（代理开着时仅经本机代理转发，TLS 端到端，响应仍来自 GitHub），
 * 已消除镜像伪造该字段的路径，此校验是纵深防御的第二道。
 *
 * 校验必须针对**加镜像前**的上游 URL：加了前缀后整串以镜像域名开头，无从判断来源。
 * gh 通道不使用该 URL（gh 按 tag + 资产名自行解析），校验照跑——验证 API 响应未被篡改。
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

// === 下载通道 ===

/**
 * 内核下载通道。选择逻辑见 resolveDownloadChannel：
 * - gh：GitHub CLI 直连 GitHub，信任锚是 gh 本身 + 精确资产名，最优通道
 * - proxy：经本机混合端口直连 GitHub，TLS 端到端
 * - mirror：第三方镜像前缀，无法验证来源完整性，仅兜底
 * - direct：curl 直连
 */
export type DownloadChannel = { kind: 'gh' } | { kind: 'proxy'; port: number } | { kind: 'mirror'; mirror: string } | { kind: 'direct' };

export interface ChannelResolutionInput {
  /** parseMirrorArg 解析出的镜像（显式值或已存偏好），无则 null */
  mirror: string | null;
  /** 显式 --mirror（裸或带值） */
  isOverride: boolean;
  /** 显式 --mirror direct：强制直连，绕过 gh/代理自动通道 */
  clearSaved: boolean;
  ghAvailable: boolean;
  proxyRunning: boolean;
  /** 仅 proxyRunning 时有意义 */
  proxyPort: number | null;
}

/**
 * 下载通道决策。显式手动覆盖最高优先；默认路径 gh > 本机代理 > 已存镜像偏好 > 直连。
 * 纯函数：运行状态（gh 是否存在、代理是否在跑）由命令层探测后注入，便于单测。
 */
export function resolveDownloadChannel(input: ChannelResolutionInput): DownloadChannel {
  if (input.clearSaved) return { kind: 'direct' };
  if (input.isOverride && input.mirror) return { kind: 'mirror', mirror: input.mirror };
  if (input.ghAvailable) return { kind: 'gh' };
  if (input.proxyRunning && input.proxyPort !== null) return { kind: 'proxy', port: input.proxyPort };
  if (input.mirror) return { kind: 'mirror', mirror: input.mirror };
  return { kind: 'direct' };
}

/** 检测 gh（GitHub CLI）是否可用：gh 直连 GitHub 且自带认证/代理环境，是最优下载通道 */
export function hasGh(): boolean {
  const result = spawnSync('gh', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function getArch(): string {
  const arch = process.arch;
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'amd64';
  return arch;
}

export function findMatchingAsset(assets: GitHubAsset[], platform: string, arch: string): GitHubAsset | null {
  const prefix = `mihomo-${platform}-${arch}`;
  const matchingAssets = assets.filter(
    a => (a.name.startsWith(prefix) && a.name.endsWith('.gz')) || (a.name.startsWith(`${prefix}-`) && a.name.endsWith('.gz')),
  );

  if (matchingAssets.length === 0) return null;
  if (matchingAssets.length === 1) return matchingAssets[0];

  // 标准版是精确形态 `mihomo-<platform>-<arch>-vX.Y.Z`（版本号收尾，无任何后缀变体）。
  // 之前只黑名单排除 -go/-compatible，漏了 GOAMD64 微架构变体 -v1/-v2/-v3——它们同样
  // 以版本号结尾、能通过旧判据，而按名称排序 `-`(0x2D) < `.`(0x2E) 使
  // `mihomo-darwin-amd64-v1-v1.19.30.gz` 排在标准版之前被 find 优先选中——
  // Intel Mac 上每次更新都静默装上性能最低档的 baseline 构建，下载/大小校验/自检全过。
  // 精确匹配形态可一并排除一切后缀变体，无需逐个枚举。
  // 无标准版时回退 matchingAssets[0]，仍能装上可用内核。
  const standardAsset = matchingAssets.find(a => new RegExp(`^${escapeRegExp(prefix)}-v?\\d+\\.\\d+\\.\\d+$`).test(a.name.slice(0, -3)));

  return standardAsset || matchingAssets[0];
}

/** 从 release 列表挑最新稳定版：排除 prerelease 与 alpha/beta/prerelease 标记的 tag，无稳定版回退最新 */
export function pickLatestRelease(releases: GitHubRelease[]): GitHubRelease {
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

/**
 * 拉取 release 列表。**绝不经过镜像**：镜像只作用于产物下载，API 若走镜像，
 * `browser_download_url` 就完全由镜像说了算（见 assertTrustedAssetUrl 的说明）。
 * 代理开着时经本机混合端口转发——本地代理只是传输层，TLS 端到端，响应仍来自 GitHub。
 * fetch 不支持 HTTP 代理（CONNECT），代理路径走 curl（下载/探测本就依赖 curl）。
 */
async function getLatestRelease(repo: string, proxyPort?: number | null): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${repo}/releases`;

  if (proxyPort) {
    const result = spawnSync(
      'curl',
      [
        '-s',
        '-x',
        `http://127.0.0.1:${proxyPort}`,
        '--proto',
        '=https',
        '--proto-redir',
        '=https',
        '--connect-timeout',
        '10',
        '--max-time',
        String(Math.floor(KERNEL_HTTP_TIMEOUT / 1000)),
        '-H',
        `User-Agent: mihomo-cli/${VERSION}`,
        url,
      ],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: KERNEL_HTTP_TIMEOUT + 10_000 },
    );
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('未找到 curl 命令，请先安装 curl 后重试');
      }
      throw new Error(`版本查询失败: ${result.error.message}`);
    }
    if (result.status !== 0) {
      // 错误行形如「curl: (7) Failed to connect to ...」，剥前缀取末行更可读（口径同 proxy-probe）
      const stderr = (result.stderr || '').trim();
      const lastLine = stderr
        ? stderr
            .split('\n')
            .pop()
            ?.replace(/^curl: \(\d+\)\s*/, '')
        : undefined;
      throw new Error(`版本查询失败 (curl 退出码 ${result.status}${lastLine ? `: ${lastLine}` : ''})`);
    }
    let releases: GitHubRelease[];
    try {
      releases = JSON.parse(result.stdout) as GitHubRelease[];
    } catch {
      throw new Error('版本查询失败: 响应不是合法 JSON（代理可能返回了错误页面）');
    }
    return pickLatestRelease(releases);
  }

  const response = await HTTP_CLIENT.get<GitHubRelease[]>(url, { responseType: 'json' });
  return pickLatestRelease(response.data);
}

export async function checkUpdate(proxyPort?: number | null): Promise<KernelUpdateInfo> {
  const currentVersion = getKernelVersion();
  const latest = await getLatestRelease(GITHUB_REPO, proxyPort);
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

/**
 * 构造内核下载的 curl 参数。纯函数：`--proto '=https'` 全链路强制 https 是安全防线
 * （curl -L 默认跟随协议降级重定向），参数数组值得单测锁死，防后续改动误删。
 */
export function buildKernelCurlArgs(args: { url: string; proxyPort: number | null; maxBytes: number; outputPath: string }): string[] {
  const argv = [
    '-L',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--max-filesize',
    String(args.maxBytes),
    '--progress-bar',
    '--connect-timeout',
    '30',
    '--max-time',
    String(Math.floor(KERNEL_DOWNLOAD_TIMEOUT / 1000)),
  ];
  if (args.proxyPort) {
    argv.push('-x', `http://127.0.0.1:${args.proxyPort}`);
  }
  argv.push('-o', args.outputPath, args.url);
  return argv;
}

/**
 * 构造 `gh release download` 参数。纯函数：gh 通道的信任锚是「gh 只与 GitHub 通信」
 * + 精确资产名（--pattern 是 glob），参数数组单测锁死。
 */
export function buildGhReleaseDownloadArgs(tag: string, assetName: string, dir: string): string[] {
  return ['release', 'download', tag, '--repo', GITHUB_REPO, '--pattern', assetName, '--dir', dir, '--clobber'];
}

export async function downloadKernel(
  progressCallback: ((msg: string) => void) | null,
  channel: DownloadChannel,
  releaseInfo?: GitHubRelease,
): Promise<{ version: string; path: string }> {
  ensureDirs();

  const latest = releaseInfo || (await getLatestRelease(GITHUB_REPO, channel.kind === 'proxy' ? channel.port : null));
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
  // 下载 URL：仅 mirror 通道套前缀；gh 通道不用 URL（gh 按 tag + 资产名自行解析）
  const downloadUrl = channel.kind === 'mirror' ? withMirror(asset.browser_download_url, channel.mirror) : asset.browser_download_url;

  // 下载、解压、自检都在临时目录里完成，自检通过后才原子替换旧内核。
  // 此前先删旧内核再自检，自检失败时系统无内核可用（KeepAlive 崩溃循环）；
  // 且解压直接在 DIRS.kernel 里进行，findBinaryInDir 能选中旧内核造成假「已更新」。
  // 临时目录建在 DIRS.kernel 内（同文件系统，rename 原子），findBinaryInDir 只搜它。
  const tempDir = fs.mkdtempSync(path.join(DIRS.kernel, '.tmp-'));
  // basename 剥离 asset.name 里的任何目录成分：API 响应/镜像若被篡改带 ../ 可写出临时目录外
  const tempPath = path.join(tempDir, path.basename(asset.name));
  const sizeMB = (asset.size / 1024 / 1024).toFixed(2);

  try {
    if (channel.kind === 'mirror' && progressCallback) {
      progressCallback('提示: 经第三方镜像中转下载，无法验证来源完整性，建议改用 gh/本机代理通道或自行校验产物');
    }

    if (progressCallback) {
      progressCallback(`下载内核: ${asset.name} (${sizeMB} MB)`);
    }

    if (channel.kind === 'gh') {
      // gh 的 --pattern 是 glob 且按资产名落盘：名字含 *?[] 会匹配到非预期资产，
      // 含路径成分（/、..）会写出临时目录。API 响应经 TLS 来自 GitHub，此处属纵深防御。
      // gh 自带进度条，stdio inherit 即可；timeout 是 gh 无内置超时的兜底
      if (/[*?[\]]/.test(asset.name) || asset.name !== path.basename(asset.name)) {
        throw new Error(`内核资产名含非法字符: ${asset.name}`);
      }
      const ghResult = spawnSync('gh', buildGhReleaseDownloadArgs(latest.tag_name, asset.name, tempDir), {
        stdio: 'inherit',
        timeout: KERNEL_DOWNLOAD_TIMEOUT + 30_000,
      });
      if (ghResult.error) {
        if ((ghResult.error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('未找到 gh 命令（选择通道时明明可用），请重试或改用其他通道');
        }
        if ((ghResult.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          throw new Error(`下载超时（gh ${Math.floor((KERNEL_DOWNLOAD_TIMEOUT + 30_000) / 1000)}s 未完成），GitHub 直连过慢时改用: mihomo kernel --mirror`);
        }
        throw new Error(`下载失败: ${ghResult.error.message}`);
      }
      if (ghResult.status !== 0) {
        throw new Error(`下载失败 (gh 退出码 ${ghResult.status})`);
      }
    } else {
      // --proto '=https' / --proto-redir '=https': curl -L 默认跟随任意协议的重定向,
      // 实测会跟着 302 降级到明文 http 并把响应落盘。产物随后以 root 运行,
      // 故全链路(含重定向)强制 https。--max-filesize 防止被喂超大文件撑爆磁盘。
      const maxBytes = Number.isFinite(asset.size) && asset.size > 0 ? Math.floor(asset.size * 2 + 1024 * 1024) : 512 * 1024 * 1024;
      const curlResult = spawnSync(
        'curl',
        buildKernelCurlArgs({
          url: downloadUrl,
          proxyPort: channel.kind === 'proxy' ? channel.port : null,
          maxBytes,
          outputPath: tempPath,
        }),
        { stdio: 'inherit' },
      );

      if (curlResult.error) {
        if ((curlResult.error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('未找到 curl 命令，请先安装 curl 后重试');
        }
        throw new Error(`下载失败: ${curlResult.error.message}`);
      }

      if (curlResult.status !== 0) {
        throw new Error(`下载失败 (curl 退出码 ${curlResult.status})`);
      }
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
        throw new Error(
          `下载的文件大小与 release 元数据不符（期望 ${asset.size} 字节，实际 ${actual} 字节）\n  可能是下载被截断或内容被替换，请重试或改用其他通道（gh/本机代理/--mirror direct 直连）`,
        );
      }
    }

    if (progressCallback) {
      progressCallback('解压内核...');
    }

    let extractedBinary: string | null = null;

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
      const tarResult = spawnSync('tar', ['--no-same-owner', '-xzf', tempPath, '-C', tempDir], {
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 60_000,
      });
      if (tarResult.error) throw tarResult.error;
      if (tarResult.status !== 0) throw new Error(`tar 退出码 ${tarResult.status}`);
    } else if (tempPath.endsWith('.gz')) {
      const baseName = path.basename(tempPath, '.gz');
      const outputPath = path.join(tempDir, baseName);
      // gzip -dc 输出到 stdout，捕获为 buffer 后写文件，避免 shell 重定向（注入风险）
      const gzipResult = spawnSync('gzip', ['-dc', tempPath], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
      if (gzipResult.error) throw gzipResult.error;
      if (gzipResult.status !== 0) throw new Error(`gzip 退出码 ${gzipResult.status}`);
      fs.writeFileSync(outputPath, gzipResult.stdout, { mode: 0o755 });
      extractedBinary = outputPath;
    }

    const foundBinary = extractedBinary || findBinaryInDir(tempDir);

    if (!foundBinary) {
      throw new Error('解压后未找到可执行文件');
    }

    // 自检在临时位置进行（旧内核尚未被触碰）：跑一次 -v 确认二进制可执行且未损坏/架构匹配
    // （上游 release 不提供 checksums，无法哈希校验）。通过后才原子替换。
    if (progressCallback) {
      progressCallback('校验内核...');
    }
    fs.chmodSync(foundBinary, 0o755);
    const check = spawnSync(foundBinary, ['-v'], { encoding: 'utf8', timeout: 5000 });
    const checkOutput = `${check.stdout || ''}${check.stderr || ''}`.trim();
    if (check.error || check.status !== 0 || !/v?\d+\.\d+\.\d+/.test(checkOutput)) {
      throw new Error(`内核自检失败（可能下载损坏或架构不匹配），旧内核未受影响\n  退出码: ${check.status}\n  输出: ${checkOutput || '(空)'}`);
    }

    // 版本对账：自检通过不代表版本对——归档可能含旧版本二进制（镜像返回错误资产等）。
    // 与 latest.tag_name 比对，不一致即失败，避免「报已更新但二进制没变」。
    const versionMatch = checkOutput.match(/v?(\d+\.\d+\.\d+)/);
    if (versionMatch && latest.tag_name) {
      const binaryVersion = versionMatch[1];
      const expectedVersion = latest.tag_name.replace(/^v/, '');
      if (binaryVersion !== expectedVersion) {
        throw new Error(`内核版本不匹配（期望 ${expectedVersion}，实际 ${binaryVersion}），旧内核未受影响`);
      }
    }

    // 原子替换：同文件系统内 rename 是原子的，旧内核要么完全是旧版、要么完全是新版
    const targetPath = PATHS.mihomoBinary;
    fs.renameSync(foundBinary, targetPath);
    fs.chmodSync(targetPath, 0o755);

    clearKernelVersionCache();

    return { version: latest.tag_name, path: targetPath };
  } finally {
    // 清理临时目录（无论成功失败）；旧内核不受影响
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
