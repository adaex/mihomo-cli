import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeFixture, moduleUrl, runModule } from './test-support/cli.js';
import { writeStubExecutable } from './test-support/stub-bin.js';

describe('kickstart 失败后的重启回退', () => {
  function runRestart(bootstrapStatus: 0 | 5): { stdout: string; stderr: string; status: number | null } {
    const fixture = makeFixture('mihomo-restart-fallback');
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-restart-home-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-restart-bin-'));
    const state = path.join(fixture.dataDir, 'service-state');
    const replacement = path.join(fixture.dataDir, 'replacement-state');
    assert.ok(fixture.dataDir.startsWith(os.tmpdir()), '服务测试必须使用临时数据目录');
    assert.match(fixture.label, /^com\.mihomo-cli\.test\./, '服务测试必须使用一次性 label');
    try {
      fs.writeFileSync(state, 'old');
      writeStubExecutable(
        path.join(fakeBin, 'launchctl'),
        `
case "$1" in
  print)
    if [ -f "${replacement}" ]; then
      printf '\\tstate = running\\n\\tpid = 5678\\n'
    elif [ -f "${state}" ]; then
      printf '\\tstate = running\\n\\tpid = 1234\\n'
    else
      exit 113
    fi
    exit 0
    ;;
  print-disabled) exit 0 ;;
  kickstart)
    if [ "${bootstrapStatus}" = "0" ]; then rm -f "${state}"; fi
    exit 1
    ;;
  bootstrap)
    if [ "${bootstrapStatus}" = "0" ]; then touch "${replacement}"; exit 0; fi
    exit 5
    ;;
esac
exit 0
`,
      );
      const script = `
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from ${JSON.stringify(moduleUrl('src/paths.ts'))};
import { captureStopEpochBaseline } from ${JSON.stringify(moduleUrl('src/stop-epoch.ts'))};
import { launchOrRestart } from ${JSON.stringify(moduleUrl('src/runtime.ts'))};

ensureDirs();
fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
fs.writeFileSync(PATHS.userAgentPlist, 'stub');
fs.writeFileSync(PATHS.settingsFile, JSON.stringify({ ports: { mixed: 0, controller: 0 } }));
captureStopEpochBaseline();
try {
  const pid = await launchOrRestart('mixed');
  console.log('RESULT:PID=' + pid);
} catch (e) {
  console.log('RESULT:' + (e instanceof Error ? e.message : String(e)));
}
`;
      return runModule(script, fixture.dataDir, {
        env: {
          HOME: fakeHome,
          MIHOMO_CLI_DAEMON_LABEL: fixture.label,
          PATH: `${fakeBin}:${process.env.PATH}`,
        },
        timeout: 20_000,
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fixture.cleanup();
    }
  }

  it('kickstart 失败且旧服务仍装载：不得把旧 PID 报成本次重启成功', () => {
    const result = runRestart(5);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT:重启服务失败.*本次未重新装载/);
    assert.doesNotMatch(result.stdout, /RESULT:PID=/);
  });

  it('kickstart 失败后确实重新 bootstrap：保留回退自愈并返回新 PID', () => {
    const result = runRestart(0);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT:PID=5678/);
  });
});
