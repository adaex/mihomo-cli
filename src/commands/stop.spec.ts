import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { shouldAbortStartOnDisable } from '../service.js';
import { makeFixture, moduleUrl, readEpochIn, runCli, runModule } from '../test-support/cli.js';
import { isDead, killLeftovers, pollUntil, spawnFakeKernel, writeFakeKernelFiles } from '../test-support/fake-kernel.js';

/**
 * `cmdStop` 的两条提前返回路径是否留下「停止过」的记录。
 *
 * 为什么这条能自动化，而 install / restart 的同族缺陷不能：这两条路径**一次 launchctl
 * 写操作都不做**。隔离数据目录 + 一个不存在的服务 label 之下，`getServiceStatus()` 走
 * 「未安装且未装载」的早退分支、`getMihomoPids()` 为空，判据 `loaded || (installed &&
 * !disabled)` 恒为假——**天然就是要测的那条路径**。真实 `launchctl enable/disable` 会往
 * /var/db/com.apple.xpc.launchd/ 给每个 label 留永久记录且无清除动词，故绝不进测试。
 *
 * 断言的是**消费者可见的后果**（`shouldAbortStartOnDisable` 判为「变了」），不是文件内容：
 * 计数存在的唯一理由就是喂给那个判据，只断言文件里是几号会把实现细节焊进测试。
 */

/** 在隔离目录 + 独立 label 下跑真实 CLI。返回 run 供用例多次调用 */
function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const fixture = makeFixture('mihomo-stop');
  const { dataDir, label } = fixture;
  try {
    // 隔离前提必须有断言，不能只靠约定（CLAUDE：进程匹配需绑定临时 MIHOMO_CLI_DIR，
    // 涉及服务查询时还需隔离 label——LaunchAgent plist 在数据目录之外）
    assert.ok(dataDir.startsWith(os.tmpdir()));
    assert.equal(fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);

    const run = (args: string[]) => runCli(args, fixture);

    check(dataDir, run);

    // 测试自己不许留下 plist（label 隔离若失效，这里会炸）
    assert.equal(fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
  } finally {
    fixture.cleanup();
  }
}

describe('stop 的提前返回路径记录停止计数', () => {
  // 缺陷形态：服务已装、未装载、disable 位为真（上次 stop/tun 留下的，最常见的前置），
  // 无内核进程 → stop 走「不在运行」直接 return。此前不递增，于是并发的慢速 start
  // 看不到任何变化，随后 enable + bootstrap，终态与用户最后一条命令相反
  it('「不在运行」也记录，且每次成功的 stop 都留下一次变化', () =>
    withFixture((dataDir, run) => {
      const before = readEpochIn(dataDir);

      const first = run(['stop']);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /不在运行/);

      const afterFirst = readEpochIn(dataDir);
      assert.ok(shouldAbortStartOnDisable(before, afterFirst), '一次 stop 之后，以之前的快照为基线必须判为「期间有人 stop 过」');

      // 第二次同样要留下变化：并发判据问的是「与我的基线相比变了没有」，
      // 只递增一次的话，第二个 start 的基线已经是新值，第二次 stop 就又隐形了
      const second = run(['stop']);
      assert.equal(second.status, 0, second.stderr);
      const afterSecond = readEpochIn(dataDir);
      assert.ok(shouldAbortStartOnDisable(afterFirst, afterSecond), '第二次 stop 也必须可被检出');
    }));

  it('只有游离内核时，杀掉进程后同样记录', () =>
    withFixture((dataDir, run) => {
      // 桩内核：命令行必须含隔离目录下的 kernel/mihomo 与 runtime/config.yaml，
      // 才能被生产 pattern 匹配到（见 process-probe 的 MAIN_INSTANCE_PATTERN）
      const binary = path.join(dataDir, 'kernel', 'mihomo');
      const configFile = path.join(dataDir, 'runtime', 'config.yaml');
      writeFakeKernelFiles({ binaries: [binary], configFile });

      // 隔离前提：pattern 必须指向 tmpdir，绝不能命中用户真实数据目录下的内核
      const pattern = runModule(
        `import { MAIN_INSTANCE_PATTERN } from ${JSON.stringify(moduleUrl('src/process-probe.ts'))}; process.stdout.write(MAIN_INSTANCE_PATTERN);`,
        dataDir,
        { env: { MIHOMO_CLI_ALLOW_ANY_PLATFORM: '1' }, timeout: 30_000 },
      );
      assert.equal(pattern.status, 0, pattern.stderr);
      assert.ok(pattern.stdout.includes(dataDir), 'pattern 必须绑定隔离目录');
      assert.ok(!pattern.stdout.includes(path.join(os.homedir(), '.mihomo-cli')), 'pattern 绝不能命中真实数据目录');

      const pid = spawnFakeKernel({ binary, dataDir: path.join(dataDir, 'data'), configFile });
      try {
        // 等它真的出现在 pgrep 里（spawn 返回不代表 exec 完成）
        pollUntil(() => spawnSync('pgrep', ['-f', pattern.stdout], { encoding: 'utf8' }).stdout.trim() !== '');

        const before = readEpochIn(dataDir);
        const result = run(['stop']);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /已停止/);

        // 判活以 ps 状态列为准：kill(pid,0) 对僵尸进程同样返回成功（v4.2.3 的教训）
        assert.ok(isDead(pid), '桩内核应已终止（僵尸也算死，kill -0 会骗人）');

        assert.ok(shouldAbortStartOnDisable(before, readEpochIn(dataDir)), '杀掉游离内核也是一次确定的停止，必须可被并发判据检出');
      } finally {
        killLeftovers(pattern.stdout);
      }
    }));

  // 负向对照：没有这条，一次「到处都 bump」的重构会照样通过上面两条。
  // 计数变化必须只由停止类操作产生，否则并发的 start 会被无关命令白白中止
  it('只读命令不记录（status 不改变计数）', () =>
    withFixture((dataDir, run) => {
      const before = readEpochIn(dataDir);
      const result = run(['status', '--no-probe']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(shouldAbortStartOnDisable(before, readEpochIn(dataDir)), false, 'status 不是停止操作，不该让并发的 start 中止');
    }));
});
