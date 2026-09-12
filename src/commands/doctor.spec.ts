import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `mihomo doctor`：端到端跑完整体检，锁「配置构建的 warnings 透传进体检输出」。
 *
 * 桩内核沿用 subscription-prepare.spec 的手法，只模拟 `-v`（取版本）与
 * `-t -d <dir> -f <file>`（原生校验协议），不调真实内核。MIHOMO_CLI_DIR 与
 * MIHOMO_CLI_DAEMON_LABEL 全部隔离：launchd 查询落在临时标签上自然「未安装」，
 * 端口与版本检查是环境相关的，不纳入断言。断言只看 stdout 内容与体检走完
 * （「体检完成」在抛错之前打印，它在场即证明全部检查项都跑到了）。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-doctor-'));
  fs.mkdirSync(path.join(dataDir, 'subscriptions'));
  fs.mkdirSync(path.join(dataDir, 'kernel'));
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      subscriptions: [{ name: 'demo', url: 'https://example.com/sub?token=secret123' }],
      active_subscription: 'demo',
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
  fs.writeFileSync(
    path.join(dataDir, 'kernel', 'mihomo'),
    [
      '#!/bin/sh',
      '[ "$1" = "-v" ] && { echo "Mihomo Meta v1.19.13 darwin arm64"; exit 0; }',
      '[ "$1" = "-t" ] && [ "$2" = "-d" ] && [ "$4" = "-f" ] && [ -s "$5" ] || exit 7',
      '',
    ].join('\n'),
    { mode: 0o755 },
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
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout || '', output: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('doctor：体检透传配置构建的 warnings', () => {
  it('校验通过但有合并提示时，warnings 逐条挂到配置构建项下', () => {
    // 分组名拼错的 ~? 补丁会被跳过——正是 buildResult.warnings 要暴露、而 doctor 此前丢弃的信号
    fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), '~?proxy-groups:\n  - { name: TYPO-GROUP, type: select, proxies: [HK-1] }\n');

    const { stdout, output } = run(['doctor']);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    // 检查项本身仍算通过（措辞带「通过内核校验」），提示不升级成失败
    assert.match(stdout, /配置构建: 当前订阅通过内核校验（mixed），另有 1 条配置提示/);
    // 多条 warnings 逐条进 notes：跳过详情带着补丁名与分组键，用户才能定位拼错的分组
    assert.match(stdout, /TYPO-GROUP/);
    assert.match(stdout, /未匹配到当前订阅中的同名元素/);
  });

  it('无提示时配置构建仍是一项干净的正常项', () => {
    const { stdout, output } = run(['doctor']);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /✓ 配置构建: 当前订阅通过内核校验（mixed）/);
    assert.ok(!stdout.includes('未匹配到当前订阅中的同名元素'), '无警告时不应出现跳过提示');
  });
});
