import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { RunningState } from './runtime.js';

// paths.ts / constants.ts 在 import 期求值 MIHOMO_CLI_DIR 与 MIHOMO_CLI_DAEMON_LABEL，
// 故必须先设环境变量再动态 import（同 process-stop.spec.ts）。
//
// label 用一次性值：restartModeOnChange 会查服务状态，而 LaunchAgent plist 位于数据
// 目录之外（~/Library/LaunchAgents），不隔离 label 就会查询生产服务的注册名。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-runtime-'));
process.env.MIHOMO_CLI_DIR = tmpDir;
process.env.MIHOMO_CLI_DAEMON_LABEL = `com.mihomo-cli.spec-${process.pid}`;

const { SERVICE_LABEL } = await import('./constants.js');
const { PATHS, DIRS } = await import('./paths.js');
const { isRunning, MAIN_INSTANCE_PATTERN } = await import('./process-probe.js');
const { restartModeFor, restartModeOnChange } = await import('./runtime.js');

/** 与 getRunningState 的构造口径一致：running 与 kind 同真同假 */
function stateOf(kind: RunningState['kind']): RunningState {
  return { running: kind !== null, pid: kind === null ? null : 4321, kind, processInfo: null };
}

describe('restartModeFor：重启模式取决于实际在跑的东西', () => {
  it('TUN 在跑 → tun，即使 fallback 是 mixed（服务已装时 getRuntimeMode 的答案）', () => {
    // 缺陷回归锁：`stop` 服务再 `start tun` 后服务仍装着，getRuntimeMode 恒答 mixed，
    // sub use / ow on 照它重启会把 TUN 静默切回 Mixed，还为清 root 内核弹 sudo
    assert.equal(restartModeFor(stateOf('tun'), 'mixed'), 'tun');
    assert.equal(restartModeFor(stateOf('tun'), 'tun'), 'tun');
  });

  it('服务在跑 → 回落 fallback（服务在跑必已装，getRuntimeMode 恒答 mixed）', () => {
    assert.equal(restartModeFor(stateOf('service'), 'mixed'), 'mixed');
  });

  it('没在跑 → 原样回落 fallback（本函数只对 TUN 例外，其余全信调用方）', () => {
    assert.equal(restartModeFor(stateOf(null), 'mixed'), 'mixed');
    assert.equal(restartModeFor(stateOf(null), 'tun'), 'tun');
  });
});

/** 桩「内核」：隔离目录 kernel/mihomo 位置的长睡脚本，命令行带真实 binary/config 路径 */
function spawnFakeKernel(): number {
  const child = spawn(PATHS.mihomoBinary, ['-d', DIRS.data, '-f', PATHS.configFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid as number;
}

/** 等 pid 文件指向的桩进程完成 exec、命令行能被 ps 读到（spawn 返回不代表已 exec） */
function waitUntilRunning(timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isRunning()) return true;
    spawnSync('sleep', ['0.05']);
  }
  return isRunning();
}

/** 兜底清理：任何一条用例漏杀都不该把桩进程留在开发机上 */
function killLeftovers(): void {
  spawnSync('pkill', ['-9', '-f', MAIN_INSTANCE_PATTERN], { timeout: 5000 });
}

before(() => {
  fs.mkdirSync(DIRS.kernel, { recursive: true });
  fs.mkdirSync(DIRS.runtime, { recursive: true });
  fs.mkdirSync(DIRS.data, { recursive: true });
  fs.writeFileSync(PATHS.mihomoBinary, '#!/bin/bash\nsleep 300\n', { mode: 0o755 });
  // 配置刻意不含 tun 字段：让 getRuntimeMode 的答案是 mixed——TUN 在跑时仍必须答 tun
  fs.writeFileSync(PATHS.configFile, 'mixed-port: 7890\n');
});

after(() => {
  killLeftovers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('restartModeOnChange：真实探测下的模式决策', () => {
  it('隔离前提：pattern 锚定临时数据目录，label 与生产服务不同名', () => {
    // 这是本组用例「无侵入」的依据：pattern 不含 tmpdir 就会匹配到用户的真实内核，
    // label 未生效就会去查询生产服务的 launchd 注册
    assert.ok(MAIN_INSTANCE_PATTERN.includes(tmpDir), `pattern 必须锚定隔离目录: ${MAIN_INSTANCE_PATTERN}`);
    assert.equal(SERVICE_LABEL, process.env.MIHOMO_CLI_DAEMON_LABEL, '隔离 label 必须实际生效');
  });

  it('没有实例在跑 → null（不重启，也不顺手拉起已装服务）', () => {
    assert.equal(fs.existsSync(PATHS.pidFile), false, '前置：无 pid 文件');
    assert.equal(restartModeOnChange(), null);
  });

  it('TUN 在跑且配置无 tun 字段（getRuntimeMode 会答 mixed）→ 仍按 tun 重启', () => {
    const pid = spawnFakeKernel();
    fs.writeFileSync(PATHS.pidFile, String(pid));
    assert.ok(waitUntilRunning(), '桩内核应已运行');

    assert.equal(restartModeOnChange(), 'tun');

    killLeftovers();
    fs.rmSync(PATHS.pidFile, { force: true });
  });
});
