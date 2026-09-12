import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as yaml from 'js-yaml';

/**
 * `mihomo config`：只读展示当前生效的运行配置。
 *
 * 关键性质是**停止状态下也能用**——`runtime/config.yaml` 在 stop 时被 `clearRuntime()`
 * 整个删掉，而「停着的时候看看配置对不对」恰是最需要它的场景。故实现是重新推导而非读盘，
 * 这些用例全部在没有 runtime/config.yaml 的目录里跑，正是要锁住这一点。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cfg-'));
  fs.mkdirSync(path.join(dataDir, 'subscriptions'));
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      subscriptions: [{ name: 'demo', url: 'https://example.com/sub?token=secret123' }],
      active_subscription: 'demo',
      controller_secret: 'my-secret-key',
    }),
  );
  fs.writeFileSync(
    path.join(dataDir, 'subscriptions', 'demo.yaml'),
    [
      'proxies:',
      '  - { name: HK-1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: pw }',
      'proxy-groups:',
      '  - { name: PROXY, type: select, proxies: [HK-1] }',
      'rules:',
      '  - MATCH,PROXY',
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; stdout: string; output: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIHOMO_CLI_DIR: dataDir,
      MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
      NO_COLOR: '1',
    },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout || '', output: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('config：查看当前生效的运行配置', () => {
  it('无 runtime/config.yaml 时仍能输出合法 YAML（重新推导，不读盘）', () => {
    assert.equal(fs.existsSync(path.join(dataDir, 'runtime', 'config.yaml')), false, '前提：本用例就是在没有落盘配置的状态下跑');

    const { status, stdout, output } = run(['config']);
    assert.equal(status, 0, output);

    // 注释头以 # 开头，去掉后必须是完整可解析的 YAML——否则管给内核或别的工具就废了
    const parsed = yaml.load(
      stdout
        .split('\n')
        .filter(l => !l.startsWith('#'))
        .join('\n'),
    ) as Record<string, unknown>;
    assert.equal(typeof parsed, 'object');
    // 订阅内容与系统锁定项都应在
    assert.ok(Array.isArray(parsed.proxies));
    assert.equal(parsed['mixed-port'], 7890);
    assert.equal(parsed['external-controller'], '127.0.0.1:9090');
  });

  it('secret 脱敏，不打印明文凭据', () => {
    const { status, output } = run(['config']);
    assert.equal(status, 0, output);
    assert.ok(!output.includes('my-secret-key'), 'controller_secret 绝不能明文出现在输出里');
    assert.match(output, /secret: '\*\*\*'/);
  });

  it('--json 输出合法 JSON 且同样脱敏', () => {
    const { status, stdout, output } = run(['config', '--json']);
    assert.equal(status, 0, output);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    assert.equal(parsed.secret, '***');
    assert.ok(Array.isArray(parsed.proxies));
    // 无警告时 warnings 也在场且是空数组：字段形状稳定，消费者不必判 undefined
    assert.deepEqual(parsed.warnings, []);
  });

  it('--json 携带 buildConfig 的 warnings，不把信号丢在 JSON 之外', () => {
    // 分组名拼错的 ~? 补丁会被跳过——这正是 warnings 要暴露、而 JSON 分支此前丢弃的信号
    fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), '~?proxy-groups:\n  - { name: TYPO-GROUP, type: select, proxies: [HK-1] }\n');

    const { status, stdout, output } = run(['config', '--json']);
    assert.equal(status, 0, output);
    // stdout 仍是单个可整体解析的 JSON 对象：warnings 在对象内，而不是溢到 stderr 或第二段输出
    const parsed = JSON.parse(stdout) as { warnings?: string[] };
    assert.ok(Array.isArray(parsed.warnings), 'warnings 必须是 JSON 输出里的顶层数组字段');
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /~\?proxy-groups/);
    assert.match(parsed.warnings[0], /TYPO-GROUP/);
    assert.match(parsed.warnings[0], /未匹配到当前订阅中的同名元素/);
  });

  it('无订阅时报错并给出下一步', () => {
    fs.rmSync(path.join(dataDir, 'settings.json'));
    const { status, output } = run(['config']);
    assert.notEqual(status, 0);
    assert.match(output, /尚无订阅/);
    assert.match(output, /sub add/);
  });

  it('订阅有条目但缺配置文件时报错并指向 sub update', () => {
    fs.rmSync(path.join(dataDir, 'subscriptions', 'demo.yaml'));
    const { status, output } = run(['config']);
    assert.notEqual(status, 0);
    assert.match(output, /没有本地配置文件/);
    assert.match(output, /sub update/);
  });

  it('未知选项报错', () => {
    const { status, output } = run(['config', '--bogus']);
    assert.notEqual(status, 0);
    assert.match(output, /未知的选项/);
  });
});
