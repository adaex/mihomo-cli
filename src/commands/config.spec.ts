import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `mihomo config` 凭据脱敏与缺文件提示（CLI 级）。
 * 脱敏规则的单元覆盖在 redact.spec.ts，这里锁命令接线：默认上屏的是掩码、
 * --reveal 才给原文、JSON 信封带 redacted，以及缺文件时三处口径统一指向 sub update。
 */
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-config-cli-'));
  const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
  try {
    fs.mkdirSync(path.join(dataDir, 'subscriptions'));
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ subscriptions: [{ name: 'demo', url: 'https://example.com/sub' }], active_subscription: 'demo' }),
    );
    fs.writeFileSync(path.join(dataDir, 'subscriptions', 'demo.yaml'), SUBSCRIPTION);
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label, NO_COLOR: '1' },
      });
    check(dataDir, run);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
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

  it('订阅有条目无文件时指向 sub update（与 start/doctor 同口径）', () => {
    withFixture((dataDir, run) => {
      fs.rmSync(path.join(dataDir, 'subscriptions', 'demo.yaml'));
      const r = run(['config']);
      assert.notEqual(r.status, 0);
      assert.match(`${r.stdout}${r.stderr}`, /有条目但没有本地配置文件/);
      assert.match(`${r.stdout}${r.stderr}`, /mihomo sub update demo/);
      assert.ok(!`${r.stdout}${r.stderr}`.includes('请先添加订阅'), '条目还在时正确动作是 update 不是 add');
    });
  });
});
