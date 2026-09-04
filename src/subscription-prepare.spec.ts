import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// paths.ts 在 import 期求值 MIHOMO_CLI_DIR，故必须先设环境变量再动态 import。
// node --test 一个文件一个进程，不会污染其他 spec。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-prepare-'));
process.env.MIHOMO_CLI_DIR = tmpDir;

const { PATHS } = await import('./paths.js');
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
  fs.mkdirSync(path.join(tmpDir, 'subscriptions'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'runtime'), { recursive: true });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 锁住 start 的「先校验、后停机」：构建与写盘必须是两步。
 * 合成一步的话，stop()（会 rmrf runtime/）已经跑过，构建再失败就留下
 * 「已停机 + 无 config.yaml」的半死态，用户既没代理也没得回滚。
 */
describe('prepareConfigForStart / commitPreparedConfig 分两步', () => {
  it('prepareConfigForStart 只构建、不写盘', () => {
    fs.writeFileSync(path.join(tmpDir, 'subscriptions', 'x.yaml'), SUB_YAML);
    fs.rmSync(PATHS.configFile, { force: true });

    const prepared = prepareConfigForStart('mixed', 'x');

    assert.equal(fs.existsSync(PATHS.configFile), false, 'prepare 阶段不得写 config.yaml');
    assert.equal(prepared.info.proxies, 1);
    assert.equal(prepared.info.proxyGroups, 1);
  });

  it('commitPreparedConfig 才落盘', () => {
    fs.writeFileSync(path.join(tmpDir, 'subscriptions', 'x.yaml'), SUB_YAML);
    fs.rmSync(PATHS.configFile, { force: true });

    const info = commitPreparedConfig(prepareConfigForStart('mixed', 'x'));

    assert.ok(fs.existsSync(PATHS.configFile), 'commit 后应有 config.yaml');
    assert.deepEqual(info, { proxies: 1, proxyGroups: 1 });
  });

  it('订阅损坏时 prepare 抛错且不碰已有的 config.yaml', () => {
    // 这是本次拆分要防的场景：运行中的内核仍在用这份 config.yaml
    commitPreparedConfig(prepareConfigForStart('mixed', 'x'));
    const before = fs.readFileSync(PATHS.configFile, 'utf8');

    fs.writeFileSync(path.join(tmpDir, 'subscriptions', 'x.yaml'), 'proxies:\n  - name: a\n   bad: [x\n');
    assert.throws(() => prepareConfigForStart('mixed', 'x'));

    assert.equal(fs.readFileSync(PATHS.configFile, 'utf8'), before, '构建失败不得改动运行中的配置');
  });

  it('订阅不存在时抛 CliError', () => {
    assert.throws(() => prepareConfigForStart('mixed', 'nope'), CliError);
  });
});
