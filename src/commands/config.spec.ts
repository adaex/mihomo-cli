import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CONFIG_GRAPH_MAX_EXPANDED_NODES } from '../config-graph.js';
import { makeFixture, runCli } from '../test-support/cli.js';

/**
 * `mihomo-cli config` 凭据脱敏与缺文件提示（CLI 级）。
 * 脱敏规则的单元覆盖在 redact.spec.ts，这里锁命令接线：默认上屏的是掩码、
 * --reveal 才给原文、JSON 信封带 redacted，以及缺文件时三处口径统一指向 sub update。
 */
const SUBSCRIPTION = [
  'proxies:',
  '  - { name: HK-1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: realpassword }',
  'proxy-providers:',
  '  second: { type: http, url: "https://sub.example.com/api?token=tokentokentoken1234", interval: 3600, path: ./second.yaml }',
  'proxy-groups:',
  '  - { name: PROXY, type: select, proxies: [HK-1] }',
  'rules:',
  '  - MATCH,PROXY',
  '',
].join('\n');

function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const fixture = makeFixture('mihomo-config-cli');
  const { dataDir } = fixture;
  try {
    fs.mkdirSync(path.join(dataDir, 'subscriptions'));
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ subscriptions: [{ name: 'demo', url: 'https://example.com/sub' }], active_subscription: 'demo' }),
    );
    fs.writeFileSync(path.join(dataDir, 'subscriptions', 'demo.yaml'), SUBSCRIPTION);
    const run = (args: string[]) => runCli(args, fixture);
    check(dataDir, run);
  } finally {
    fixture.cleanup();
  }
}

describe('config：凭据默认脱敏', () => {
  it('YAML 出口掩码节点密码与 provider URL token，并提示 --reveal', () => {
    withFixture((_d, run) => {
      const out = run(['config']).stdout;
      assert.match(out, /password: '\*\*\*'/);
      assert.ok(!out.includes('realpassword'), '节点密码不得明文上屏');
      assert.match(out, /token=\*\*\*/);
      assert.ok(!out.includes('tokentokentoken1234'), 'provider 订阅 token 不得明文上屏');
      assert.match(out, /凭据已脱敏显示，--reveal/);
      assert.match(out, /# 配置预览：未写盘、未校验、未应用/);
      assert.ok(!out.includes('与 start 写入 runtime/config.yaml 的内容一致'), '预览不得承诺等于下一次 start 的结果');
    });
  });

  it('--reveal 显示原文且不带脱敏提示', () => {
    withFixture((_d, run) => {
      const out = run(['config', '--reveal']).stdout;
      assert.match(out, /password: realpassword/);
      assert.match(out, /token=tokentokentoken1234/);
      assert.ok(!out.includes('凭据已脱敏'));
    });
  });

  it('JSON 信封带 redacted 标记；--reveal 时为 false', () => {
    withFixture((_d, run) => {
      const masked = JSON.parse(run(['config', '--json']).stdout);
      assert.equal(masked.redacted, true);
      assert.equal(masked.config.proxies[0].password, '***');
      assert.match(JSON.stringify(masked.config['proxy-providers']), /\*\*\*/);

      const revealed = JSON.parse(run(['config', '--json', '--reveal']).stdout);
      assert.equal(revealed.redacted, false);
      assert.equal(revealed.config.proxies[0].password, 'realpassword');
    });
  });

  it('普通共享别名在 YAML/JSON 与 --reveal 下都可展示', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(
        path.join(dataDir, 'subscriptions', 'demo.yaml'),
        ['common: &common', '  password: shared-real-password', '  server: 127.0.0.1', 'first: *common', 'second: *common', 'proxies: []', ''].join('\n'),
      );

      const maskedYaml = run(['config']);
      assert.equal(maskedYaml.status, 0, maskedYaml.stderr);
      assert.ok(!maskedYaml.stdout.includes('shared-real-password'));
      assert.match(maskedYaml.stdout, /password: '\*\*\*'/);

      const revealedYaml = run(['config', '--reveal']);
      assert.equal(revealedYaml.status, 0, revealedYaml.stderr);
      assert.match(revealedYaml.stdout, /common: &ref_\d+/);
      assert.match(revealedYaml.stdout, /first: \*ref_\d+/);
      assert.match(revealedYaml.stdout, /password: shared-real-password/);

      const maskedJson = JSON.parse(run(['config', '--json']).stdout);
      assert.equal(maskedJson.config.first.password, '***');
      assert.equal(maskedJson.config.second.password, '***');
      assert.equal(maskedJson.redacted, true);

      const revealedJsonResult = run(['config', '--json', '--reveal']);
      assert.equal(revealedJsonResult.status, 0, revealedJsonResult.stderr);
      const revealedJson = JSON.parse(revealedJsonResult.stdout);
      assert.equal(revealedJson.config.first.password, 'shared-real-password');
      assert.equal(revealedJson.config.second.password, 'shared-real-password');
      assert.equal(revealedJson.redacted, false);
    });
  });

  it('循环 YAML 在默认、JSON 与 reveal 组合下都报可读配置错误', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'subscriptions', 'demo.yaml'), 'loop: &loop\n  self: *loop\n');
      for (const args of [[], ['--json'], ['--reveal'], ['--json', '--reveal']]) {
        const r = run(['config', ...args]);
        const output = `${r.stdout}${r.stderr}`;
        assert.notEqual(r.status, 0, `config ${args.join(' ')} 不应成功`);
        assert.match(output, /配置错误/);
        assert.match(output, /循环引用/);
        assert.ok(!/Maximum call stack|Converting circular structure|未预期错误/.test(output), output);
      }
    });
  });

  it('共享 DAG 超展开预算时 JSON reveal 快速报可读错误', () => {
    withFixture((dataDir, run) => {
      // 输入只有 O(log预算) 行，不在测试里生成展开后的 JSON；每个别名层共享前一层两次。
      const levels = Math.ceil(Math.log2(CONFIG_GRAPH_MAX_EXPANDED_NODES));
      const lines = ['level0: &level0 leaf'];
      for (let i = 1; i <= levels; i++) lines.push(`level${i}: &level${i} [*level${i - 1}, *level${i - 1}]`);
      lines.push(`root: *level${levels}`, '');
      fs.writeFileSync(path.join(dataDir, 'subscriptions', 'demo.yaml'), lines.join('\n'));

      const r = run(['config', '--json', '--reveal']);
      const output = `${r.stdout}${r.stderr}`;
      assert.notEqual(r.status, 0);
      assert.match(output, /节点数超过/);
      assert.match(output, /配置错误/);
      assert.ok(!/Maximum call stack|Converting circular structure|未预期错误/.test(output), output);
    });
  });

  it('订阅有条目无文件时指向 sub update（与 start/doctor 同口径）', () => {
    withFixture((dataDir, run) => {
      fs.rmSync(path.join(dataDir, 'subscriptions', 'demo.yaml'));
      const r = run(['config']);
      assert.notEqual(r.status, 0);
      assert.match(`${r.stdout}${r.stderr}`, /有条目但没有本地配置文件/);
      assert.match(`${r.stdout}${r.stderr}`, /mihomo-cli sub update demo/);
      assert.ok(!`${r.stdout}${r.stderr}`.includes('请先添加订阅'), '条目还在时正确动作是 update 不是 add');
    });
  });
});
