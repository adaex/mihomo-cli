import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildGhReleaseDownloadArgs,
  buildKernelCurlArgs,
  buildReleaseApiCurlArgs,
  findMatchingAsset,
  MAX_EXTRACTED_BYTES,
  parseCurlStatusOutput,
  parseTarEntrySize,
  pickLatestRelease,
  resolveDownloadChannel,
  translateReleaseApiCurlError,
} from './kernel.js';
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
  const base = { mirror: null, isOverride: false, ghAvailable: false, proxyRunning: false, proxyPort: null };

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

  it('--mirror direct（isOverride 但 mirror 为 null）强制直连，即使 gh/代理都在', () => {
    const ch = resolveDownloadChannel({
      ...base,
      isOverride: true,
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

  it('无 gh 时走代理，且端口透传', () => {
    const ch = resolveDownloadChannel({ ...base, proxyRunning: true, proxyPort: 7890 });
    assert.equal(ch.kind, 'proxy');
    assert.equal(ch.kind === 'proxy' && ch.port, 7890);
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

  it('恒含 --fail-with-body：镜像 4xx/5xx 错误页不再以退出码 0 落盘', () => {
    const args = buildKernelCurlArgs({ ...common, proxyPort: null });
    assert.ok(args.includes('--fail-with-body'));
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

describe('parseTarEntrySize（tar -tv 列表的解压总量护栏）', () => {
  // bsdtar（macOS 自带）：perms links owner group size date ...
  const bsdtarLine = '-rwxr-xr-x  0 501    20  34567890 Jan  1  2024 mihomo';
  // GNU tar：perms owner/group size date time name
  const gnuLine = '-rwxr-xr-x root/root       34567890 2024-01-01 00:00 mihomo';

  it('bsdtar 与 GNU 两种布局都解析出第 5/3 列大小', () => {
    assert.equal(parseTarEntrySize(bsdtarLine), 34567890);
    assert.equal(parseTarEntrySize(gnuLine), 34567890);
  });

  it('目录行按 0 计，不把日期列误当大小', () => {
    assert.equal(parseTarEntrySize('drwxr-xr-x  0 501    20         0 Jan  1  2024 mihomo'), 0);
    assert.equal(parseTarEntrySize('drwxr-xr-x root/root            0 2024-01-01 00:00 dir'), 0);
  });

  it('汇总超过 MAX_EXTRACTED_BYTES 可被调用方检出（压缩炸弹场景）', () => {
    // 行为断言放在纯累加层：每条 300MB、两条即超 512MB 上限
    const total = [
      parseTarEntrySize(bsdtarLine.replace('34567890', String(300 * 1024 * 1024))),
      parseTarEntrySize(bsdtarLine.replace('34567890', String(300 * 1024 * 1024))),
    ]
      .filter((n): n is number => n !== null)
      .reduce((a, b) => a + b, 0);
    assert.ok(total > MAX_EXTRACTED_BYTES);
  });

  it('无法解析的行返回 null 而非 NaN', () => {
    assert.equal(parseTarEntrySize(''), null);
    assert.equal(parseTarEntrySize('garbage line'), null);
  });
});

describe('buildReleaseApiCurlArgs（代理路径的 release API 查询）', () => {
  const url = 'https://api.github.com/repos/MetaCubeX/mihomo/releases';

  it('恒含 --proto =https / --proto-redir =https（API 全链路 https）', () => {
    const args = buildReleaseApiCurlArgs(7890, url);
    assert.equal(args[args.indexOf('--proto') + 1], '=https');
    assert.equal(args[args.indexOf('--proto-redir') + 1], '=https');
  });

  it('含 --fail-with-body 与 -w 状态码回传（4xx 不再以退出码 0 混过 JSON 解析）', () => {
    const args = buildReleaseApiCurlArgs(7890, url);
    assert.ok(args.includes('--fail-with-body'));
    assert.equal(args[args.indexOf('-w') + 1], '\n%{http_code}');
  });

  it('URL 直指 api.github.com 且居末位——API 绝不经过镜像', () => {
    const args = buildReleaseApiCurlArgs(7890, url);
    assert.equal(args[args.length - 1], url);
    assert.ok(url.startsWith('https://api.github.com/'));
  });

  it('-x 指向本机混合端口', () => {
    const args = buildReleaseApiCurlArgs(7890, url);
    assert.equal(args[args.indexOf('-x') + 1], 'http://127.0.0.1:7890');
  });
});

describe('parseCurlStatusOutput（-w 追加的状态码拆解）', () => {
  it('拆出响应体与末行状态码', () => {
    assert.deepEqual(parseCurlStatusOutput('[{"tag_name":"v1.19.30"}]\n200'), { body: '[{"tag_name":"v1.19.30"}]', statusCode: 200 });
  });

  it('空错误体（如 403 无 body）也能取到状态码', () => {
    assert.deepEqual(parseCurlStatusOutput('\n403'), { body: '', statusCode: 403 });
  });

  it('无状态码行（输出截断/早期失败）statusCode 为 null，原文保留为 body', () => {
    assert.deepEqual(parseCurlStatusOutput('{"partial":'), { body: '{"partial":', statusCode: null });
    assert.deepEqual(parseCurlStatusOutput(''), { body: '', statusCode: null });
  });

  it('000（未收到 HTTP 响应）视为无状态码', () => {
    assert.deepEqual(parseCurlStatusOutput('\n000'), { body: '', statusCode: null });
  });
});

describe('translateReleaseApiCurlError（代理路径 4xx 诊断对齐直连）', () => {
  it('退出码 22 + 状态码 + GitHub 错误体 → 与直连路径同形的 HTTP 错误', () => {
    const body = JSON.stringify({
      message: 'API rate limit exceeded for 203.0.113.7.',
      documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
    });
    const error = translateReleaseApiCurlError({ code: 22, stdout: `${body}\n403` });
    const withResponse = error as Error & { response: { status: number; data?: { message?: string; documentation_url?: string } } };
    assert.equal(error.message, 'HTTP 403');
    assert.equal(withResponse.response.status, 403);
    assert.equal(withResponse.response.data?.message, 'API rate limit exceeded for 203.0.113.7.');
    assert.equal(withResponse.response.data?.documentation_url, 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting');
  });

  it('退出码 22 但拿不到状态码（无 -w 输出）回退退出码口径', () => {
    assert.match(translateReleaseApiCurlError({ code: 22, stdout: '' }).message, /curl 退出码 22/);
  });

  it('ENOENT → 安装提示', () => {
    assert.equal(translateReleaseApiCurlError({ code: 'ENOENT' }).message, '未找到 curl 命令，请先安装 curl 后重试');
  });

  it('超时被终止（execFile timeout 兜底，000 无状态码）→ 超时信息', () => {
    const error = translateReleaseApiCurlError({ code: null, killed: true, signal: 'SIGTERM', stdout: '\n000' });
    assert.match(error.message, /130s 未完成/);
  });

  it('网络错误退出码保留原口径（含 stderr 末行剥离）', () => {
    assert.match(translateReleaseApiCurlError({ code: 7, stderr: '' }).message, /curl 退出码 7/);
    assert.match(
      translateReleaseApiCurlError({ code: 7, stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 7890' }).message,
      /Failed to connect to 127.0.0.1 port 7890/,
    );
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

  it('全是预发布时抛错，不回退首个（回退等于静默把 alpha 当稳定版装上）', () => {
    assert.throws(() => pickLatestRelease([rel('v2.0.0-beta.1'), rel('v1.19.0-alpha')]), /未找到稳定版内核/);
  });

  it('prerelease 字段为真但 tag 名干净时同样不当稳定版', () => {
    assert.throws(() => pickLatestRelease([rel('v2.0.0', true)]), /未找到稳定版内核/);
  });
});
