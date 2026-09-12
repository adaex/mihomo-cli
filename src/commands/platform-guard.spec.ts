import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 平台守卫的端到端回归（与 root-guard / node-guard 同一手法：子进程跑真实入口 + 预加载伪造环境）。
 *
 * 服务托管依赖 launchd、目录/UI 打开依赖 open、提权依赖 sudo，均为 macOS 专有实现，
 * 缺守卫时非 macOS 会「部分成功」。help/version 是纯信息命令，豁免——且豁免必须连
 * ensureDirs 的副作用一起免掉：否则非 macOS 上的 mihomo help 会在用户家目录建出
 * 一套本不该出现的数据目录（与 root 下的 mihomo version 同一族缺陷）。
 *
 * process.platform 是 getter，直接赋值静默失败（实测仍为 darwin），必须 defineProperty。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-platformguard-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 以伪造的非 macOS 平台跑 CLI。逃生阀 MIHOMO_CLI_ALLOW_ANY_PLATFORM 一律清掉，否则守卫整体失效 */
function runOnPlatform(platform: string, args: string[], envOverride?: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const preload = path.join(tmpDir, `as-${platform}.mjs`);
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`);

  const env = envOverride ?? { ...process.env, MIHOMO_CLI_DIR: path.join(tmpDir, 'data'), HOME: tmpDir };
  delete env.MIHOMO_CLI_ALLOW_ANY_PLATFORM;

  const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload, ENTRY, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('平台守卫：非 macOS 下拒绝执行', () => {
  for (const cmd of ['status', 'stop', 'start', 'install']) {
    it(`${cmd} 在非 macOS 上被拒绝并退出非 0`, () => {
      const { status, output } = runOnPlatform('linux', [cmd]);
      assert.notEqual(status, 0, `linux 上 mihomo ${cmd} 必须失败——「部分成功」比报错更难排查`);
      assert.match(output, /仅支持 macOS/, '错误信息应说明平台限制');
    });
  }

  it('help / version 豁免且不创建数据目录', () => {
    // 不设 MIHOMO_CLI_DIR，以临时 HOME 直接验证豁免语义免掉的是副作用面：
    // 守卫放行 ≠ 可以顺手 ensureDirs，那会在非 macOS 的用户家目录留下数据目录
    for (const cmd of ['help', 'version', '-h', '-v']) {
      const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env.MIHOMO_CLI_DIR;
      const { status } = runOnPlatform('linux', [cmd], env);
      assert.equal(status, 0, `${cmd} 不应被平台守卫拦下`);
      assert.equal(fs.existsSync(path.join(home, '.mihomo-cli')), false, `非 macOS 上 ${cmd} 不得在 HOME 创建数据目录`);
    }
  });
});
