import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeFixture, moduleUrl, runModule } from './test-support/cli.js';
import { killLeftovers } from './test-support/fake-kernel.js';
import { writeStubExecutable } from './test-support/stub-bin.js';

describe('TUN sudo 窗口内的并发停止', () => {
  it('sudo 期间 epoch 变化：取消启动并收掉已经启动的内核', () => {
    const fixture = makeFixture('mihomo-tun-stop-window');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-tun-stop-home-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-tun-stop-bin-'));
    assert.ok(fixture.dataDir.startsWith(os.tmpdir()), '进程测试必须使用临时数据目录');
    assert.match(fixture.label, /^com\.mihomo-cli\.test\./, '服务查询必须使用一次性 label');
    let pattern = '';
    try {
      writeStubExecutable(
        path.join(fakeBin, 'launchctl'),
        `
if [ "$1" = "print" ]; then exit 113; fi
exit 0
`,
      );
      writeStubExecutable(
        path.join(fakeBin, 'sudo'),
        `
printf '999\n' > "$MIHOMO_CLI_DIR/service-stop-epoch"
/bin/bash "$1"
`,
      );

      const script = String.raw`
import fs from 'node:fs';
import { PATHS, ensureDirs } from ${JSON.stringify(moduleUrl('src/paths.ts'))};
import { captureStopEpochBaseline } from ${JSON.stringify(moduleUrl('src/stop-epoch.ts'))};
import { launchOrRestart } from ${JSON.stringify(moduleUrl('src/runtime.ts'))};
import { getMihomoPids, MAIN_INSTANCE_PATTERN } from ${JSON.stringify(moduleUrl('src/process-probe.ts'))};
import { writeStubExecutable } from ${JSON.stringify(moduleUrl('src/test-support/stub-bin.ts'))};

console.log('PATTERN:' + MAIN_INSTANCE_PATTERN);
ensureDirs();
writeStubExecutable(PATHS.mihomoBinary, 'setInterval(() => {}, 1000);', '/usr/bin/env node');
fs.writeFileSync(PATHS.configFile, 'tun:\n  enable: true\n');
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
captureStopEpochBaseline();
try {
  const pid = await launchOrRestart('tun');
  console.log('RESULT:PID=' + pid);
} catch (e) {
  console.log('RESULT:' + (e instanceof Error ? e.message : String(e)));
}
console.log('PIDS:' + getMihomoPids().length);
console.log('PID_FILE:' + fs.existsSync(PATHS.pidFile));
`;
      const result = runModule(script, fixture.dataDir, {
        env: {
          HOME: fakeHome,
          MIHOMO_CLI_DAEMON_LABEL: fixture.label,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
        timeout: 30_000,
      });
      pattern = result.stdout.match(/^PATTERN:(.*)$/m)?.[1] ?? '';
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /RESULT:启动已取消：期间检测到停止操作/);
      assert.match(result.stdout, /PIDS:0/, `停止后不得残留内核，stdout: ${result.stdout}`);
      assert.match(result.stdout, /PID_FILE:false/);
      assert.ok(pattern.includes(fixture.dataDir), `进程匹配必须锚定临时目录: ${pattern}`);
    } finally {
      // pattern 在启动前输出；为空说明未进入启动路径。killLeftovers 先核验隔离再 pkill
      if (pattern) killLeftovers(pattern, fixture.dataDir);
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
