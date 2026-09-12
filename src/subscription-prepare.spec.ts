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
      await assert.rejects(prepareConfigForStart('mixed', 'x'), e => {
        assert.ok(e instanceof CliError);
        const hint = e.hint.join('\n');
        assert.match(hint, /native rejected candidate/);
        // 无覆写生效时不得出现该段——防有人日后把 loadOverwriteFile 塞回校验函数内部，
        // 那会列出本次并未生效的文件
        assert.ok(!hint.includes('当前生效的覆写文件'), '无覆写生效时不应出现覆写清单');
        return true;
      });
      assert.equal(fs.readFileSync(PATHS.configFile, 'utf8'), previous);
      assert.deepEqual(fs.readdirSync(DIRS.runtime), ['config.yaml']);
    } finally {
      fs.rmSync(`${PATHS.mihomoBinary}.reject`);
    }
  });

  // 纯函数测试测不到「调用点忘传覆写清单」：这条锁 buildConfig → prepareConfigForStart
  // → validateConfigWithKernel 的接线真的通了
  it('内核拒绝时提示附带生效的覆写文件（透传链路接通）', async () => {
    const owPath = path.join(tmpDir, 'overwrite.probe.yaml');
    // 刻意用无 match 的文件：本 spec 的订阅不在 settings 里，subUrl 为 undefined，
    // 带 url-domain 的文件会 fail-closed 不生效（作用域过滤本身由 config.spec 覆盖）
    fs.writeFileSync(owPath, 'log-level: warning\n');
    fs.writeFileSync(`${PATHS.mihomoBinary}.reject`, '');
    try {
      await assert.rejects(prepareConfigForStart('mixed', 'x'), e => {
        assert.ok(e instanceof CliError);
        const hint = e.hint.join('\n');
        assert.match(hint, /native rejected candidate/);
        assert.match(hint, /当前生效的覆写文件/);
        assert.match(hint, /overwrite\.probe\.yaml \(全局\)/);
        return true;
      });
    } finally {
      fs.rmSync(`${PATHS.mihomoBinary}.reject`);
      fs.rmSync(owPath);
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
