import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

// paths.ts 在 import 期求值 MIHOMO_CLI_DIR，故必须先设环境变量再动态 import。
//
// **隔离靠的不是约定，是物理事实**：MAIN_INSTANCE_PATTERN 内嵌 kernel/runtime 的
// 绝对路径（见 process-probe.ts），指向 tmpdir 后 pgrep/pkill 匹配的字符串里就是
// `/var/folders/.../kernel/mihomo`——真实数据目录 `~/.mihomo-cli` 下的内核不可能命中。
// 故这些测试杀的只会是自己起的桩进程，不会碰用户正在跑的代理。全程免 sudo。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-kill-'));
process.env.MIHOMO_CLI_DIR = tmpDir;

const { PATHS, DIRS } = await import('./paths.js');
const { getMihomoPids, isRunning, MAIN_INSTANCE_PATTERN } = await import('./process-probe.js');
const { cleanupAll, stop, clearPid } = await import('./process-stop.js');

/**
 * 桩「内核」：一个长睡的 bash 脚本，放在隔离目录的 kernel/mihomo 位置。
 * 用真实二进制名与真实 config 路径拼命令行，让 pgrep 能按生产 pattern 匹配到。
 */
function spawnFakeKernel(binary: string = PATHS.mihomoBinary): number {
  const child = spawn(binary, ['-d', DIRS.data, '-f', PATHS.configFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid as number;
}

/** 等桩进程真的出现在 pgrep 里（spawn 返回不代表 exec 完成） */
function waitForPids(count: number, timeoutMs = 3000): number[] {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = getMihomoPids();
    if (pids.length >= count) return pids;
    spawnSync('sleep', ['0.05']);
  }
  return getMihomoPids();
}

/** 进程是否真的死了。**不能用 `process.kill(pid, 0)`**：它对僵尸进程（已死但父进程
 * 尚未收割，detached 桩进程的常态）同样返回成功——这正是 v4.2.3 给 TUN 启动判活修过的
 * 同一个坑（见 process-start.ts）。判据以 ps 状态列为准：Z 开头或查不到都算死。 */
function isDead(pid: number): boolean {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = (r.stdout || '').trim();
  return stat === '' || stat.startsWith('Z');
}

/** 兜底清理：任何一条用例漏杀都不该把桩进程留在开发机上 */
function killLeftovers(): void {
  spawnSync('pkill', ['-9', '-f', MAIN_INSTANCE_PATTERN], { timeout: 5000 });
}

before(() => {
  fs.mkdirSync(DIRS.kernel, { recursive: true });
  fs.mkdirSync(DIRS.runtime, { recursive: true });
  fs.mkdirSync(DIRS.data, { recursive: true });
  // 真实二进制与服务符号链两种命令行形态都要能测（pattern 是二选一分支）
  fs.writeFileSync(PATHS.mihomoBinary, '#!/bin/bash\nsleep 300\n', { mode: 0o755 });
  fs.writeFileSync(PATHS.serviceBinary, '#!/bin/bash\nsleep 300\n', { mode: 0o755 });
  fs.writeFileSync(PATHS.configFile, 'mixed-port: 7890\n');
});

beforeEach(() => {
  killLeftovers();
});

after(() => {
  killLeftovers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 隔离前提本身也要断言——它是这组测试「无侵入」的唯一依据。
 * 若哪天 pattern 改成不含绝对路径（如只匹配进程名 `mihomo`），
 * 这些用例就会开始杀用户的真实内核，必须当场失败而不是静默扩大杀伤范围。
 */
describe('测试隔离前提', () => {
  it('pattern 内嵌隔离目录的绝对路径，不可能匹配到真实数据目录的内核', () => {
    assert.ok(MAIN_INSTANCE_PATTERN.includes(tmpDir), `pattern 必须锚定隔离目录，否则会误杀用户的真实内核: ${MAIN_INSTANCE_PATTERN}`);
    assert.equal(MAIN_INSTANCE_PATTERN.includes(path.join(os.homedir(), '.mihomo-cli')), false);
  });

  it('未起桩进程时探测为空（确认没串到别的进程）', () => {
    assert.deepEqual(getMihomoPids(), []);
  });
});

/**
 * cleanupAll 的副作用路径。此前只有纯函数被覆盖，「真的杀掉进程」这一段
 * 全靠手工验证——而 v4.2.1 的 pattern 编译失效正是从这里漏过去的。
 */
describe('cleanupAll 真实杀进程', () => {
  it('杀掉单个桩进程并如实计数', async () => {
    const pid = spawnFakeKernel();
    waitForPids(1);

    const result = await cleanupAll();

    assert.equal(result.killed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.remaining, []);
    assert.equal(getMihomoPids().length, 0, '进程必须真的没了，不是「调用没报错」');
    assert.ok(isDead(pid), '桩进程应已不存在（僵尸也算死，kill -0 在这里会骗人）');
  });

  it('走批量 pkill 分支（>3 个）时同样全部杀掉', async () => {
    for (let i = 0; i < 4; i++) spawnFakeKernel();
    const before = waitForPids(4);
    assert.equal(before.length, 4, `应有 4 个桩进程，实际 ${before.length}`);

    const result = await cleanupAll();

    assert.equal(result.killed, 4);
    assert.equal(result.failed, 0);
    assert.equal(getMihomoPids().length, 0);
  });

  it('符号链形态的命令行也被匹配到并杀掉（服务路径的进程形态）', async () => {
    spawnFakeKernel(PATHS.serviceBinary);
    waitForPids(1);

    const result = await cleanupAll();

    assert.equal(result.killed, 1);
    assert.equal(getMihomoPids().length, 0);
  });

  it('无进程时不报错，killed 为 0', async () => {
    const result = await cleanupAll();
    assert.equal(result.killed, 0);
    assert.equal(result.failed, 0);
  });

  it('清掉 pid 文件（残留会让后续 start 撞上死胡同）', async () => {
    fs.writeFileSync(PATHS.pidFile, '99999');
    await cleanupAll();
    assert.equal(fs.existsSync(PATHS.pidFile), false);
  });
});

describe('stop 真实停止', () => {
  it('有进程时杀干净并清理 runtime', async () => {
    spawnFakeKernel();
    waitForPids(1);
    fs.writeFileSync(PATHS.pidFile, '1');

    const result = await stop();

    assert.equal(result.success, true);
    assert.equal(result.notRunning, undefined);
    assert.equal(getMihomoPids().length, 0);
    assert.equal(fs.existsSync(PATHS.pidFile), false);
  });

  it('无进程时报 notRunning 而非谎报杀掉了什么', async () => {
    const result = await stop();
    assert.equal(result.success, true);
    assert.equal(result.notRunning, true);
  });

  // stop 会 rmrf runtime/，后续用例依赖 configFile 存在
  after(() => {
    fs.mkdirSync(DIRS.runtime, { recursive: true });
    fs.writeFileSync(PATHS.configFile, 'mixed-port: 7890\n');
  });
});

/**
 * isRunning 不裸信 pid 文件——系统重启后 PID 会被无关进程复用，
 * 只看存活会把别的进程误判成运行中的 mihomo。
 */
describe('isRunning 的 PID 复用防线', () => {
  it('pid 文件指向无关进程（本测试进程自己）时判为未运行', () => {
    fs.writeFileSync(PATHS.pidFile, String(process.pid));
    assert.equal(isRunning(), false, 'node 进程的命令行不含内核路径，不该被认成内核');
    clearPid();
  });

  it('pid 文件指向真实桩内核时判为运行中', async () => {
    const pid = spawnFakeKernel();
    waitForPids(1);
    fs.writeFileSync(PATHS.pidFile, String(pid));

    assert.equal(isRunning(), true);

    await cleanupAll();
  });

  it('pid 文件指向已死进程时判为未运行', () => {
    fs.writeFileSync(PATHS.pidFile, '999999');
    assert.equal(isRunning(), false);
    clearPid();
  });
});
