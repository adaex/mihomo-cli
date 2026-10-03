import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeFixture, runCli } from '../test-support/cli.js';

/**
 * cmdUninstall 的幂等判据与残留形态。此前是仅有的零覆盖命令 handler——判据
 * 「四条件全空才早退」与「plist 缺失仍装载」分支是实测踩坑换来的不变量（手动删
 * plist 后 KeepAlive 继续拉起，只看文件会陷入「永远停不掉」死胡同）。
 * 隔离：MIHOMO_CLI_DIR + 一次性 label + PATH 桩 launchctl（写动词记录进日志，
 * print/print-disabled 只读应答）；桩记不到的写动词即「未执行」的证据。
 */
describe('cmdUninstall：幂等判据与残留形态', () => {
  interface RunResult {
    stdout: string;
    stderr: string;
    status: number | null;
    /** 桩 launchctl 收到的写动词（bootout/disable/enable/bootstrap），每行一次 */
    writes: string[];
  }

  function runUninstall(opts: { printExit?: number; fakeKernel?: boolean }): RunResult {
    const fixture = makeFixture('mihomo-uninstall');
    const { dataDir, label } = fixture;
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-uninstall-bin-'));
    const writeLog = path.join(binDir, 'writes.log');
    const printExit = opts.printExit ?? 113;
    try {
      // 隔离前提
      assert.equal(fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
      for (const sub of ['kernel', 'logs', 'runtime', 'data']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
      fs.writeFileSync(
        path.join(binDir, 'launchctl'),
        [
          '#!/bin/bash',
          'case "$1" in',
          '  print)',
          '    # bootout 之后答未装载（状态文件由写动词分支翻转），waitUntilUnloaded 才能通过',
          `    if [ -f "${path.join(binDir, 'booted-out')}" ]; then exit 113; fi`,
          `    exit ${printExit}`,
          '    ;;',
          '  print-disabled)',
          `    printf '\\t\\t"${label}" => disabled\\n'`,
          '    exit 0',
          '    ;;',
          '  bootout)',
          `    touch "${path.join(binDir, 'booted-out')}"`,
          `    echo "$1" >> "${writeLog}"`,
          '    exit 0',
          '    ;;',
          '  *)',
          `    echo "$1" >> "${writeLog}"`,
          '    exit 0',
          '    ;;',
          'esac',
        ].join('\n'),
      );
      fs.chmodSync(path.join(binDir, 'launchctl'), 0o755);
      let kernelPid: number | null = null;
      if (opts.fakeKernel) {
        // 异步 spawn（spawnSync 会阻塞等子进程退出，detached 形同虚设）
        const child = spawn(
          process.execPath,
          ['-e', 'setTimeout(() => {}, 20000)', path.join(dataDir, 'kernel', 'mihomo'), '-f', path.join(dataDir, 'runtime', 'config.yaml')],
          { detached: true, stdio: 'ignore' },
        );
        child.unref();
        kernelPid = child.pid ?? null;
        // 等 pgrep 能看到它
        for (let i = 0; i < 50; i++) {
          const probe = spawnSync('pgrep', ['-f', String(kernelPid)], { encoding: 'utf8' });
          if (probe.status === 0) break;
          spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 50)']);
        }
      }
      const r = runCli(['uninstall'], fixture, { timeout: 30_000, env: { PATH: `${binDir}:${process.env.PATH}` } });
      if (kernelPid) {
        try {
          process.kill(kernelPid, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
      const writes = fs.existsSync(writeLog) ? fs.readFileSync(writeLog, 'utf8').split('\n').filter(Boolean) : [];
      return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, writes };
    } finally {
      fixture.cleanup();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }

  it('四条件全空（未装/未装载/无 legacy/零进程）：早退且零 launchctl 写动词', () => {
    const r = runUninstall({});
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /服务未安装/);
    assert.deepEqual(r.writes, [], '早退路径不得执行任何 launchctl 写操作（桩记不到即证据）');
  });

  it('plist 缺失但任务仍装载：明说残留形态并 bootout 卸载（只看文件会永远停不掉）', () => {
    const r = runUninstall({ printExit: 0 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /未找到 plist，但服务仍处装载状态/);
    assert.match(r.stdout, /已卸载服务/);
    assert.ok(r.writes.includes('bootout'), `应执行 bootout: ${JSON.stringify(r.writes)}`);
  });

  it('游离内核残留：给出 PID 与手动清理提示，不静默', () => {
    const r = runUninstall({ fakeKernel: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /仍有内核进程残留 \(PID \d+/);
    assert.match(r.stdout, /sudo pkill -9 mihomo/);
  });
});
