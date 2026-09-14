import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * sub 的选项白名单按子命令校验（此前分发前对全组放行同一份白名单）：
 * `sub add <url> <name> -y` 被接受但 add 不读 -y，非 TTY 下静默取消。
 * 选项一律用空格形式（`-u 30000`）：紧贴值形式的解析由另一分支统一处理。
 */
function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-sub-'));
  const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
  try {
    assert.ok(dataDir.startsWith(os.tmpdir()));
    // sub use 会经 isRestartNeededOnChange 查服务状态：label 必须隔离，
    // 测试只能查询不存在的服务（不触碰真实 launchd 注册）
    assert.equal(fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        subscriptions: [
          { name: 'alpha', url: 'https://example.com/alpha' },
          { name: 'beta', url: 'https://example.com/beta' },
        ],
        active_subscription: 'alpha',
      }),
    );
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label, NO_COLOR: '1' },
      });
    check(dataDir, run);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 读回 fixture 的 settings，断言最终数据状态而非只看退出码 */
function readSettings(dataDir: string): { subscriptions?: { name: string }[]; active_subscription?: string } {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
}

describe('sub 的选项白名单按子命令校验', () => {
  describe('外来选项在进入 handler 前被拒', () => {
    it('add 不接受 -s，提示给出 add 自己的用法', () =>
      withFixture((_dataDir, run) => {
        const result = run(['sub', 'add', '-s']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的选项: -s/);
        assert.match(result.stderr, /用法: mihomo sub add <url> \[name\]/);
      }));

    it('add 的 -y 不再被静默吞掉（缺陷场景：曾被接受但 add 不读 -y）', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'add', 'https://example.com/sub', 'newsub', '-y']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的选项: -y/);
        // 校验先于 handler：不得入库半成品订阅
        assert.equal(readSettings(dataDir).subscriptions?.length, 2);
      }));

    it('update 不接受 -y', () =>
      withFixture((_dataDir, run) => {
        const result = run(['sub', 'update', '-y']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的选项: -y/);
        assert.match(result.stderr, /用法: mihomo sub update \[name\]/);
      }));

    it('remove 不接受 -u，提示只列 remove 可用的选项', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'remove', 'alpha', '-u', '30000']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的选项: -u/);
        assert.match(result.stderr, /可用选项: -y, --yes/);
        assert.match(result.stderr, /用法: mihomo sub remove <name>/);
        assert.equal(readSettings(dataDir).subscriptions?.length, 2, '拒绝时不得删除订阅');
      }));

    it('use 不接受 -y，提示只列重启透传选项', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'use', 'beta', '-y']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的选项: -y/);
        assert.match(result.stderr, /可用选项: -s, --no-update, -u, --update-timeout/);
        assert.equal(readSettings(dataDir).active_subscription, 'alpha', '拒绝时不得切换订阅');
      }));
  });

  describe('各子命令接受自己的合法选项（空格形式）', () => {
    it('use 接受 -s 并完成切换', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'use', 'beta', '-s']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readSettings(dataDir).active_subscription, 'beta');
      }));

    it('use 接受 -u 30000，带值选项的值不被误当名称', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'use', 'beta', '-u', '30000']);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readSettings(dataDir).active_subscription, 'beta');
      }));

    it('remove 的 -y 在非交互下跳过模糊匹配确认', () =>
      withFixture((dataDir, run) => {
        // 无 -y 时非 TTY 必须拒绝（不能静默当成确认通过）
        const refused = run(['sub', 'remove', 'bet']);
        assert.equal(refused.status, 1, refused.stderr);
        assert.equal(readSettings(dataDir).subscriptions?.length, 2);
        // -y 被真实消费：模糊匹配删除直接执行
        const result = run(['sub', 'remove', 'bet', '-y']);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          readSettings(dataDir).subscriptions?.map(s => s.name),
          ['alpha'],
        );
      }));

    it('remove 允许 -y 出现在名称之前', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'remove', '-y', 'beta']);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
          readSettings(dataDir).subscriptions?.map(s => s.name),
          ['alpha'],
        );
      }));
  });

  describe('分发行为不回归', () => {
    it('裸 sub 列出订阅', () =>
      withFixture((_dataDir, run) => {
        const result = run(['sub']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /alpha/);
        assert.match(result.stdout, /beta/);
      }));

    it('未知子命令仍报错', () =>
      withFixture((_dataDir, run) => {
        const result = run(['sub', 'bogus']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的订阅命令: bogus/);
      }));

    it('子命令位置的选项按未知选项报错（裸 sub 不接受选项）', () =>
      withFixture((_dataDir, run) => {
        const result = run(['sub', '-q']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的选项: -q/);
      }));

    it('未知 flag 对合法子命令仍报错', () =>
      withFixture((_dataDir, run) => {
        const result = run(['sub', 'use', 'beta', '--bogus-flag']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /未知的选项: --bogus-flag/);
      }));
  });

  describe('重启透传选项即使不重启也被校验（未运行时不能静默吞掉）', () => {
    it('use 的 -u 缺值报错，且不切换订阅', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'use', 'beta', '-u']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /选项 -u 缺少值/);
        assert.equal(readSettings(dataDir).active_subscription, 'alpha');
      }));

    it('use 的 -u5s（非法值）报错', () =>
      withFixture((dataDir, run) => {
        const result = run(['sub', 'use', 'beta', '-u5s']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /需要正整数/);
        assert.equal(readSettings(dataDir).active_subscription, 'alpha');
      }));
  });

  describe('空串参数不当作缺省', () => {
    it('sub update "" 报「请指定名称」，不静默更新所有订阅（不触网）', () =>
      withFixture((_dataDir, run) => {
        const result = run(['sub', 'update', '']);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /请指定订阅名称/);
      }));
  });
});

/**
 * 批量更新的部分失败反馈：逐条结果之外必须有汇总，且退出码非 0——
 * 此前 2/3 成功时退出 0，脚本与用户都发现不了那条失败。用本地 HTTP 桩，不碰外网。
 */
describe('sub update 批量结果', () => {
  it('部分失败时给汇总、非零退出、逐条重试命令；成功的订阅照常落盘', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-sub-batch-'));
    const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
    fs.mkdirSync(path.join(dataDir, 'subscriptions'));

    const server = http.createServer((req, res) => {
      if (req.url === '/alpha') {
        res.writeHead(200, { 'Content-Type': 'text/yaml' });
        res.end('proxies:\n  - { name: A, type: direct }\n');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('server error');
      }
    });

    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      fs.writeFileSync(
        path.join(dataDir, 'settings.json'),
        JSON.stringify({
          subscriptions: [
            { name: 'alpha', url: `http://127.0.0.1:${port}/alpha` },
            { name: 'beta', url: `http://127.0.0.1:${port}/beta` },
          ],
          active_subscription: 'alpha',
        }),
      );

      const env: NodeJS.ProcessEnv = { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label, NO_COLOR: '1' };
      // 子进程不得继承任何外部代理设置（经外部代理访问 127.0.0.1 会失败）
      for (const k of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) delete env[k];

      // 必须用**异步** spawn：桩 server 与测试同进程，spawnSync 会阻塞事件循环，
      // server 无法 accept，子进程的 fetch 挂到超时——父子死锁
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), 'sub', 'update'], { env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => {
        stdout += d;
      });
      child.stderr.on('data', d => {
        stderr += d;
      });
      const status = await new Promise<number | null>(resolve => child.on('close', resolve));

      assert.notEqual(status, 0, '部分失败必须非零退出');
      assert.match(stdout, /✓ alpha: 已更新/);
      assert.match(stdout, /✗ beta: 失败/);
      assert.match(stdout, /更新完成: 1 个成功，1 个失败/);
      assert.match(stderr, /1 个订阅更新失败: beta/);
      assert.match(stderr, /重试: mihomo sub update beta/);
      assert.ok(fs.existsSync(path.join(dataDir, 'subscriptions', 'alpha.yaml')), '成功的订阅必须照常落盘');
      assert.ok(!fs.existsSync(path.join(dataDir, 'subscriptions', 'beta.yaml')), '失败不得留下半成品');
    } finally {
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
