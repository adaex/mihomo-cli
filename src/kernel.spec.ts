import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGhReleaseDownloadArgs, buildKernelCurlArgs, findMatchingAsset, pickLatestRelease, resolveDownloadChannel } from './kernel.js';
import type { GitHubAsset, GitHubRelease } from './types.js';

/** GitHub API 的 assets 按名称排序返回——fixture 顺序即 find() 的命中顺序，勿重排 */
const asset = (name: string): GitHubAsset => ({
  name,
  browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/${name}`,
  size: 1,
});

// MetaCubeX/mihomo v1.19.30 的 darwin 资产名（实测）。amd64 侧同时存在 GOAMD64
// 微架构变体（-v1/-v3）与 -compatible 变体；按名称排序 `-`(0x2D) < `.`(0x2E)，
// `mihomo-darwin-amd64-v1-v1.19.30.gz` 排在标准版 `mihomo-darwin-amd64-v1.19.30.gz` 之前
const DARWIN_ASSETS = [
  'mihomo-darwin-amd64-compatible-v1.19.30.gz',
  'mihomo-darwin-amd64-v1-v1.19.30.gz',
  'mihomo-darwin-amd64-v1.19.30.gz',
  'mihomo-darwin-amd64-v3-v1.19.30.gz',
  'mihomo-darwin-arm64-compatible-v1.19.30.gz',
  'mihomo-darwin-arm64-v1.19.30.gz',
  'mihomo-darwin-arm64-v1.19.30.zip',
].map(asset);

describe('findMatchingAsset（标准版形态精确匹配）', () => {
  it('Intel Mac 不选按名称排序靠前的 -v1 微架构变体（baseline 构建，性能最低档）', () => {
    // 回归：旧判据只黑名单 -go/-compatible，-v1 变体同样以版本号结尾、能通过全部检查，
    // 而它排在标准版之前被 find() 优先命中——下载/大小校验/自检全过，静默装错变体
    const picked = findMatchingAsset(DARWIN_ASSETS, 'darwin', 'amd64');
    assert.equal(picked?.name, 'mihomo-darwin-amd64-v1.19.30.gz');
  });

  it('不选 -compatible 变体（Intel 上性能低于标准版）', () => {
    const picked = findMatchingAsset(DARWIN_ASSETS, 'darwin', 'amd64');
    assert.notEqual(picked?.name, 'mihomo-darwin-amd64-compatible-v1.19.30.gz');
  });

  it('Apple Silicon 选标准版', () => {
    const picked = findMatchingAsset(DARWIN_ASSETS, 'darwin', 'arm64');
    assert.equal(picked?.name, 'mihomo-darwin-arm64-v1.19.30.gz');
  });

  it('非 .gz 资产（如 .zip）不参与匹配', () => {
    const picked = findMatchingAsset([asset('mihomo-darwin-arm64-v1.19.30.zip')], 'darwin', 'arm64');
    assert.equal(picked, null);
  });

  it('只有变体、无标准版时回退首个匹配（仍能装上可用内核）', () => {
    const picked = findMatchingAsset([asset('mihomo-darwin-amd64-v1-v1.19.30.gz'), asset('mihomo-darwin-amd64-v3-v1.19.30.gz')], 'darwin', 'amd64');
    assert.equal(picked?.name, 'mihomo-darwin-amd64-v1-v1.19.30.gz');
  });

  it('无匹配返回 null', () => {
    assert.equal(findMatchingAsset(DARWIN_ASSETS, 'linux', 'amd64'), null);
  });
});

describe('resolveDownloadChannel（下载通道优先级）', () => {
  const base = { mirror: null, isOverride: false, clearSaved: false, ghAvailable: false, proxyRunning: false, proxyPort: null };

  it('显式 --mirror 优先于 gh 与代理（手动覆盖最高）', () => {
    const ch = resolveDownloadChannel({
      ...base,
      mirror: 'https://v6.gh-proxy.org/',
      isOverride: true,
      ghAvailable: true,
      proxyRunning: true,
      proxyPort: 7890,
    });
    assert.equal(ch.kind, 'mirror');
    assert.equal(ch.kind === 'mirror' && ch.mirror, 'https://v6.gh-proxy.org/');
  });

  it('--no-mirror 强制直连，即使 gh/代理/镜像偏好都在', () => {
    const ch = resolveDownloadChannel({
      ...base,
      mirror: 'https://v6.gh-proxy.org/',
      clearSaved: true,
      ghAvailable: true,
      proxyRunning: true,
      proxyPort: 7890,
    });
    assert.equal(ch.kind, 'direct');
  });

  it('无显式选项时 gh 优先于代理', () => {
    const ch = resolveDownloadChannel({ ...base, ghAvailable: true, proxyRunning: true, proxyPort: 7890 });
    assert.equal(ch.kind, 'gh');
  });

  it('无 gh 时代理优先于镜像偏好，且端口透传', () => {
    const ch = resolveDownloadChannel({ ...base, mirror: 'https://v6.gh-proxy.org/', proxyRunning: true, proxyPort: 7890 });
    assert.equal(ch.kind, 'proxy');
    assert.equal(ch.kind === 'proxy' && ch.port, 7890);
  });

  it('无 gh 无代理时用已记住的镜像偏好', () => {
    const ch = resolveDownloadChannel({ ...base, mirror: 'https://v6.gh-proxy.org/' });
    assert.equal(ch.kind, 'mirror');
  });

  it('全无条件时直连', () => {
    assert.equal(resolveDownloadChannel(base).kind, 'direct');
  });
});

describe('buildGhReleaseDownloadArgs', () => {
  it('参数精确：tag/repo/pattern/dir/clobber', () => {
    const args = buildGhReleaseDownloadArgs('v1.19.30', 'mihomo-darwin-arm64-v1.19.30.gz', '/tmp/x');
    assert.deepEqual(args, [
      'release',
      'download',
      'v1.19.30',
      '--repo',
      'MetaCubeX/mihomo',
      '--pattern',
      'mihomo-darwin-arm64-v1.19.30.gz',
      '--dir',
      '/tmp/x',
      '--clobber',
    ]);
  });
});

describe('buildKernelCurlArgs', () => {
  const common = { url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/mihomo-darwin-arm64.gz', maxBytes: 123, outputPath: '/tmp/x.gz' };

  it('恒含 --proto =https / --proto-redir =https（防协议降级重定向）', () => {
    const args = buildKernelCurlArgs({ ...common, proxyPort: null });
    const i = args.indexOf('--proto');
    assert.equal(args[i + 1], '=https');
    const j = args.indexOf('--proto-redir');
    assert.equal(args[j + 1], '=https');
  });

  it('proxy 通道含 -x 且指向本机混合端口', () => {
    const args = buildKernelCurlArgs({ ...common, proxyPort: 7890 });
    const i = args.indexOf('-x');
    assert.equal(args[i + 1], 'http://127.0.0.1:7890');
  });

  it('非 proxy 通道不含 -x', () => {
    const args = buildKernelCurlArgs({ ...common, proxyPort: null });
    assert.ok(!args.includes('-x'));
  });

  it('-o 指向输出路径，末位为下载 URL', () => {
    const args = buildKernelCurlArgs({ ...common, proxyPort: null });
    const i = args.indexOf('-o');
    assert.equal(args[i + 1], '/tmp/x.gz');
    assert.equal(args[args.length - 1], common.url);
  });
});

describe('pickLatestRelease', () => {
  const rel = (tag: string, prerelease = false): GitHubRelease => ({ tag_name: tag, name: tag, prerelease, html_url: '', assets: [] });

  it('空数组抛错', () => {
    assert.throws(() => pickLatestRelease([]), /无法获取版本信息/);
  });

  it('过滤 prerelease 字段与 alpha/beta/prerelease 标记的 tag', () => {
    const picked = pickLatestRelease([rel('v2.0.0-beta.1'), rel('v2.0.0', true), rel('v1.19.30'), rel('v1.19.0-alpha')]);
    assert.equal(picked.tag_name, 'v1.19.30');
  });

  it('全是预发布时回退列表首个', () => {
    const picked = pickLatestRelease([rel('v2.0.0-beta.1'), rel('v1.19.0-alpha')]);
    assert.equal(picked.tag_name, 'v2.0.0-beta.1');
  });
});
