import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MIN_NODE_VERSION } from '../constants.js';

/**
 * Node 版本守卫的端到端回归。
 *
 * `package.json` 的 `engines` 只让 npm 打一行 warn 就装上了，之后炸在某个语法或 API 上，
 * 报错与真实原因（Node 太旧）毫无表面关联。守卫必须在入口拦住。
 *
 * 用预加载脚本覆盖 `process.versions.node` 而不是真去装一个旧 Node：要验的是守卫的判断与
 * 位置，不是旧解释器本身能否跑这份代码（真旧 Node 连 tsx 都未必起得来，测不到守卫）。
 * 与 root-guard.spec 同一手法。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-nodeguard-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 以伪造的 Node 版本跑 CLI。label 一并隔离——status 会查服务状态 */
function runAsNodeVersion(version: string, args: string[]): { status: number | null; output: string } {
  const preload = path.join(tmpDir, 'fake-node-version.mjs');
  // versions 是只读属性，需 defineProperty 覆盖
  fs.writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)}, configurable: true });\n`);

  const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload, ENTRY, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIHOMO_CLI_DIR: path.join(tmpDir, 'data'),
      MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(tmpDir)}`,
      NO_COLOR: '1',
    },
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('Node 版本守卫', () => {
  // engines 的写法若从 `>=x.y.z` 变成别的 range，守卫会整体跳过（宁可不拦也不能挡死所有命令）。
  // 这条断言让那种变化立刻可见，而不是让守卫静默失效
  it('最低版本取自 package.json 的 engines', () => {
    assert.equal(MIN_NODE_VERSION, '22.22.1');
  });

  for (const cmd of ['status', 'stop', 'start', 'install']) {
    it(`${cmd} 在过低的 Node 上被拒绝并退出非 0`, () => {
      const { status, output } = runAsNodeVersion('20.0.0', [cmd]);
      assert.notEqual(status, 0, `旧 Node 下 ${cmd} 必须失败，不能带着未定义行为往下跑`);
      assert.match(output, /Node 版本过低/);
      assert.match(output, /22\.22\.1/, '错误里要给出所需版本，否则用户不知道该升到哪');
    });
  }

  it('help / version 豁免：否则用户连「装的是哪个版本」都问不出来', () => {
    for (const cmd of ['help', 'version']) {
      const { status } = runAsNodeVersion('20.0.0', [cmd]);
      assert.equal(status, 0, `${cmd} 不应被 Node 版本守卫拦下`);
    }
  });

  it('守卫先于 ensureDirs：被拒时不留下数据目录', () => {
    runAsNodeVersion('20.0.0', ['status']);
    assert.equal(fs.existsSync(path.join(tmpDir, 'data')), false, '守卫晚于 ensureDirs 会在旧 Node 上先建出一套数据目录再报错');
  });

  it('满足下限时放行（不误伤当前支持的版本）', () => {
    const { status, output } = runAsNodeVersion(MIN_NODE_VERSION ?? '22.22.1', ['version']);
    assert.equal(status, 0, output);
  });
});
