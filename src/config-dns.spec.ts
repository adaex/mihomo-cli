import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// paths.ts 在 import 期求值 MIHOMO_CLI_DIR，故必须先设环境变量再动态 import。
// buildConfig 会读 settings（getPorts / controller_secret），须落在隔离目录里。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-dns-'));
process.env.MIHOMO_CLI_DIR = tmpDir;

const { buildConfig, validateConfig } = await import('./config.js');
const { CliError } = await import('./errors.js');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE_SUB = `proxies:
  - {name: a, type: socks5, server: 127.0.0.1, port: 1080}
proxy-groups:
  - {name: PROXY, type: select, proxies: [a, DIRECT]}
rules:
  - MATCH,PROXY
`;

function withDns(dnsYaml: string): string {
  return `${BASE_SUB}${dnsYaml}`;
}

/**
 * TUN 模式下 dns.enable 是系统锁定项。
 *
 * 机理：TUN 的 auto-route + strict-route 把 53 端口流量导进 utun、dns-hijack 拦下来，
 * 内置 DNS 关着就无组件接管，网络直接不可用。而 `dns.enable: false` 在 mixed 下合法、
 * 常由机场下发且用户改不了——故强制打开并告警，不拒绝启动。
 *
 * 此前的缺陷（CODE_REVIEW v4.2.3 记录、v4.7.3 修）：生成 `dns: {enable: false, ...}`
 * 的同时保留 `tun.dns-hijack`，还往已关闭的 dns 块里补注 fake-ip 字段。
 */
describe('TUN 模式锁定 dns.enable', () => {
  it('订阅显式 dns.enable: false 时强制为 true', () => {
    const { config } = buildConfig(withDns('dns:\n  enable: false\n'), 'tun');
    const dns = config.dns as Record<string, unknown>;
    assert.equal(dns.enable, true);
  });

  it('强制开启时给出告警（用户需知道自己的配置被忽略）', () => {
    const { warnings } = buildConfig(withDns('dns:\n  enable: false\n'), 'tun');
    assert.ok(
      warnings.some(w => w.includes('TUN') && w.includes('DNS')),
      `应有 DNS 被强制开启的告警，实际: ${JSON.stringify(warnings)}`,
    );
  });

  it('不再往已关闭的 dns 块补 fake-ip 字段——enable 与 enhanced-mode 恒一致', () => {
    const { config } = buildConfig(withDns('dns:\n  enable: false\n'), 'tun');
    const dns = config.dns as Record<string, unknown>;
    const tun = config.tun as Record<string, unknown>;
    // 生成端不得自相矛盾：dns-hijack 在、dns 就必须是开的
    assert.ok(Array.isArray(tun['dns-hijack']) && (tun['dns-hijack'] as unknown[]).length > 0);
    assert.equal(dns.enable, true);
    assert.equal(dns['enhanced-mode'], 'fake-ip');
  });

  it('dns.enable 为真值（未被显式关闭）时不产生告警', () => {
    const { warnings } = buildConfig(withDns('dns:\n  enable: true\n'), 'tun');
    assert.equal(
      warnings.some(w => w.includes('强制开启 DNS')),
      false,
    );
  });

  it('订阅未写 dns 时不产生告警，仍补齐默认值', () => {
    const { config, warnings } = buildConfig(BASE_SUB, 'tun');
    const dns = config.dns as Record<string, unknown>;
    assert.equal(dns.enable, true);
    assert.equal(dns['enhanced-mode'], 'fake-ip');
    assert.equal(dns['fake-ip-range'], '198.18.0.1/16');
    assert.equal(
      warnings.some(w => w.includes('强制开启 DNS')),
      false,
    );
  });

  it('只锁 enable：nameserver 等用户自定义原样保留', () => {
    const { config } = buildConfig(withDns('dns:\n  enable: false\n  nameserver: [1.1.1.1, 8.8.8.8]\n'), 'tun');
    const dns = config.dns as Record<string, unknown>;
    assert.equal(dns.enable, true);
    assert.deepEqual(dns.nameserver, ['1.1.1.1', '8.8.8.8']);
  });

  it('用户自定的 enhanced-mode 不被系统默认值覆盖', () => {
    const { config } = buildConfig(withDns('dns:\n  enable: false\n  enhanced-mode: redir-host\n'), 'tun');
    const dns = config.dns as Record<string, unknown>;
    assert.equal(dns.enable, true);
    assert.equal(dns['enhanced-mode'], 'redir-host');
  });

  it('mixed 模式不碰 dns.enable（那里关 DNS 是合法配置）', () => {
    const { config, warnings } = buildConfig(withDns('dns:\n  enable: false\n'), 'mixed');
    const dns = config.dns as Record<string, unknown>;
    assert.equal(dns.enable, false);
    assert.equal(
      warnings.some(w => w.includes('强制开启 DNS')),
      false,
    );
  });
});

/**
 * dns 形态校验两条路径共用。
 *
 * TUN 分支在读 `dns.enable` 前先调 assertDnsShape，mixed 由 assertConfigShape 兜底——
 * 此前只有 TUN 有守卫（v4.2.3 顺手修的），mixed 下同样的订阅笔误照样抛裸 TypeError
 * 并被 main().catch 当成程序 bug 打印堆栈。
 */
describe('dns 形态校验（TUN 与 mixed 两条路径）', () => {
  for (const mode of ['tun', 'mixed']) {
    it(`${mode}: dns 为标量抛 CliError 而非裸 TypeError`, () => {
      assert.throws(
        () => buildConfig(withDns('dns: true\n'), mode),
        (e: unknown) => e instanceof CliError && /dns 配置必须是映射/.test((e as Error).message),
      );
    });

    it(`${mode}: dns 为数组抛 CliError`, () => {
      assert.throws(
        () => buildConfig(withDns('dns:\n  - 1.1.1.1\n'), mode),
        (e: unknown) => e instanceof CliError && /数组/.test((e as Error).message),
      );
    });

    it(`${mode}: dns 为 null（写了键没写值）放行`, () => {
      assert.doesNotThrow(() => buildConfig(withDns('dns:\n'), mode));
    });
  }

  it('validateConfig 单独调用时也校验 dns（assertConfigShape 内）', () => {
    assert.throws(
      () => validateConfig({ dns: 'yes' }),
      (e: unknown) => e instanceof CliError && /dns 配置必须是映射/.test((e as Error).message),
    );
  });
});
