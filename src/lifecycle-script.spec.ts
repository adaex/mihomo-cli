import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * npm preuninstall 生命周期脚本（scripts/preuninstall.mjs）。
 *
 * 该脚本在 npm 卸载/升级时由 npm 执行，测试直接 spawn 真实脚本：
 * - HOME 与 label 隔离，launchctl print 落到一次性标签（只读查询，无副作用）
 * - 不验证「自动卸载服务」——刻意只警告不动作（升级也会触发 preuninstall）
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'preuninstall.mjs');

function run(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('preuninstall：npm 卸载前的服务残留提示', () => {
  it('干净环境（无服务/无数据）静默退出 0，不打扰升级与 CI', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-preuninstall-home-'));
    // 数据目录指向一个**不存在**的路径（存在但为空也会被判为有数据，提示本身合理）
    const dataDir = path.join(os.tmpdir(), `mihomo-preuninstall-absent-${process.pid}-${Date.now()}`);
    const label = `com.mihomo-cli.test.${path.basename(home)}`;
    try {
      const r = run({ HOME: home, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '');
      assert.equal(r.stdout, '');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('检测到 plist/数据目录残留时给出手动清理命令（含 label、uid 与路径）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-preuninstall-home-'));
    const dataDir = path.join(home, 'mihomo-data');
    const label = `com.mihomo-cli.test.${path.basename(home)}`;
    const agents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(agents, `${label}.plist`), '<plist/>\n');
    fs.writeFileSync(path.join(dataDir, 'settings.json'), '{}\n');
    try {
      const r = run({ HOME: home, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label });
      assert.equal(r.status, 0, '提示脚本永远不能阻断卸载');
      const out = r.stderr;
      assert.match(out, /mihomo-cli：npm 卸载只移除 npm 包/);
      assert.match(out, new RegExp(label));
      assert.match(out, /launchctl bootout/);
      assert.match(out, new RegExp(`rm -f .*${label}\\.plist`));
      assert.match(out, new RegExp(`rm -rf ${dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      // 升级是最常触发 preuninstall 的场景，必须写明可以忽略
      assert.match(out, /升级/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
