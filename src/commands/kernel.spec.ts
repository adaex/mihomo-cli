import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import { describe, it } from 'node:test';
import type { DownloadChannel } from '../kernel.js';
import { makeFixture, runCli as runCliFixture } from '../test-support/cli.js';
import { buildDownloadFailureError, channelLabel, formatChannelSwitchLine, printChannelLine } from './kernel.js';

function runCli(args: string[]): SpawnSyncReturns<string> {
  const fixture = makeFixture('mihomo-kernel-cli');
  try {
    // 真网络场景（kernel update 不带下载参数）给足 30s
    return runCliFixture(args, fixture, { timeout: 30_000 });
  } finally {
    fixture.cleanup();
  }
}

describe('kernel 命令：版本查询失败的提示分档', () => {
  it('镜像 + 代理组合查询失败：提示检查代理并说明镜像不碰 API', () => {
    // 回归：显式 --mirror 用户的版本查询失败曾被整体压制（提示补给的 else if 以
    // !mirrorInfo.mirror 为条件，镜像用户两个提示块都进不去），只剩裸「更新失败」。
    // 镜像只作用于内核下载，版本查询按设计直连 GitHub API——失败与镜像无关，
    // 出路是检查代理本身。127.0.0.1:1 连接即拒，不依赖外网
    const r = runCli(['kernel', '--mirror', 'cdn', '--proxy', '127.0.0.1:1']);

    assert.notEqual(r.status, 0, '查询失败应非 0 退出');
    assert.match(r.stderr, /版本查询（GitHub API）经代理失败/, `应给出可执行指引而非裸报错，stderr: ${r.stderr}`);
    assert.match(r.stderr, /镜像只作用于内核下载，与查询无关/);
  });
});

describe('通道展示与失败汇总的措辞', () => {
  /** 捕获 console.log 的输出行，测完即还原 */
  function captureLog(fn: () => void): string[] {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      fn();
    } finally {
      console.log = original;
    }
    return lines;
  }

  it('channelLabel：本机代理候选在失败汇总里也称「本机代理」（与头部行一致）', () => {
    assert.equal(channelLabel({ kind: 'proxy', proxy: 'http://127.0.0.1:7890' }, false), '本机代理 http://127.0.0.1:7890');
    assert.equal(channelLabel({ kind: 'proxy', proxy: 'http://127.0.0.1:7897' }, true), '代理 http://127.0.0.1:7897');
  });

  it('channelLabel：gh 回退候选的代理与本机 Mixed 端口同措辞（能看出与首选同一路径）', () => {
    assert.equal(channelLabel({ kind: 'gh', proxy: 'http://127.0.0.1:7890' }, false), 'gh（经本机代理 http://127.0.0.1:7890）');
    assert.equal(channelLabel({ kind: 'gh' }, false), 'gh');
  });

  it('printChannelLine：direct 通道不打印任何行（含尾部空行）', () => {
    const lines = captureLog(() => printChannelLine({ kind: 'direct' }, false));
    assert.deepEqual(lines, []);
  });

  it('printChannelLine：proxy 通道打印头部行与一个尾部空行', () => {
    const lines = captureLog(() => printChannelLine({ kind: 'proxy', proxy: 'http://127.0.0.1:7890' }, false));
    assert.deepEqual(lines, ['下载通道: 本机代理 http://127.0.0.1:7890', '']);
  });
});

describe('formatChannelSwitchLine（切换通道时带上失败原因）', () => {
  it('带原因首行：中途成功后该原因不再出现在任何输出里，必须在此处给用户', () => {
    assert.equal(
      formatChannelSwitchLine(new Error('下载失败: 连接或传输超时：节点可能不可用、速度过低或被限速')),
      '上一通道失败（下载失败: 连接或传输超时：节点可能不可用、速度过低或被限速），切换为:',
    );
  });

  it('多行错误只取首行（失败明细由全失败分支完整给出）', () => {
    assert.equal(formatChannelSwitchLine(new Error('第一行\n第二行')), '上一通道失败（第一行），切换为:');
  });

  it('无错误对象时退回无原因形态', () => {
    assert.equal(formatChannelSwitchLine(null), '上一通道失败，切换为:');
  });
});

describe('buildDownloadFailureError（全失败错误分档）', () => {
  it('单候选（显式 --mirror/--proxy/direct）：原始错误作主消息，不套「全部通道均失败」与换节点话术', () => {
    const attempts = [
      {
        channel: { kind: 'mirror', mirror: 'https://cdn.gh-proxy.org/' } as DownloadChannel,
        error: new Error('下载失败: 镜像或服务器返回 HTTP 错误（4xx/5xx）'),
      },
    ];
    const err = buildDownloadFailureError(attempts, false);
    assert.equal(err.message, '下载失败: 镜像或服务器返回 HTTP 错误（4xx/5xx）');
    assert.ok(!err.hint.join('\n').includes('全部下载通道均失败'));
    assert.ok(!err.hint.join('\n').includes('Default Proxy'), '单候选运行的换节点话术不适用');
    assert.ok(err.hint.join('\n').includes('--proxy'), '应给出改用其他通道的出路');
  });

  it('多候选：通道清单逐条带原因首行，保留换节点指引', () => {
    const attempts = [
      {
        channel: { kind: 'proxy', proxy: 'http://127.0.0.1:7890' } as DownloadChannel,
        error: new Error('下载失败: 连接或传输超时：节点可能不可用、速度过低或被限速'),
      },
      { channel: { kind: 'gh', proxy: 'http://127.0.0.1:7890' } as DownloadChannel, error: new Error('下载超时（gh 100s 未完成）') },
    ];
    const err = buildDownloadFailureError(attempts, false);
    assert.equal(err.message, '全部下载通道均失败');
    const hint = err.hint.join('\n');
    assert.match(hint, /本机代理 http:\/\/127\.0\.0\.1:7890: 下载失败: 连接或传输超时/);
    assert.match(hint, /gh（经本机代理 http:\/\/127\.0\.0\.1:7890）: 下载超时/);
    assert.match(hint, /Default Proxy/);
  });
});
