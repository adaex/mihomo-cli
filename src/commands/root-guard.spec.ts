import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * root 守卫的端到端回归（v4.2.2）。
 *
 * 以 root 运行时服务域拼成 `gui/0`，launchctl 恒 125，而所有服务操作都把它当
 * 「未装载」静默跳过：`stop` 报「已停止」但 KeepAlive 把内核拉回来，`install`
 * 装到不存在的域。必须在入口拦住，不能靠下游各自防御。
 *
 * 用子进程跑真实入口而非直接调函数：守卫在 `main()` 里，且要一并验证
 * **它先于 `ensureDirs()`**——root 下 HOME 可能是 /var/root，守卫晚一步就会在那里
 * 建出一套用户永远看不到的数据目录。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-rootguard-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 以 uid=0 跑 CLI：预加载脚本覆盖 process.getuid，避免测试真的需要 sudo */
function runAsRoot(args: string[]): { status: number | null; output: string } {
  const preload = path.join(tmpDir, 'as-root.mjs');
  fs.writeFileSync(preload, 'process.getuid = () => 0;\n');

  const r = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload, ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIHOMO_CLI_DIR: path.join(tmpDir, 'data'), HOME: tmpDir },
    timeout: 30_000,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('root 守卫：sudo 下拒绝执行', () => {
  for (const cmd of ['stop', 'status', 'start', 'install', 'uninstall']) {
    it(`${cmd} 被拒绝并退出非 0`, () => {
      const { status, output } = runAsRoot([cmd]);
      assert.notEqual(status, 0, `sudo mihomo ${cmd} 必须失败——退出 0 会让脚本把「什么都没做」当成功`);
      assert.match(output, /不要用 sudo/, '错误信息应直接告诉用户去掉 sudo');
    });
  }

  it('help / version 豁免（纯信息命令，不碰服务）', () => {
    for (const cmd of ['help', 'version']) {
      const { status } = runAsRoot([cmd]);
      assert.equal(status, 0, `${cmd} 不应被 root 守卫拦下`);
    }
  });

  it('守卫先于 ensureDirs：被拒时不留下数据目录', () => {
    runAsRoot(['status']);
    assert.equal(fs.existsSync(path.join(tmpDir, 'data')), false, 'root 下 HOME 可能是 /var/root，守卫晚于 ensureDirs 会在那里建出用户看不到的数据目录');
  });
});
