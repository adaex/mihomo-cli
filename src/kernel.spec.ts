import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  assertTrustedAssetUrl,
  buildGhApiReleaseArgs,
  buildGhDownloadEnv,
  buildGhReleaseDownloadArgs,
  buildKernelCurlArgs,
  buildReleaseApiCurlArgs,
  describeCurlDownloadError,
  findMatchingAsset,
  ghProbeNeeded,
  parseCurlStatusOutput,
  pickLatestRelease,
  resolveDownloadChannels,
  resolveFallbackQueryOptions,
  resolveReleaseQuery,
  translateReleaseApiCurlError,
} from './kernel.js';
import { runModule } from './test-support/cli.js';
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

describe('resolveDownloadChannels（下载通道优先级）', () => {
  const base = { mirror: null, isOverride: false, ghAvailable: false, proxyRunning: false, proxyPort: null, proxyOverride: null };

  it('显式 --mirror 优先于 gh 与代理（手动覆盖最高）', () => {
    const ch = resolveDownloadChannels({
      ...base,
      mirror: 'https://v6.gh-proxy.org/',
      isOverride: true,
      ghAvailable: true,
      proxyRunning: true,
      proxyPort: 7890,
    })[0];
    assert.equal(ch?.kind, 'mirror');
    assert.equal(ch?.kind === 'mirror' && ch.mirror, 'https://v6.gh-proxy.org/');
  });

  it('--mirror direct（isOverride 但 mirror 为 null）强制直连，即使 gh/代理都在', () => {
    const ch = resolveDownloadChannels({
      ...base,
      isOverride: true,
      ghAvailable: true,
      proxyRunning: true,
      proxyPort: 7890,
    })[0];
    assert.equal(ch?.kind, 'direct');
  });

  it('--mirror <镜像> 与 --proxy 可组合：镜像决定 URL，代理只做传输层', () => {
    const ch = resolveDownloadChannels({
      ...base,
      mirror: 'https://cdn.gh-proxy.org/',
      isOverride: true,
      proxyOverride: 'socks5://127.0.0.1:7897',
    })[0];
    assert.equal(ch?.kind, 'mirror');
    assert.equal(ch?.kind === 'mirror' && ch.mirror, 'https://cdn.gh-proxy.org/');
    assert.equal(ch?.kind === 'mirror' && ch.proxy, 'socks5://127.0.0.1:7897');
  });

  it('显式 --proxy 优先于 gh（指定代理的场景往往正是 gh 直连不通）', () => {
    const ch = resolveDownloadChannels({ ...base, ghAvailable: true, proxyOverride: 'http://127.0.0.1:7897' })[0];
    assert.equal(ch?.kind, 'proxy');
    assert.equal(ch?.kind === 'proxy' && ch.proxy, 'http://127.0.0.1:7897');
  });

  it('显式 --proxy 优先于本机自动代理（不与自动通道混用）', () => {
    const ch = resolveDownloadChannels({ ...base, proxyRunning: true, proxyPort: 7890, proxyOverride: 'http://192.168.1.2:7897' })[0];
    assert.equal(ch?.kind, 'proxy');
    assert.equal(ch?.kind === 'proxy' && ch.proxy, 'http://192.168.1.2:7897');
  });

  it('无显式选项、代理在跑时 proxy 首选（gh 退为回退候选）', () => {
    const ch = resolveDownloadChannels({ ...base, ghAvailable: true, proxyRunning: true, proxyPort: 7890 })[0];
    assert.equal(ch?.kind, 'proxy');
    assert.equal(ch?.kind === 'proxy' && ch.proxy, 'http://127.0.0.1:7890');
  });

  it('代理在跑且有 gh 时候选为 [proxy, gh]——gh 带同一个本机代理，只换客户端不换路径（不保证重新选节点，局限见 resolveDownloadChannels 注释）', () => {
    const channels = resolveDownloadChannels({ ...base, ghAvailable: true, proxyRunning: true, proxyPort: 7890 });
    assert.deepEqual(
      channels.map(c => c.kind),
      ['proxy', 'gh'],
    );
    assert.equal(channels[1]?.kind === 'gh' && channels[1].proxy, 'http://127.0.0.1:7890');
  });

  it('代理在跑但无 gh 时候选只有 proxy', () => {
    const channels = resolveDownloadChannels({ ...base, proxyRunning: true, proxyPort: 7890 });
    assert.deepEqual(
      channels.map(c => c.kind),
      ['proxy'],
    );
  });

  it('代理没跑时 gh 为唯一候选且不带代理（入口 env 未被自指污染时的直连）', () => {
    const channels = resolveDownloadChannels({ ...base, ghAvailable: true });
    assert.deepEqual(
      channels.map(c => c.kind),
      ['gh'],
    );
    assert.equal(channels[0]?.kind === 'gh' && channels[0].proxy, undefined);
  });

  it('全无条件时直连', () => {
    assert.equal(resolveDownloadChannels(base)[0]?.kind, 'direct');
  });

  it('显式 --proxy 只有一个候选（显式意图不自动换通道）', () => {
    const channels = resolveDownloadChannels({ ...base, ghAvailable: true, proxyOverride: 'http://127.0.0.1:7897' });
    assert.deepEqual(
      channels.map(c => c.kind),
      ['proxy'],
    );
  });
});

describe('ghProbeNeeded（gh 探测只在参与决策时做）', () => {
  it('默认与显式镜像形态要探测（gh 回退候选 / 无代理时的版本查询认证通道）', () => {
    assert.equal(ghProbeNeeded({ forceDirect: false, proxyOverride: null }), true);
  });

  it('--mirror direct 不探测（查询与下载都不经 gh）', () => {
    assert.equal(ghProbeNeeded({ forceDirect: true, proxyOverride: null }), false);
  });

  it('显式 --proxy 不探测（单候选、查询直接经该代理）', () => {
    assert.equal(ghProbeNeeded({ forceDirect: false, proxyOverride: 'http://127.0.0.1:7897' }), false);
  });
});

describe('resolveFallbackQueryOptions（兜底版本查询与下载通道对齐）', () => {
  it('无代理 gh 通道用 gh api 查', () => {
    assert.deepEqual(resolveFallbackQueryOptions({ kind: 'gh' }), { proxy: null, useGh: true });
  });

  it('带本机代理的 gh 回退候选经该代理查（gh api 无命令行代理选项）', () => {
    assert.deepEqual(resolveFallbackQueryOptions({ kind: 'gh', proxy: 'http://127.0.0.1:7890' }), { proxy: 'http://127.0.0.1:7890', useGh: false });
  });

  it('proxy 通道经代理查', () => {
    assert.deepEqual(resolveFallbackQueryOptions({ kind: 'proxy', proxy: 'http://127.0.0.1:7897' }), { proxy: 'http://127.0.0.1:7897', useGh: false });
  });

  it('mirror 通道：带的代理只做传输层，无代理直连查', () => {
    assert.deepEqual(resolveFallbackQueryOptions({ kind: 'mirror', mirror: 'https://cdn.gh-proxy.org/' }), { proxy: null, useGh: false });
    assert.deepEqual(resolveFallbackQueryOptions({ kind: 'mirror', mirror: 'https://cdn.gh-proxy.org/', proxy: 'http://127.0.0.1:7897' }), {
      proxy: 'http://127.0.0.1:7897',
      useGh: false,
    });
  });

  it('direct 通道绝不经 gh（「强制直连」含 API），直连 fetch 查询', () => {
    // 回归：旧判据 useGh = apiProxy === null 使 direct（与无代理 mirror）的兜底查询
    // 先试 gh api——gh 未装白吃 ENOENT、gh 已装则绕过「不经 gh」的通道语义
    assert.deepEqual(resolveFallbackQueryOptions({ kind: 'direct' }), { proxy: null, useGh: false });
  });
});

describe('resolveReleaseQuery（版本查询出网的正推唯一出口，cmdKernel/doctor 共用）', () => {
  const base = { mirror: null, isOverride: false, ghAvailable: false, proxyRunning: false, proxyPort: null, proxyOverride: null };

  it('全无条件：直连、不经 gh', () => {
    assert.deepEqual(resolveReleaseQuery(base), { proxy: null, useGh: false });
  });

  it('无代理、有 gh：gh 认证查询', () => {
    assert.deepEqual(resolveReleaseQuery({ ...base, ghAvailable: true }), { proxy: null, useGh: true });
  });

  it('本机代理在跑：直接经代理，即使 gh 可用也不试 gh', () => {
    assert.deepEqual(resolveReleaseQuery({ ...base, ghAvailable: true, proxyRunning: true, proxyPort: 7890 }), {
      proxy: 'http://127.0.0.1:7890',
      useGh: false,
    });
  });

  it('代理在跑但端口读损坏（proxyPort=null）：降级为 gh 通道（与 doctor 的损坏降级一致）', () => {
    assert.deepEqual(resolveReleaseQuery({ ...base, ghAvailable: true, proxyRunning: true, proxyPort: null }), {
      proxy: null,
      useGh: true,
    });
  });

  it('显式 --proxy：经该代理，gh 不介入', () => {
    assert.deepEqual(resolveReleaseQuery({ ...base, ghAvailable: true, proxyOverride: 'socks5://127.0.0.1:7897' }), {
      proxy: 'socks5://127.0.0.1:7897',
      useGh: false,
    });
  });

  it('--mirror direct：API 也直连绕过，gh 不介入', () => {
    assert.deepEqual(resolveReleaseQuery({ ...base, mirror: null, isOverride: true, ghAvailable: true, proxyRunning: true, proxyPort: 7890 }), {
      proxy: null,
      useGh: false,
    });
  });

  it('显式镜像（非 direct）+ 本机代理在跑：API 仍经本机代理（镜像只管下载 URL）', () => {
    assert.deepEqual(
      resolveReleaseQuery({ ...base, mirror: 'https://cdn.gh-proxy.org/', isOverride: true, ghAvailable: true, proxyRunning: true, proxyPort: 7890 }),
      { proxy: 'http://127.0.0.1:7890', useGh: false },
    );
  });

  it('显式镜像（非 direct）+ 显式 --proxy：经该代理', () => {
    assert.deepEqual(resolveReleaseQuery({ ...base, mirror: 'https://cdn.gh-proxy.org/', isOverride: true, proxyOverride: 'http://127.0.0.1:7897' }), {
      proxy: 'http://127.0.0.1:7897',
      useGh: false,
    });
  });

  it('分歧锁定：显式镜像无代理时正推走 gh 认证，反推（mirror 通道）答直连——两者输入域不同，别「修」成一致', () => {
    const forward = resolveReleaseQuery({ ...base, mirror: 'https://cdn.gh-proxy.org/', isOverride: true, ghAvailable: true });
    assert.deepEqual(forward, { proxy: null, useGh: true });
    const backward = resolveFallbackQueryOptions({ kind: 'mirror', mirror: 'https://cdn.gh-proxy.org/' });
    assert.deepEqual(backward, { proxy: null, useGh: false });
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

describe('buildGhDownloadEnv（gh 回退的代理注入）', () => {
  const priorHttpsProxy = process.env.HTTPS_PROXY;
  const priorHttpsProxyLower = process.env.https_proxy;
  const priorUnrelated = process.env.HOME;

  it('带 proxy：大小写两种形式都注入，其余 env 保留', () => {
    const env = buildGhDownloadEnv('http://127.0.0.1:7890');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
    assert.equal(env.HOME, priorUnrelated, '继承的其他 env 必须保留');
  });

  it('带 proxy：只返回新对象，不写回 process.env（不污染同进程后续子进程）', () => {
    process.env.HTTPS_PROXY = 'http://ambient.example:1';
    process.env.https_proxy = 'http://ambient.example:1';
    try {
      const env = buildGhDownloadEnv('http://127.0.0.1:7890');
      assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
      assert.equal(process.env.HTTPS_PROXY, 'http://ambient.example:1', 'process.env 不应被改写');
    } finally {
      if (priorHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = priorHttpsProxy;
      if (priorHttpsProxyLower === undefined) delete process.env.https_proxy;
      else process.env.https_proxy = priorHttpsProxyLower;
    }
  });

  it('无 proxy：不新增代理键（独立 gh 候选按环境直连）', () => {
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    try {
      const env = buildGhDownloadEnv(null);
      assert.equal(env.HTTPS_PROXY, undefined);
      assert.equal(env.https_proxy, undefined);
      assert.equal(env.HOME, priorUnrelated);
    } finally {
      if (priorHttpsProxy !== undefined) process.env.HTTPS_PROXY = priorHttpsProxy;
      if (priorHttpsProxyLower !== undefined) process.env.https_proxy = priorHttpsProxyLower;
    }
  });
});

describe('buildKernelCurlArgs', () => {
  const common = { url: 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/mihomo-darwin-arm64.gz', maxBytes: 123, outputPath: '/tmp/x.gz' };

  it('恒含 --proto =https / --proto-redir =https（防协议降级重定向）', () => {
    const args = buildKernelCurlArgs({ ...common, proxy: null });
    const i = args.indexOf('--proto');
    assert.equal(args[i + 1], '=https');
    const j = args.indexOf('--proto-redir');
    assert.equal(args[j + 1], '=https');
  });

  it('恒含 --fail-with-body：镜像 4xx/5xx 错误页不再以退出码 0 落盘', () => {
    const args = buildKernelCurlArgs({ ...common, proxy: null });
    assert.ok(args.includes('--fail-with-body'));
  });

  it('恒含 --speed-limit / --speed-time：劣质节点低速慢传时 20s 快速失败切换通道', () => {
    const args = buildKernelCurlArgs({ ...common, proxy: null });
    const i = args.indexOf('--speed-limit');
    assert.equal(args[i + 1], '50000');
    const j = args.indexOf('--speed-time');
    assert.equal(args[j + 1], '20');
  });

  it('proxy 通道含 -x 且原样透传代理地址（本机端口或显式 --proxy 同一口径）', () => {
    const args = buildKernelCurlArgs({ ...common, proxy: 'socks5://127.0.0.1:7897' });
    const i = args.indexOf('-x');
    assert.equal(args[i + 1], 'socks5://127.0.0.1:7897');
  });

  it('非 proxy 通道不含 -x，且显式 --noproxy *（direct 不静默继承 shell 的 env 代理）', () => {
    const args = buildKernelCurlArgs({ ...common, proxy: null });
    assert.ok(!args.includes('-x'));
    const i = args.indexOf('--noproxy');
    assert.equal(args[i + 1], '*');
  });

  it('proxy 通道不设 --noproxy（-x 与 --noproxy 并存时 noproxy 优先级更高，会废掉代理）', () => {
    const args = buildKernelCurlArgs({ ...common, proxy: 'socks5://127.0.0.1:7897' });
    assert.ok(!args.includes('--noproxy'));
  });

  it('-o 指向输出路径，末位为下载 URL', () => {
    const args = buildKernelCurlArgs({ ...common, proxy: null });
    const i = args.indexOf('-o');
    assert.equal(args[i + 1], '/tmp/x.gz');
    assert.equal(args[args.length - 1], common.url);
  });
});

describe('describeCurlDownloadError（curl 退出码翻译）', () => {
  it('22 = HTTP 错误', () => {
    assert.match(describeCurlDownloadError(22), /HTTP 错误/);
  });

  it('28 = 超时或低速：点明速度过低，不再只给裸退出码', () => {
    const msg = describeCurlDownloadError(28);
    assert.match(msg, /超时/);
    assert.match(msg, /速度过低/);
  });

  it('其他码保留退出码备查', () => {
    assert.match(describeCurlDownloadError(7), /退出码 7/);
  });
});

describe('buildGhApiReleaseArgs（gh 认证路径的 release 查询）', () => {
  it('参数精确：gh api + 官方 releases endpoint，与下载通道同一信任锚', () => {
    assert.deepEqual(buildGhApiReleaseArgs('MetaCubeX/mihomo'), ['api', 'repos/MetaCubeX/mihomo/releases', '--method', 'GET']);
  });
});

describe('buildReleaseApiCurlArgs（代理路径的 release API 查询）', () => {
  const url = 'https://api.github.com/repos/MetaCubeX/mihomo/releases';

  it('恒含 --proto =https / --proto-redir =https（API 全链路 https）', () => {
    const args = buildReleaseApiCurlArgs('http://127.0.0.1:7890', url);
    assert.equal(args[args.indexOf('--proto') + 1], '=https');
    assert.equal(args[args.indexOf('--proto-redir') + 1], '=https');
  });

  it('含 --fail-with-body 与 -w 状态码回传（4xx 不再以退出码 0 混过 JSON 解析）', () => {
    const args = buildReleaseApiCurlArgs('http://127.0.0.1:7890', url);
    assert.ok(args.includes('--fail-with-body'));
    assert.equal(args[args.indexOf('-w') + 1], '\n%{http_code}');
  });

  it('URL 直指 api.github.com 且居末位——API 绝不经过镜像', () => {
    const args = buildReleaseApiCurlArgs('http://127.0.0.1:7890', url);
    assert.equal(args[args.length - 1], url);
    assert.ok(url.startsWith('https://api.github.com/'));
  });

  it('-x 原样透传代理地址（显式 --proxy 与本机混合端口同一路径）', () => {
    const args = buildReleaseApiCurlArgs('http://192.168.1.2:7897', url);
    assert.equal(args[args.indexOf('-x') + 1], 'http://192.168.1.2:7897');
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

  it('rc 后缀（上游未勾 prerelease 位时的形态）同样过滤——版本对账对不上 rc，装上必报不匹配', () => {
    const picked = pickLatestRelease([rel('v1.19.31-rc.2'), rel('v1.19.30')]);
    assert.equal(picked.tag_name, 'v1.19.30');
  });

  it('全是预发布时抛错，不回退首个（回退等于静默把 alpha 当稳定版装上）', () => {
    assert.throws(() => pickLatestRelease([rel('v2.0.0-beta.1'), rel('v1.19.0-alpha')]), /未找到稳定版内核/);
  });

  it('prerelease 字段为真但 tag 名干净时同样不当稳定版', () => {
    assert.throws(() => pickLatestRelease([rel('v2.0.0', true)]), /未找到稳定版内核/);
  });
});

describe('assertTrustedAssetUrl（来源钉死是主要防线，上游无 checksums）', () => {
  // 产物随后 chmod 755 且以 root 运行：白名单被放宽/误删时这里必须红
  const url = (host: string) => `https://${host}/MetaCubeX/mihomo/releases/download/v1.19.30/mihomo.gz`;

  it('github.com 与 api/objects/release-assets 变体放行（GitHub 资产的真实落点）', () => {
    for (const host of ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']) {
      assert.doesNotThrow(() => assertTrustedAssetUrl(url(host)), host);
    }
  });

  it('非白名单主机拒绝（被篡改的 browser_download_url 不能让 CLI 下载任意二进制）', () => {
    assert.throws(() => assertTrustedAssetUrl(url('evil.example.com')), /不在白名单内/);
    assert.throws(() => assertTrustedAssetUrl(url('github.com.evil.io')), /不在白名单内/);
  });

  it('明文 http 拒绝（镜像注入的降级地址）', () => {
    assert.throws(() => assertTrustedAssetUrl('http://github.com/x.gz'), /必须是 https/);
  });

  it('无法解析的地址拒绝', () => {
    assert.throws(() => assertTrustedAssetUrl('not a url'), /无法解析/);
  });
});

describe('downloadKernel：下载后完整性闸门（子进程 + PATH 桩 curl/gzip 端到端）', () => {
  /**
   * 大小对账 / 自检 / 版本对账是防恶意镜像的最后几道闸，此前全模块零覆盖——
   * 把 `actual !== asset.size` 放宽成 `>=` 或误删白名单 host，测试全绿直接发版。
   * 桩 curl 按 env 写出指定字节数（绕过网络），桩 gzip 按 env 输出「二进制」内容
   * （一段 -v 时输出版本号的 shell 脚本），真实跑完下载→解压→自检→对账→原子替换链。
   * MIHOMO_CLI_DIR 隔离数据目录；预摆旧内核断言「失败时旧内核未受影响」。
   */
  function runKernelDownloadCase(opts: {
    assetSize: number;
    curlBody: string;
    binaryContent: string;
    downloadUrl?: string;
    preExisting?: string;
    channel?: { kind: 'direct' } | { kind: 'mirror'; mirror: string };
  }): {
    stdout: string;
    stderr: string;
    /** 桩 curl 是否被调用过（白名单用例断言拒绝先于下载） */
    curlCalled: boolean;
  } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-kernel-gate-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-kernel-gate-bin-'));
    const kernelPath = path.resolve('src/kernel.ts');
    const script = [
      "import fs from 'node:fs';",
      `const { downloadKernel } = await import(${JSON.stringify(kernelPath)});`,
      'const dir = process.env.MIHOMO_CLI_DIR;',
      "fs.mkdirSync(dir + '/kernel', { recursive: true });",
      opts.preExisting !== undefined ? `fs.writeFileSync(dir + '/kernel/mihomo', ${JSON.stringify(JSON.stringify(opts.preExisting))});` : '',
      'const releaseInfo = {',
      "  tag_name: 'v1.19.30',",
      '  assets: [{',
      '    name: `mihomo-darwin-${process.arch}-v1.19.30.gz`,',
      `    browser_download_url: ${JSON.stringify(opts.downloadUrl ?? `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/mihomo-darwin-${process.arch}-v1.19.30.gz`)},`,
      `    size: ${opts.assetSize},`,
      '  }],',
      '};',
      'try {',
      `  await downloadKernel(null, ${JSON.stringify(opts.channel ?? { kind: 'direct' })}, releaseInfo);`,
      "  console.log('RESULT:NO-THROW');",
      '} catch (e) {',
      "  console.log('RESULT:' + JSON.stringify({ message: e.message }));",
      '}',
      "const mihomo = dir + '/kernel/mihomo';",
      "console.log('BINARY_NOW:' + JSON.stringify(fs.existsSync(mihomo) ? fs.readFileSync(mihomo, 'utf8') : '<absent>'));",
    ].join('\n');
    try {
      fs.writeFileSync(
        path.join(fakeBin, 'curl'),
        `#!/bin/bash
printf '' > "$MIHOMO_TEST_CURL_MARKER"
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
printf '%s' "$MIHOMO_TEST_CURL_BODY" > "$out"
exit 0
`,
      );
      fs.chmodSync(path.join(fakeBin, 'curl'), 0o755);
      fs.writeFileSync(
        path.join(fakeBin, 'gzip'),
        `#!/bin/bash
# 只认 -dc <file> 形态；输出内容由 env 控制
printf '%s' "$MIHOMO_TEST_BINARY_CONTENT"
exit 0
`,
      );
      fs.chmodSync(path.join(fakeBin, 'gzip'), 0o755);
      const r = runModule(script, dataDir, {
        env: {
          PATH: `${fakeBin}:${process.env.PATH}`,
          MIHOMO_TEST_CURL_BODY: opts.curlBody,
          MIHOMO_TEST_BINARY_CONTENT: opts.binaryContent,
          MIHOMO_TEST_CURL_MARKER: path.join(dataDir, 'curl-called'),
        },
        timeout: 30_000,
      });
      assert.equal(r.status, 0, r.stderr);
      return { stdout: r.stdout, stderr: r.stderr, curlCalled: fs.existsSync(path.join(dataDir, 'curl-called')) };
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  }

  const resultLineOf = (stdout: string) => stdout.split('\n').find(l => l.startsWith('RESULT:')) ?? '';
  const binaryLineOf = (stdout: string) => stdout.split('\n').find(l => l.startsWith('BINARY_NOW:')) ?? '';

  it('大小与 release 元数据不符（截断/偷换）拒收，旧内核分毫未动', () => {
    const { stdout } = runKernelDownloadCase({ assetSize: 100, curlBody: 'abc', binaryContent: '', preExisting: 'OLD-KERNEL' });
    assert.match(resultLineOf(stdout), /大小与 release 元数据不符/);
    assert.match(resultLineOf(stdout), /期望 100 字节，实际 3 字节/);
    assert.match(binaryLineOf(stdout), /OLD-KERNEL/, '失败时旧内核必须原样保留');
  });

  it('自检失败（二进制损坏/架构不符）拒收，旧内核未受影响', () => {
    const { stdout } = runKernelDownloadCase({ assetSize: 3, curlBody: 'abc', binaryContent: '#!/bin/sh\nexit 1\n', preExisting: 'OLD-KERNEL' });
    assert.match(resultLineOf(stdout), /内核自检失败/);
    assert.match(binaryLineOf(stdout), /OLD-KERNEL/);
  });

  it('版本不匹配（镜像返回旧资产）拒收：报已更新但二进制没变的形态不可达', () => {
    const { stdout } = runKernelDownloadCase({
      assetSize: 3,
      curlBody: 'abc',
      binaryContent: '#!/bin/sh\necho "Mihomo Meta v9.9.9 darwin"\n',
      preExisting: 'OLD-KERNEL',
    });
    assert.match(resultLineOf(stdout), /内核版本不匹配（期望 1\.19\.30，实际 9\.9\.9）/);
    assert.match(binaryLineOf(stdout), /OLD-KERNEL/);
  });

  it('白名单外的资产地址在下载前即拒（校验先于任何写盘）', () => {
    const { stdout, curlCalled } = runKernelDownloadCase({
      assetSize: 3,
      curlBody: 'abc',
      binaryContent: '',
      downloadUrl: 'https://evil.example.com/mihomo.gz',
      preExisting: 'OLD-KERNEL',
    });
    assert.match(resultLineOf(stdout), /不在白名单内/);
    assert.match(binaryLineOf(stdout), /OLD-KERNEL/);
    // 校验先于下载：白名单拒绝时 curl 一次都不能被调用（不向未知 host 发请求）
    assert.equal(curlCalled, false, '白名单外的地址不得发起下载');
  });

  it('全链通过时原子替换：新内核为解压产物', () => {
    const { stdout } = runKernelDownloadCase({
      assetSize: 3,
      curlBody: 'abc',
      binaryContent: '#!/bin/sh\necho "Mihomo Meta v1.19.30 darwin"\n',
      preExisting: 'OLD-KERNEL',
    });
    assert.match(resultLineOf(stdout), /NO-THROW/);
    assert.match(binaryLineOf(stdout), /v1\.19\.30/);
    assert.doesNotMatch(binaryLineOf(stdout), /OLD-KERNEL/);
  });

  it('mirror 通道遇非 github.com 资产地址：照常直连下载，但点破「镜像未起作用」', () => {
    // 上游若迁移资产 host（如 release-assets），显式 --mirror 会静默退化成直连——
    // 被墙网络下只见超时、无任何线索，必须警告
    const { stdout, stderr } = runKernelDownloadCase({
      assetSize: 3,
      curlBody: 'abc',
      binaryContent: '#!/bin/sh\necho "Mihomo Meta v1.19.30 darwin"\n',
      downloadUrl: 'https://release-assets.githubusercontent.com/MetaCubeX/mihomo/releases/download/v1.19.30/mihomo.gz',
      channel: { kind: 'mirror', mirror: 'https://gh-proxy.org/' },
    });
    assert.match(resultLineOf(stdout), /NO-THROW/);
    assert.match(stderr, /镜像前缀未能作用/);
  });
});
