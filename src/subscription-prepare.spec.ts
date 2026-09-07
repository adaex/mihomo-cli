import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-prepare-'));
process.env.MIHOMO_CLI_DIR = tmpDir;
const { DIRS, PATHS, ensureDirs } = await import('./paths.js');
const { prepareConfigForStart, commitPreparedConfig } = await import('./subscription.js');
const { CliError } = await import('./errors.js');
const SUB_YAML = `proxies:
  - {name: a, type: socks5, server: 127.0.0.1, port: 1080}
proxy-groups:
  - {name: PROXY, type: select, proxies: [a, DIRECT]}
rules:
  - MATCH,PROXY
`;

before(() => {
  ensureDirs();
  assert.ok(PATHS.mihomoBinary.startsWith(tmpDir), '测试必须使用临时内核，不能调用用户的运行内核');
  // 仅模拟子进程接受/拒绝配置，验证 CLI 的执行协议和失败原子性；原生语义另以真实内核实测
  fs.writeFileSync(
    PATHS.mihomoBinary,
    `#!/bin/sh
[ "$1" = '-t' ] && [ "$2" = '-d' ] && [ "$4" = '-f' ] && [ -s "$5" ] || exit 7
if [ -f "$0.reject" ]; then echo 'native rejected candidate' >&2; exit 1; fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(DIRS.subscriptions, 'x.yaml'), SUB_YAML);
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('配置经内核校验后再提交', () => {
  it('prepare 不写运行配置，临时校验文件及时清理', async () => {
    const prepared = await prepareConfigForStart('mixed', 'x');
    assert.equal(fs.existsSync(PATHS.configFile), false);
    assert.deepEqual(prepared.info, { proxies: 1, proxyGroups: 1 });
    assert.deepEqual(fs.readdirSync(DIRS.runtime), []);
  });

  it('commit 只写最终配置，不生成三份调试 YAML', async () => {
    const info = commitPreparedConfig(await prepareConfigForStart('mixed', 'x'));
    assert.deepEqual(info, { proxies: 1, proxyGroups: 1 });
    assert.deepEqual(fs.readdirSync(DIRS.runtime), ['config.yaml']);
  });

  it('内核拒绝配置时保留现有配置并清理临时文件', async () => {
    const previous = fs.readFileSync(PATHS.configFile, 'utf8');
    fs.writeFileSync(`${PATHS.mihomoBinary}.reject`, '');
    try {
      await assert.rejects(prepareConfigForStart('mixed', 'x'), e => e instanceof CliError && e.hint.join(' ').includes('native rejected candidate'));
      assert.equal(fs.readFileSync(PATHS.configFile, 'utf8'), previous);
      assert.deepEqual(fs.readdirSync(DIRS.runtime), ['config.yaml']);
    } finally {
      fs.rmSync(`${PATHS.mihomoBinary}.reject`);
    }
  });

  it('并发校验使用各自的临时文件，结束后均清理', async () => {
    await Promise.all([prepareConfigForStart('mixed', 'x'), prepareConfigForStart('mixed', 'x')]);
    assert.deepEqual(fs.readdirSync(DIRS.runtime), ['config.yaml']);
  });

  it('YAML 损坏时不改已有配置', async () => {
    const previous = fs.readFileSync(PATHS.configFile, 'utf8');
    fs.writeFileSync(path.join(DIRS.subscriptions, 'x.yaml'), 'proxies: [bad\n');
    await assert.rejects(prepareConfigForStart('mixed', 'x'));
    assert.equal(fs.readFileSync(PATHS.configFile, 'utf8'), previous);
  });

  it('订阅不存在时抛 CliError', async () => {
    await assert.rejects(prepareConfigForStart('mixed', 'nope'), CliError);
  });
});
