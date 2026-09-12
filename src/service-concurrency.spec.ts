import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { LOCK_STALE_MS } from './paths.js';
import { SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS } from './service.js';

/**
 * 服务层两条并发防线的消费点验证。
 *
 * 为什么用「PATH 前置桩 launchctl + 子进程跑真实模块」而不是单测判据：
 * 这两条防线的缺陷都不在判据本身（shouldAbortStartOnDisable 有整组用例），而在
 * **消费点漏铺**——热重载成功路径不查计数、stop 锁体持锁超过强夺阈值。判据纯函数
 * 测不出来，只有把真实 restartService/stopService 跑起来才能咬住。而真实 launchctl
 * 写操作不进自动化测试（enable/disable 会在 /var/db/com.apple.xpc.launchd/ 留永久
 * 记录，见 CODE_REVIEW「自动化测试边界」）——桩 launchctl 让代码走真实路径、
 * launchd 一点不被碰。
 *
 * 隔离三层：MIHOMO_CLI_DIR 指临时数据目录（锁、epoch、settings 都在里面）；
 * MIHOMO_CLI_DAEMON_LABEL 用一次性 label；热重载场景另把 HOME 指向临时目录
 * （userAgentPlist 随 homedir 走，在数据目录之外，只有改 HOME 才能不碰真实
 * ~/Library/LaunchAgents——completion-install.spec 同法）。真实用到的系统工具只有
 * lsof（找桩 controller 的监听 pid）与 pgrep（隔离目录下匹配不到任何进程）。
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 一次性隔离三件套：数据目录、桩 HOME、桩 launchctl 所在 bin 目录 */
function makeFixture(prefix: string): { dataDir: string; fakeHome: string; fakeBin: string; label: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-bin-`));
  const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
  return { dataDir, fakeHome, fakeBin, label };
}

function cleanupFixture(fixture: { dataDir: string; fakeHome: string; fakeBin: string }): void {
  for (const dir of [fixture.dataDir, fixture.fakeHome, fixture.fakeBin]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 写桩 launchctl（PATH 前置后，子进程里所有 spawnSync('launchctl') 都落到这里） */
function writeFakeLaunchctl(fakeBin: string, body: string): string {
  const file = path.join(fakeBin, 'launchctl');
  fs.writeFileSync(file, `#!/bin/bash\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

interface ScriptRun {
  child: ChildProcess;
  /** 子进程 stdout 的第一行（协议：脚本先打印 `KEY:value` 再干活） */
  firstLine: Promise<string>;
  done: Promise<{ status: number | null; stdout: string; stderr: string }>;
}

/**
 * 起子进程跑一个 .mts 脚本（tsx 直跑，不经 index.ts 的入口守卫）。
 * 脚本内容在 runHotReloadScenario/runStopScenario 里拼装，导入真实 src 模块。
 */
function spawnScript(scriptFile: string, env: NodeJS.ProcessEnv, timeoutMs = 60_000): ScriptRun {
  const child = spawn(process.execPath, ['--import', 'tsx', scriptFile], { env });
  let stdout = '';
  let stderr = '';
  let resolveFirstLine: ((line: string) => void) | null = null;
  const firstLine = new Promise<string>(resolve => {
    resolveFirstLine = resolve;
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (resolveFirstLine !== null && stdout.includes('\n')) {
      const r = resolveFirstLine;
      resolveFirstLine = null;
      r(stdout.slice(0, stdout.indexOf('\n')));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    child.on('close', status => {
      clearTimeout(timer);
      // 子进程没活到打印第一行时也别让 firstLine 悬着（用例会因空行断言失败）
      if (resolveFirstLine !== null) {
        const r = resolveFirstLine;
        resolveFirstLine = null;
        r('');
      }
      resolve({ status, stdout, stderr });
    });
  });
  return { child, firstLine, done };
}

/** 测 service.lock 的持锁时长：锁文件出现（withFileLock 创建即持锁）到消失（释放即删） */
async function measureLockHold(lockPath: string, timeoutMs = 30_000): Promise<number> {
  const startWait = Date.now();
  while (!fs.existsSync(lockPath)) {
    assert.ok(Date.now() - startWait < timeoutMs, '锁文件应在子进程进入临界区后出现');
    await sleep(20);
  }
  const acquired = Date.now();
  while (fs.existsSync(lockPath)) {
    assert.ok(Date.now() - acquired < timeoutMs, '锁文件应被子进程释放');
    await sleep(20);
  }
  return Date.now() - acquired;
}

/** 把场景脚本写进临时目录（放 src/ 外，Biome/测试收集都不会碰到它） */
function writeScript(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const MODULES = {
  paths: JSON.stringify(path.resolve('src/paths.ts')),
  service: JSON.stringify(path.resolve('src/service.ts')),
  runtime: JSON.stringify(path.resolve('src/runtime.ts')),
};

/** 桩 launchctl（热重载场景）：print 恒报 running（pid 读自 PID_FILE）、print-disabled 空表（= 启用） */
const FAKE_LAUNCHCTL_HOT_RELOAD = `
# 只会被查到状态查询：热重载不碰 launchctl 写动词
case "$1" in
  print)
    printf '\\tstate = running\\n\\tpid = %s\\n' "$(cat "$PID_FILE")"
    exit 0
    ;;
  print-disabled)
    exit 0
    ;;
esac
exit 0
`;

/**
 * 热重载场景脚本：起一个桩 external-controller（/version 自报 mihomo、PUT /configs
 * 返回 204），让真实 launchOrRestart 走完「running 且未 disabled → restartService →
 * tryHotReload」全链路。BUMP=1 时在 PUT 到达的那一刻用真实 recordServiceStopped
 * 递增停止计数——复现「热重载刚被内核接受、并发的 stop 随即完成」这一交错。
 */
function hotReloadScript(): string {
  return `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { recordServiceStopped } from ${MODULES.service};
import { launchOrRestart } from ${MODULES.runtime};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/version') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"version":"stub-kernel"}');
  } else if (req.method === 'PUT' && req.url !== undefined && req.url.startsWith('/configs')) {
    if (process.env.BUMP === '1') recordServiceStopped();
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('node:net').AddressInfo).port;

// 桩 launchctl 报的 pid 与 lsof 查到的监听 pid 必须是同一个进程：就是本子进程
fs.writeFileSync(process.env.PID_FILE as string, String(process.pid));
fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
fs.writeFileSync(PATHS.userAgentPlist, 'stub');
fs.writeFileSync(PATHS.settingsFile, JSON.stringify({ ports: { mixed: 17890, controller: port } }));
fs.writeFileSync(PATHS.serviceStopEpoch, '5');

try {
  const pid = await launchOrRestart('mixed', 5);
  console.log('RESULT:pid=' + pid);
} catch (e) {
  console.log('RESULT:error=' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  server.close();
}
`;
}

/** stop 场景脚本：跑真实 stopService，先报锁路径（父进程据此测持锁时长），收尾报 epoch 终值 */
function stopScript(): string {
  return `import { PATHS } from ${MODULES.paths};
import { readStopEpoch, stopService } from ${MODULES.service};

console.log('LOCK:' + PATHS.serviceLock);
try {
  await stopService();
  console.log('RESULT:ok');
} catch (e) {
  console.log('RESULT:error=' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
} finally {
  console.log('EPOCH:' + readStopEpoch());
}
`;
}

describe('热重载成功路径的并发停止防线（launchOrRestart 消费点）', () => {
  /** 跑一次热重载场景。返回子进程退出码、完整 stdout 与 spawn 拿到的 pid */
  async function runHotReloadScenario(bump: boolean): Promise<{ status: number | null; stdout: string; stderr: string; pid: number | null }> {
    const fixture = makeFixture('mihomo-hotreload');
    const script = writeScript(fixture.fakeBin, 'hot-reload.mts', hotReloadScript());
    writeFakeLaunchctl(fixture.fakeBin, FAKE_LAUNCHCTL_HOT_RELOAD);
    const env = {
      ...process.env,
      MIHOMO_CLI_DIR: fixture.dataDir,
      MIHOMO_CLI_DAEMON_LABEL: fixture.label,
      HOME: fixture.fakeHome,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      PID_FILE: path.join(fixture.fakeBin, 'server.pid'),
      BUMP: bump ? '1' : '0',
      MIHOMO_CLI_ALLOW_ANY_PLATFORM: '1',
      NO_COLOR: '1',
    };
    try {
      const run = spawnScript(script, env);
      const result = await run.done;
      return { ...result, pid: run.child.pid ?? null };
    } finally {
      cleanupFixture(fixture);
    }
  }

  // 缺陷本体：热重载期间并发 stop 完成了 bootout+disable+递增（epoch 5→6，由
  // PUT 处理器用真实 recordServiceStopped 落地）。修复前 restartService 热重载成功
  // 即返回 started=true，launchOrRestart 照常报 pid；修复后必须走既有的
  // 「启动已取消」出口——这是用户可见的后果，不是实现细节
  it('热重载成功后计数已变 → 报「启动已取消」，不报已启动', async () => {
    const result = await runHotReloadScenario(true);

    assert.notEqual(result.status, 0, `应非 0 退出（并发停止须按取消处理），stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /RESULT:error=启动已取消：期间检测到停止操作/, `应对用户报并发取消，stdout: ${result.stdout}`);
  });

  // 负向对照：同样的链路、没有并发 stop（PUT 不递增），必须照常报成功并给出 pid
  // ——证明上一条的取消不是「热重载恒被拦」的假阳性
  it('无并发停止时热重载照常成功，返回的 pid 即桩 controller 的监听进程', async () => {
    const result = await runHotReloadScenario(false);

    assert.equal(result.status, 0, `应正常退出，stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(`RESULT:pid=${result.pid}\\b`), `应返回监听进程的 pid，stdout: ${result.stdout}`);
  });
});

describe('stop 锁内临界区的持锁预算', () => {
  /**
   * 桩 launchctl（stop 场景）：print 一律 113（未装载）、锁内三个动词（bootout、
   * disable、print-disabled 复核）各睡 delaySeconds 再成功——模拟病态慢的 launchctl。
   * print 不睡：它只在锁外的 waitUntilUnloaded 里被调，与持锁预算无关。
   */
  function fakeLaunchctlForStop(label: string, delaySeconds: number): string {
    return `
case "$1" in
  print)
    exit 113
    ;;
  print-disabled)
    sleep ${delaySeconds}
    printf '\\t\\t"${label}" => disabled\\n'
    exit 0
    ;;
  *)
    sleep ${delaySeconds}
    exit 0
    ;;
esac
`;
  }

  async function runStopScenario(delaySeconds: number): Promise<{ status: number | null; stdout: string; stderr: string; lockHoldMs: number }> {
    const fixture = makeFixture('mihomo-stopbudget');
    const script = writeScript(fixture.fakeBin, 'stop.mts', stopScript());
    writeFakeLaunchctl(fixture.fakeBin, fakeLaunchctlForStop(fixture.label, delaySeconds));
    const env = {
      ...process.env,
      MIHOMO_CLI_DIR: fixture.dataDir,
      MIHOMO_CLI_DAEMON_LABEL: fixture.label,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      MIHOMO_CLI_ALLOW_ANY_PLATFORM: '1',
      NO_COLOR: '1',
    };
    try {
      const run = spawnScript(script, env);
      const lockLine = await run.firstLine;
      assert.match(lockLine, /^LOCK:/, `子进程应先报锁路径，实际: ${JSON.stringify(lockLine)}`);
      const lockPath = lockLine.slice('LOCK:'.length);
      const lockHoldMs = measureLockHold(lockPath);
      const [result, hold] = await Promise.all([run.done, lockHoldMs]);
      return { ...result, lockHoldMs: hold };
    } finally {
      cleanupFixture(fixture);
    }
  }

  // 场景 A（缺陷本体）：launchctl 每次调用 4s——高于锁内单次预算 3s、低于旧默认 5s。
  // 修复前三次调用全部「慢而成功」，最坏持锁约 12s > LOCK_STALE_MS，并发 start 会在
  // 10s 判锁陈旧强夺进入，两进程同处临界区、epoch 判据被整体绕过。修复后第一次
  // 调用即超时失败：锁很快释放、stop 如实报错（病态系统上快速失败好过拆掉并发防线）
  it('launchctl 慢到超出锁内预算 → 快速失败且持锁不过强夺阈值', async () => {
    const result = await runStopScenario(4);

    assert.notEqual(result.status, 0, '超预算的 launchctl 应让 stop 报错而非慢慢熬完');
    assert.match(result.stdout, /RESULT:error=卸载旧服务实例失败/, `失败应指向第一个锁内调用，stdout: ${result.stdout}`);
    assert.match(result.stdout, /EPOCH:0/, '尚未确认停止就不该递增（bootout 失败在 disable 之前）');
    assert.ok(
      result.lockHoldMs < LOCK_STALE_MS,
      `最坏持锁必须低于强夺阈值 ${LOCK_STALE_MS}ms（实测 ${result.lockHoldMs}ms），否则并发 start 会强夺进入、epoch 判据被绕过`,
    );
  });

  // 场景 B（最坏形态）：launchctl 慢但在预算内（2.0s < 3s），锁内三次调用全部走完
  // （bootout、disable、print-disabled 复核、递增），这是「慢而成功」的真实最坏持锁。
  // 桩 sleep 取 2.0s 而非贴近预算的 2.9s：实测持锁 = 三次 sleep + 子进程调用开销，
  // 开销在并行负载下可膨胀数倍，sleep 贴边会让「持锁 < 强夺阈值」的断言在高负载下
  // 假失败（发布验证时实测过一次）；「调大单次预算 / 往锁内加第 4 次调用」的护栏由
  // 下面的常量关系断言承担，时序断言只兜「预算内的慢仍不破阈值」这一端
  it('慢而成功的 launchctl 走完全程，最坏持锁仍低于强夺阈值', async () => {
    const result = await runStopScenario(2.0);

    assert.equal(result.status, 0, `预算内的慢调用应全部成功，stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /RESULT:ok/, `stop 应成功，stdout: ${result.stdout}`);
    assert.match(result.stdout, /EPOCH:1/, '锁体完整执行：disable 复核通过后停止计数已递增');
    assert.ok(result.lockHoldMs < LOCK_STALE_MS, `最坏持锁必须低于强夺阈值 ${LOCK_STALE_MS}ms（实测 ${result.lockHoldMs}ms）`);
  });

  // 锁内 launchctl 调用次数 × 单次预算必须低于强夺阈值——「别再往锁内加东西」的
  // 机器可查形式。乘数 3 = 锁内三个环节（bootout、disable、print-disabled 复核）；
  // 往锁内加第 4 次调用时必须同步改乘数（3→4 即转红），逼着加之前先算总预算
  it('锁内预算的常量关系：调用次数 × 单次预算 < 强夺阈值', () => {
    const LOCK_INNER_LAUNCHCTL_CALLS = 3;
    assert.ok(
      LOCK_INNER_LAUNCHCTL_CALLS * SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS < LOCK_STALE_MS,
      `锁内 ${LOCK_INNER_LAUNCHCTL_CALLS} 次 launchctl × 单次 ${SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS}ms 已达/超 LOCK_STALE_MS(${LOCK_STALE_MS}ms)，并发 start 会在持锁期间强夺进入——加锁内调用或调大预算前先算总预算（并同步本断言的乘数）`,
    );
  });
});
