import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { setupGuardFixture } from '../test-support/guard.js';

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

const guard = setupGuardFixture('mihomo-rootguard');

/** 以 uid=0 跑 CLI：预加载脚本覆盖 process.getuid，避免测试真的需要 sudo */
function runAsRoot(args: string[], envOverride?: NodeJS.ProcessEnv) {
  return guard.run(args, {
    preload: { name: 'as-root.mjs', body: 'process.getuid = () => 0;\n' },
    // HOME 钉在临时目录：root 下 HOME 可能被 sudo 换掉，默认数据目录要落在看得见、收得走的地方
    env: envOverride ?? { ...process.env, MIHOMO_CLI_DIR: path.join(guard.tmpDir, 'data'), HOME: guard.tmpDir },
  });
}

describe('root 守卫：sudo 下拒绝执行', () => {
  for (const cmd of ['stop', 'status', 'start', 'install', 'uninstall']) {
    it(`${cmd} 被拒绝并退出非 0`, () => {
      const { status, output } = runAsRoot([cmd]);
      assert.notEqual(status, 0, `sudo mihomo-cli ${cmd} 必须失败——退出 0 会让脚本把「什么都没做」当成功`);
      assert.match(output, /不要用 sudo/, '错误信息应直接告诉用户去掉 sudo');
    });
  }

  it('help / version 豁免（纯信息命令，不碰服务）', () => {
    for (const cmd of ['help', 'version']) {
      const { status } = runAsRoot([cmd]);
      assert.equal(status, 0, `${cmd} 不应被 root 守卫拦下`);
    }
  });

  it('豁免连副作用一起免：help/version 及别名不创建数据目录', () => {
    // 豁免若只免「拒绝」不免副作用，sudo mihomo-cli version 会在 /var/root（sudo 的 HOME）
    // 建出一套用户永远看不到的目录。不设 MIHOMO_CLI_DIR，以临时 HOME 直接复现该场景；
    // 别名（-h/-v/--help/--version）与大小写变体经 findCommand 解析后同样落在豁免名单内
    for (const cmd of ['help', 'version', '-h', '-v', '--help', '--version', 'HELP']) {
      const home = fs.mkdtempSync(path.join(guard.tmpDir, 'home-'));
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
      delete env.MIHOMO_CLI_DIR;
      const { status } = runAsRoot([cmd], env);
      assert.equal(status, 0, `${cmd} 在 root 下应正常退出`);
      assert.equal(fs.existsSync(path.join(home, '.mihomo-cli')), false, `root 下 ${cmd} 不得在 HOME 创建数据目录`);
    }
  });

  it('守卫先于 ensureDirs：被拒时不留下数据目录', () => {
    runAsRoot(['status']);
    assert.equal(fs.existsSync(path.join(guard.tmpDir, 'data')), false, 'root 下 HOME 可能是 /var/root，守卫晚于 ensureDirs 会在那里建出用户看不到的数据目录');
  });

  it('非豁免命令照常创建数据目录（豁免只覆盖 help/version）', () => {
    // 不伪造 root、真平台（不挂 preload）：status 这类普通命令必须仍经 ensureDirs 建出数据目录，
    // 否则「豁免跳过 ensureDirs」就会误伤所有命令。手拼三件套仍走 guard.run：数据目录必须落在
    // 与守卫用例同一个 tmpDir 里才能被 afterEach 收走；label 一并隔离——status 会查服务状态
    const r = guard.run(['status', '--no-probe'], {
      env: {
        ...process.env,
        MIHOMO_CLI_DIR: path.join(guard.tmpDir, 'data'),
        MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(guard.tmpDir)}`,
        NO_COLOR: '1',
      },
    });
    assert.equal(r.status, 0, r.output);
    assert.ok(fs.existsSync(path.join(guard.tmpDir, 'data', 'runtime')), '非豁免命令仍应创建数据目录');
  });
});
