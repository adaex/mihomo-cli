import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runModule } from './test-support/cli.js';

/**
 * TUN 启动脚本本体的观察窗契约。脚本全部锁在真实 sudo 之后，此前零覆盖——
 * 注释实录了两次事故（内核 180ms/540ms 死亡被 0.4s 单检漏报、僵尸被 kill -0 误报
 * 存活 5/10 次），回归形态是「报启动成功但内核已死」，坏配置即可触发。
 * 测法：导出 buildTunLaunchScript 取脚本文本，子进程（隔离 MIHOMO_CLI_DIR）直接
 * bash 执行——脚本本体不含提权（sudo 在 runSudoScript 层），pkill pattern 锚定
 * 临时数据目录，碰不到真实内核。桩内核 = 写在 PATHS.mihomoBinary 的 shell 脚本。
 */
describe('buildTunLaunchScript：观察窗判定（12×0.1s，窗内死亡即失败）', () => {
  function runTunScript(stubKernelBody: string): { code: number | null; stdout: string; dataDir: string } {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-tun-script-'));
    for (const sub of ['kernel', 'logs', 'runtime', 'data']) fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
    const kernelStub = path.join(dataDir, 'kernel', 'mihomo');
    fs.writeFileSync(kernelStub, `#!/bin/sh\n${stubKernelBody}\n`, { mode: 0o755 });
    fs.chmodSync(kernelStub, 0o755);
    const srcPath = path.resolve('src/process-start.ts');
    const script = [
      "import fs from 'node:fs';",
      "import os from 'node:os';",
      "import path from 'node:path';",
      "import { spawnSync } from 'node:child_process';",
      `const { buildTunLaunchScript } = await import(${JSON.stringify(srcPath)});`,
      'const dir = process.env.MIHOMO_CLI_DIR;',
      'const scriptPath = path.join(os.tmpdir(), `tun-launch-${path.basename(dir)}.sh`);',
      'fs.writeFileSync(scriptPath, buildTunLaunchScript());',
      'fs.chmodSync(scriptPath, 0o755);',
      'const r = spawnSync("bash", [scriptPath], { encoding: "utf8", timeout: 30_000 });',
      "console.log('CODE:' + r.status);",
      "console.log('PID_FILE_EXISTS:' + fs.existsSync(dir + '/runtime/pid'));",
      "const pidContent = fs.existsSync(dir + '/runtime/pid') ? fs.readFileSync(dir + '/runtime/pid', 'utf8').trim() : '';",
      "console.log('PID:' + pidContent);",
    ].join('\n');
    const r = runModule(script, dataDir, { timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const code = Number((r.stdout.match(/CODE:(-?\d+)/) ?? [])[1]);
    const pid = (r.stdout.match(/PID:(\d+)/) ?? [])[1];
    // 清理存活的桩内核(由脚本启动、脱离测试进程)
    if (pid) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
    return { code, stdout: r.stdout, dataDir };
  }

  it('桩内核观察窗内死亡（sleep 0.3）→ 退 2 且 pid 文件被清', () => {
    const { code, stdout } = runTunScript('sleep 0.3; exit 1');
    assert.equal(code, 2, '窗内死亡必须走失败路径（历史事故：0.4s 单检漏报 180/540ms 死亡）');
    assert.match(stdout, /PID_FILE_EXISTS:false/, '失败路径必须清 pid（getPid 的真相源）');
  });

  it('桩内核存活过观察窗（sleep 30）→ 退 0 且 pid 文件是真实 pid', () => {
    const { code, stdout } = runTunScript('sleep 30');
    assert.equal(code, 0);
    assert.match(stdout, /PID_FILE_EXISTS:true/);
    const pid = Number((stdout.match(/PID:(\d+)/) ?? [])[1]);
    assert.ok(Number.isInteger(pid) && pid > 0, 'pid 文件必须是脚本启动的真实 pid');
  });
});
