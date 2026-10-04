import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { LOCK_STALE_MS } from './paths.js';
import { SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS } from './service.js';
import { writeStubExecutable } from './test-support/stub-bin.js';

/**
 * 服务层两条并发防线的消费点验证。
 *
 * 为什么用「PATH 前置桩 launchctl + 子进程跑真实模块」而不是单测判据：
 * 这两条防线的缺陷都不在判据本身（shouldAbortStartOnDisable 有整组用例），而在
 * **消费点漏铺**——热重载成功路径不查计数、stop 锁体持锁超过强夺阈值。判据纯函数
 * 测不出来，只有把真实 restartService/stopService 跑起来才能咬住。而真实 launchctl
 * 写操作不进自动化测试（enable/disable 会在 /var/db/com.apple.xpc.launchd/ 留永久
 * 记录，见 CONCLUSIONS「自动化测试边界」）——桩 launchctl 让代码走真实路径、
 * launchd 一点不被碰。
 *
 * 隔离三层：MIHOMO_CLI_DIR 指临时数据目录（锁、epoch、settings 都在里面）；
 * MIHOMO_CLI_DAEMON_LABEL 用一次性 label；HOME 统一指临时目录（userAgentPlist
 * 随 homedir 走，在数据目录之外，只有改 HOME 才能不碰真实 ~/Library/LaunchAgents，
 * 场景 env 由 scenarioEnv 统一拼装）。真实用到的系统工具只有
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

/**
 * 场景子进程的标准 env：三层隔离（DIR/label/HOME）+ 桩 PATH 前置 + 跨平台放行，
 * extra 放场景变量（PID_FILE、FAKE_STATE 等）。HOME 统一指向桩目录——userAgentPlist
 * 随 homedir 走，不改 HOME 就会碰真实 ~/Library/LaunchAgents（此前个别场景漏设，
 * 属隔离缺口而非刻意差异）
 */
function scenarioEnv(fixture: { dataDir: string; fakeHome: string; fakeBin: string; label: string }, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIHOMO_CLI_DIR: fixture.dataDir,
    MIHOMO_CLI_DAEMON_LABEL: fixture.label,
    HOME: fixture.fakeHome,
    PATH: `${fixture.fakeBin}:${process.env.PATH}`,
    MIHOMO_CLI_ALLOW_ANY_PLATFORM: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

/** 写桩 launchctl（PATH 前置后，子进程里所有 spawnSync('launchctl') 都落到这里） */
function writeFakeLaunchctl(fakeBin: string, body: string): string {
  return writeStubExecutable(path.join(fakeBin, 'launchctl'), body);
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
 * 热重载场景脚本：起一个桩 external-controller（/version 自报 mihomo-cli、PUT /configs
 * 返回 204），让真实 launchOrRestart 走完「running 且未 disabled → restartService →
 * tryHotReload」全链路。BUMP=1 时在 PUT 到达的那一刻用真实 recordServiceStopped
 * 递增停止计数——复现「热重载刚被内核接受、并发的 stop 随即完成」这一交错。
 */
function hotReloadScript(): string {
  return `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { captureStopEpochBaseline, recordServiceStopped } from ${MODULES.service};
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
// 基线在此捕获（命令入口的等价位置）：BUMP 发生在捕获之后，计数变化才会被判定为并发
captureStopEpochBaseline();

try {
  const pid = await launchOrRestart('mixed');
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
    const env = scenarioEnv(fixture, {
      PID_FILE: path.join(fixture.fakeBin, 'server.pid'),
      BUMP: bump ? '1' : '0',
    });
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

describe('热重载探测查询失败时回退 kickstart（不把 launchctl 瞬时故障升级成命令失败）', () => {
  // 桩按全局调用计数切换：入口状态查询（第 1 次 print）报 running；热重载探测的
  // getServiceStatus（第 3 次 launchctl 调用 = 第 2 次 print）退 112（查询失败）；
  // kickstart 成功；其后的健康观察窗恢复 running。
  // 修复前第 3 次调用的 112 直接冒出 restartService → start 整体失败；修复后
  // tryHotReload 按契约回退 false、走 kickstart 自愈
  const FAKE_LAUNCHCTL_QUERY_FAILS = `
COUNT_FILE="$FAKE_BIN/count"
n=0
[ -f "$COUNT_FILE" ] && n=$(cat "$COUNT_FILE")
n=$((n+1))
echo "$n" > "$COUNT_FILE"
case "$1" in
  print)
    if [ "$n" -eq 3 ]; then exit 112; fi
    printf '\\tstate = running\\n\\tpid = %s\\n' "$(cat "$PID_FILE")"
    exit 0
    ;;
  print-disabled)
    exit 0
    ;;
  kickstart)
    exit 0
    ;;
esac
exit 0
`;

  function fallbackScript(): string {
    return `import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { captureStopEpochBaseline } from ${MODULES.service};
import { launchOrRestart } from ${MODULES.runtime};

fs.writeFileSync(process.env.PID_FILE as string, String(process.pid));
fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
fs.writeFileSync(PATHS.userAgentPlist, 'stub');
fs.writeFileSync(PATHS.settingsFile, JSON.stringify({ ports: { mixed: 17890, controller: 19090 } }));

// epoch 文件不存在（首启形态），基线捕获为 0；全程无并发 stop，应正常完成
captureStopEpochBaseline();

try {
  const pid = await launchOrRestart('mixed');
  console.log('RESULT:pid=' + pid);
} catch (e) {
  console.log('RESULT:error=' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
`;
  }

  it('热重载前的状态查询退 112 → 回退 kickstart 并健康确认成功', async () => {
    const fixture = makeFixture('mihomo-hotfail');
    const script = writeScript(fixture.fakeBin, 'hot-fail.mts', fallbackScript());
    writeFakeLaunchctl(fixture.fakeBin, FAKE_LAUNCHCTL_QUERY_FAILS.replaceAll('$FAKE_BIN', fixture.fakeBin));
    const env = scenarioEnv(fixture, { PID_FILE: path.join(fixture.fakeBin, 'server.pid') });
    try {
      const run = spawnScript(script, env);
      const result = await run.done;
      assert.equal(result.status, 0, `查询失败应回退而非报错，stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /RESULT:pid=\d+/, `应走 kickstart 并通过健康确认，stdout: ${result.stdout}`);
    } finally {
      cleanupFixture(fixture);
    }
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
    const env = scenarioEnv(fixture);
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

  // start 侧对称断言（第四轮修复复查补）：bootstrap 幂等吸收的 exit 5 复读 print
  // 是锁内增量调用，失败分支共三次（enable + bootstrap + print）。与 stop 侧同一
  // 把尺：乘数 × 单次预算 < 强夺阈值。此断言在第四轮修复初版缺失——预算破坏没有
  // 任何测试挡着，靠复查人工算出，补上对称断言防回归
  it('start 侧锁内预算：失败分支三次调用 × 单次预算 < 强夺阈值', () => {
    const START_LOCK_MAX_INNER_CALLS = 3;
    assert.ok(
      START_LOCK_MAX_INNER_CALLS * SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS < LOCK_STALE_MS,
      `start 侧失败分支 ${START_LOCK_MAX_INNER_CALLS} 次 launchctl × 单次 ${SERVICE_LOCK_LAUNCHCTL_TIMEOUT_MS}ms 已达/超 LOCK_STALE_MS(${LOCK_STALE_MS}ms)`,
    );
  });
});

/**
 * TUN 方向的并发防线消费点（与上面 mixed 方向对称）：
 *
 * 缺陷形态：cmdStart 的 loaded 守卫读的是命令开头的快照，TUN 分支此后有订阅更新
 * （约 10s）与 sudo 密码窗口（最长 60s）两个慢速阶段，期间另一终端 start（mixed）
 * 起的服务会被 TUN 脚本的 pkill 无差别杀掉，KeepAlive 拉回后与 root TUN 内核抢端口
 * ——mixed 侧的六条防线全在防「stop 被 start 覆盖」，这个反方向此前没有任何防线。
 *
 * 两道补防线各自验证：
 * 1. TUN 分支过守卫后 bump 停止计数（服务已 disabled/未装时走 recordServiceStopped，
 *    disable 路径本来就会 bump）——并发的 start 在锁内读到变化即放弃
 * 2. startTun 在执行含 pkill 的 sudo 脚本前复核服务装载状态，检出即中止
 */

/** 桩 launchctl（TUN 场景）：print 按 PRINT_MODE 报 113（未装载）或 running；print-disabled 报 disabled 表 */
const FAKE_LAUNCHCTL_TUN = `
case "$1" in
  print)
    if [ "${'$'}PRINT_MODE" = "running" ]; then
      printf '\\tstate = running\\n\\tpid = 4242\\n'
      exit 0
    fi
    exit 113
    ;;
  print-disabled)
    printf '\\t\\t"%s" => disabled\\n' "$MIHOMO_CLI_DAEMON_LABEL"
    exit 0
    ;;
esac
exit 0
`;

/** TUN 分支 bump 场景：跑真实 cmdStart(['tun'])，无订阅必然在中途抛错——断言抛错前计数已递增 */
function tunStartScript(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { readStopEpoch } from ${MODULES.service};
import { cmdStart } from ${JSON.stringify(path.resolve('src/commands/start.ts'))};

// 服务已安装 + disabled（起 TUN 的最常见前置：上次 stop/tun 留下的位）
fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
fs.writeFileSync(PATHS.userAgentPlist, 'stub');
fs.mkdirSync(path.dirname(PATHS.mihomoBinary), { recursive: true });
fs.writeFileSync(PATHS.mihomoBinary, 'stub-kernel');

try {
  // cmdStart 收到的 argv 带命令头（registry 恒等透传、shared.ts 显式拼 ['start', ...]）
  await cmdStart(['start', 'tun']);
  console.log('RESULT:unexpected-ok');
} catch (e) {
  console.log('RESULT:error=' + (e instanceof Error ? e.message : String(e)).split('\\n')[0]);
} finally {
  console.log('EPOCH:' + readStopEpoch());
}
`;
}

/** startTun 复核场景：跑真实 startTun，前置文件齐全，服务装载与否由桩 PRINT_MODE 决定 */
function startTunProbeScript(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { startTun } from ${JSON.stringify(path.resolve('src/process-start.ts'))};

fs.mkdirSync(path.dirname(PATHS.mihomoBinary), { recursive: true });
fs.writeFileSync(PATHS.mihomoBinary, 'stub-kernel');
fs.mkdirSync(path.dirname(PATHS.configFile), { recursive: true });
fs.writeFileSync(PATHS.configFile, 'stub-config');

try {
  await startTun();
  console.log('RESULT:unexpected-ok');
} catch (e) {
  console.log('RESULT:error=' + (e instanceof Error ? e.message : String(e)).split('\\n')[0]);
}
`;
}

describe('TUN 方向的并发防线（cmdStart bump 与 startTun 复核的消费点）', () => {
  async function runTunScript(script: string, printMode: 'unloaded' | 'running'): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const fixture = makeFixture('mihomo-tun');
    const file = writeScript(fixture.fakeBin, 'tun-scenario.mts', script);
    writeFakeLaunchctl(fixture.fakeBin, FAKE_LAUNCHCTL_TUN);
    const env = scenarioEnv(fixture, { PRINT_MODE: printMode });
    try {
      const result = await spawnScript(file, env).done;
      return result;
    } finally {
      cleanupFixture(fixture);
    }
  }

  // 防线 1（缺陷本体）：TUN 分支在慢速阶段之前把「服务该停着」落地为计数递增。
  // 场景让命令在订阅阶段抛「没有订阅」——它发生在 bump 之后，故 finally 里读到
  // EPOCH:1 即证明 bump 先于慢速阶段落地（修复前服务已 disabled 时无人 bump，读到 0）
  it('start tun 在慢速阶段之前递增停止计数（并发 start 锁内可检出）', async () => {
    const result = await runTunScript(tunStartScript(), 'unloaded');

    assert.match(result.stdout, /RESULT:error=没有订阅/, `无订阅应中断命令，stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /EPOCH:1/, `TUN 分支过 loaded 守卫后应递增停止计数（并发 start 的锁内判据依赖它），stdout: ${result.stdout}`);
  });

  // 防线 2（缺陷本体）：服务在 TUN 启动路径的慢速阶段里被并发 start 拉起时，
  // startTun 必须在 pkill 之前检出并中止——否则脚本杀掉服务内核，KeepAlive 拉回后
  // 与 root TUN 内核互抢端口。TUN 未启动、服务的运行不动
  it('startTun 复核点检出服务已装载 → 报并发 start 并中止，不执行 pkill', async () => {
    const result = await runTunScript(startTunProbeScript(), 'running');

    assert.match(
      result.stdout,
      /RESULT:error=另一终端已启动 Mixed 服务，TUN 未启动/,
      `应报并发 start 并中止，stdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  });

  // 负向对照：服务未装载时复核必须放行（走到 sudo 环节，测试环境非 TTY 报 sudo 错误）
  // ——证明上一条的中止不是「复核恒拦」的假阳性
  it('服务未装载时复核放行，继续走启动路径', async () => {
    const result = await runTunScript(startTunProbeScript(), 'unloaded');

    assert.doesNotMatch(result.stdout, /另一终端已启动/, `未装载时不得误报并发 start，stdout: ${result.stdout}`);
    // 锚定失败点：必须真的走到了 sudo 环节（非 TTY 下 runSudoScript 早抛），
    // 否则场景若在复核点之前因无关原因出错，上面两条 doesNotMatch 仍恒绿
    assert.match(result.stdout, /RESULT:error=当前环境无法输入管理员密码/, `复核放行后应走到 sudo（非 TTY 报错），stdout: ${result.stdout}`);
  });

  // 顺序防线：装载复核必须先于日志轮转。回归场景是「cmdStart 的 loaded 守卫之后
  // 另一终端拉起了 Mixed 服务」——旧顺序下 startTun 会把在跑服务的 mihomo.log
  // rename 进归档才拒绝（launchd fd 继续写归档，`logs 0` 从此看不到服务的新日志）；
  // 复核前置后，拒绝时日志原样未动
  it('服务已装载时复核先于日志轮转：拒绝时 mihomo.log 原样未动、无归档产生', async () => {
    const script = `import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { startTun } from ${JSON.stringify(path.resolve('src/process-start.ts'))};

fs.mkdirSync(path.dirname(PATHS.mihomoBinary), { recursive: true });
fs.writeFileSync(PATHS.mihomoBinary, 'stub-kernel');
fs.mkdirSync(path.dirname(PATHS.configFile), { recursive: true });
fs.writeFileSync(PATHS.configFile, 'stub-config');
fs.mkdirSync(path.dirname(PATHS.logFile), { recursive: true });
fs.writeFileSync(PATHS.logFile, 'service-log-line\\n');

try {
  await startTun();
  console.log('RESULT:unexpected-ok');
} catch (e) {
  console.log('RESULT:error=' + (e instanceof Error ? e.message : String(e)).split('\\n')[0]);
}
const intact = fs.existsSync(PATHS.logFile) && fs.readFileSync(PATHS.logFile, 'utf8') === 'service-log-line\\n';
console.log('LOG_INTACT:' + intact);
`;
    const result = await runTunScript(script, 'running');

    assert.match(result.stdout, /RESULT:error=另一终端已启动 Mixed 服务，TUN 未启动/, `应报并发 start 并中止，stdout: ${result.stdout}`);
    assert.match(result.stdout, /LOG_INTACT:true/, `拒绝时日志不得被轮转（旧顺序会先 rename 进归档），stdout: ${result.stdout}`);
  });
});

/**
 * 并发同向 start 的 bootstrap 撞车吸收。
 *
 * 场景：三个进程同时走真实 startService（锁外阶段在命令层，此处三方的竞争点
 * 就是锁内 enable+bootstrap）。第一个 bootstrap 成功后，后两个会撞上「任务已装载」，
 * 真实 launchd 报 exit 5（本机实测：Bootstrap failed: 5: Input/output error）——
 * 与「bootstrap disabled 标签」的 exit 5 完全同形，而 5 在本项目语境被多处注释
 * 关联到 disabled，用户会被指向完全错误的排查方向，服务实际健康在跑。
 * 桩 launchctl 用状态文件模拟装载与否：race 模式下第二次起 bootstrap 报 exit 5、
 * print 报已装载（应被吸收为幂等成功）；never-load 模式下 bootstrap 恒 exit 5 且
 * print 报未装载（disabled 形态的真失败，必须仍报错——负向对照，锁死不吸收半边）。
 */
const FAKE_LAUNCHCTL_BOOTSTRAP = `
# slow 模式：全部命令先睡 FAKE_DELAY 秒再返回——模拟病态慢的 launchctl。
# 锁内被测的是 enable/bootstrap（+失败分支的 print）三个动词；锁外的 bootout 与
# waitUntilUnloaded 轮询同样会睡，只拉长锁外阶段、不影响持锁时长测量
if [ "$FAKE_MODE" = 'slow' ]; then
  sleep "$FAKE_DELAY"
fi
case "$1" in
  bootstrap)
    if [ "$FAKE_MODE" = 'never-load' ] || [ -f "$FAKE_STATE" ]; then
      echo 'Bootstrap failed: 5: Input/output error' >&2
      exit 5
    fi
    touch "$FAKE_STATE"
    exit 0
    ;;
  print)
    if [ -f "$FAKE_STATE" ]; then
      printf '\\tstate = running\\n\\tpid = 4321\\n'
      exit 0
    fi
    exit 113
    ;;
  print-disabled)
    exit 0
    ;;
  enable)
    exit 0
    ;;
  bootout)
    rm -f "$FAKE_STATE"
    exit 0
    ;;
esac
exit 0
`;

function startServiceProbeScript(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { startService } from ${MODULES.service};

// startService 内部 ensureServiceSymlink 要求内核文件存在（hasKernel 判据），
// isServiceInstalled 查 userAgentPlist（HOME 已指向隔离目录），运行配置须存在且非 TUN
fs.mkdirSync(path.dirname(PATHS.mihomoBinary), { recursive: true });
fs.writeFileSync(PATHS.mihomoBinary, 'stub-kernel');
fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
fs.writeFileSync(PATHS.userAgentPlist, 'stub');
fs.mkdirSync(path.dirname(PATHS.configFile), { recursive: true });
fs.writeFileSync(PATHS.configFile, 'mixed-port: 17890\\n');

// 先报锁路径（父进程据此测持锁时长），再走真实 startService。
// 未显式 captureStopEpochBaseline：基线退化为 startService 调用时的当前值
// （epoch 文件不存在 = 0），锁内复读同值，不触发并发取消——本场景只验幂等撞车
console.log('LOCK:' + PATHS.serviceLock);
try {
  const r = await startService();
  console.log('RESULT:started=' + r.started);
} catch (e) {
  console.log('RESULT:error=' + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
}
`;
}

describe('并发同向 start：bootstrap 撞已装载按幂等成功（exit 5 复读 print 区分）', () => {
  async function runBootstrapRace(mode: 'race' | 'never-load', children: number): Promise<{ status: number | null; stdout: string; stderr: string }[]> {
    const fixture = makeFixture('mihomo-bootstrap-race');
    const script = writeScript(fixture.fakeBin, 'start-service.mts', startServiceProbeScript());
    writeFakeLaunchctl(fixture.fakeBin, FAKE_LAUNCHCTL_BOOTSTRAP);
    const env = scenarioEnv(fixture, { FAKE_STATE: path.join(fixture.fakeBin, 'loaded.state'), FAKE_MODE: mode });
    try {
      const runs = Array.from({ length: children }, () => spawnScript(script, env));
      return await Promise.all(runs.map(r => r.done));
    } finally {
      cleanupFixture(fixture);
    }
  }

  it('三个进程同时 startService：全部 started=true，无「退出码 5」误报', async () => {
    const results = await runBootstrapRace('race', 3);

    for (const [i, r] of results.entries()) {
      assert.equal(r.status, 0, `进程 ${i} 应正常退出，stdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert.match(r.stdout, /RESULT:started=true/, `进程 ${i} 应幂等成功，stdout: ${r.stdout}`);
    }
  });

  // 负向对照：bootstrap 失败且 print 未装载（disabled 残留 / I/O error 的真失败形态）
  // 必须仍报错——证明上面的吸收只认「已装载」，不是「exit 5 全吞」的假阳性
  it('bootstrap exit 5 且未装载：仍报「启动服务失败（退出码 5）」，不被吸收', async () => {
    const results = await runBootstrapRace('never-load', 1);

    assert.equal(results.length, 1);
    assert.notEqual(results[0].status, 0, `应非 0 退出，stdout: ${results[0].stdout}`);
    assert.match(results[0].stdout, /RESULT:error=启动服务失败（launchctl 退出码 5）/, `stdout: ${results[0].stdout}`);
  });

  // 与 stop 侧对称的持锁预算时序用例（第四轮复查批补 3s 统一后的行为面）：
  // 慢 launchctl 桩下 startService 的「快速失败」与「慢而成功」两态
  async function runBootstrapSlow(delaySeconds: number): Promise<{ status: number | null; stdout: string; stderr: string; lockHoldMs: number }> {
    const fixture = makeFixture('mihomo-startbudget');
    const script = writeScript(fixture.fakeBin, 'start-service-slow.mts', startServiceProbeScript());
    writeFakeLaunchctl(fixture.fakeBin, FAKE_LAUNCHCTL_BOOTSTRAP);
    const env = scenarioEnv(fixture, {
      FAKE_STATE: path.join(fixture.fakeBin, 'loaded.state'),
      FAKE_MODE: 'slow',
      FAKE_DELAY: String(delaySeconds),
    });
    try {
      const run = spawnScript(script, env);
      const lockLine = await run.firstLine;
      assert.match(lockLine, /^LOCK:/, `子进程应先报锁路径，实际: ${JSON.stringify(lockLine)}`);
      const lockHoldMs = measureLockHold(lockLine.slice('LOCK:'.length));
      const [result, hold] = await Promise.all([run.done, lockHoldMs]);
      return { ...result, lockHoldMs: hold };
    } finally {
      cleanupFixture(fixture);
    }
  }

  // 场景 A：launchctl 每次调用 4s——高于锁内单次预算 3s（旧默认 5s 时代 enable/bootstrap
  // 慢而成功、失败分支三次 15s 必破强夺线）。统一 3s 后第一次锁内调用即超时：锁 ~3s
  // 释放、start 如实报错——病态系统上快速失败好过持锁超时效掉并发防线（stop 侧同论证）
  it('launchctl 慢到超预算 → 第一次锁内调用快速失败，持锁不过强夺阈值', async () => {
    const result = await runBootstrapSlow(4);

    assert.notEqual(result.status, 0, '超预算的 launchctl 应让 start 报错而非慢慢熬完');
    assert.match(result.stdout, /RESULT:error=启用服务失败/, `失败应指向第一个锁内调用，stdout: ${result.stdout}`);
    assert.ok(
      result.lockHoldMs < LOCK_STALE_MS,
      `最坏持锁必须低于强夺阈值 ${LOCK_STALE_MS}ms（实测 ${result.lockHoldMs}ms），否则并发 stop 会强夺进入、epoch 判据被绕过`,
    );
  });

  // 场景 B（最坏形态）：launchctl 慢但在预算内（2.0s < 3s），锁内调用全部走完。
  // sleep 取 2.0s 不贴边：实测持锁含子进程调用开销，开销在并行负载下可膨胀数倍，
  // 贴边会让「持锁 < 强夺阈值」的断言在高负载下假失败（与 stop 侧同因）
  it('慢而成功的 launchctl 走完全程，最坏持锁仍低于强夺阈值', async () => {
    const result = await runBootstrapSlow(2.0);

    assert.equal(result.status, 0, `预算内的慢调用应全部成功，stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /RESULT:started=true/, `start 应成功，stdout: ${result.stdout}`);
    assert.ok(result.lockHoldMs < LOCK_STALE_MS, `最坏持锁必须低于强夺阈值 ${LOCK_STALE_MS}ms（实测 ${result.lockHoldMs}ms）`);
  });
});

/**
 * 结构不变量：并发基线是命令入口捕获的进程状态，不是 startService 调用时刻的值。
 * 场景为 sub use / ow on|off 触发重启的链路——main() 在命令入口 capture 后，
 * cmdSubscription 先下载订阅（慢速阶段，可能 10s+），期间另一终端 stop（bump），
 * 随后 restartToApply 重入 cmdStart → startService。基线若挪进 cmdStart（重入时刻，
 * 慢速阶段之后），bump 会被算进基线、并发 stop 漏检——此用例锁死 capture 的位置语义。
 */
describe('并发基线是命令入口的进程状态（restartToApply 慢速阶段链路）', () => {
  function restartAfterSlowPhaseScript(): string {
    return `import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from ${MODULES.paths};
import { captureStopEpochBaseline, recordServiceStopped, startService } from ${MODULES.service};

fs.mkdirSync(path.dirname(PATHS.mihomoBinary), { recursive: true });
fs.writeFileSync(PATHS.mihomoBinary, 'stub-kernel');
fs.mkdirSync(path.dirname(PATHS.userAgentPlist), { recursive: true });
fs.writeFileSync(PATHS.userAgentPlist, 'stub');
fs.mkdirSync(path.dirname(PATHS.configFile), { recursive: true });
fs.writeFileSync(PATHS.configFile, 'mixed-port: 17890\\n');

// 命令入口（main() 的等价位置）：早于订阅下载等慢速阶段
captureStopEpochBaseline();
// 慢速阶段期间另一终端跑完 stop（stop 锁内 bump 后才 waitUntilUnloaded，此处直接 bump 即等价）
recordServiceStopped();

const r = await startService();
console.log('RESULT:started=' + r.started);
`;
  }

  it('capture 先于慢速阶段的 bump：重启被取消（started=false），stop 不被覆盖', async () => {
    const fixture = makeFixture('mihomo-baseline-order');
    const script = writeScript(fixture.fakeBin, 'baseline-order.mts', restartAfterSlowPhaseScript());
    writeFakeLaunchctl(fixture.fakeBin, FAKE_LAUNCHCTL_BOOTSTRAP);
    const env = scenarioEnv(fixture, { FAKE_STATE: path.join(fixture.fakeBin, 'loaded.state'), FAKE_MODE: 'race' });
    try {
      const result = await spawnScript(script, env).done;
      assert.equal(result.status, 0, `应正常退出，stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stdout, /RESULT:started=false/, `基线先于 bump，锁内应判定并发停止并放弃启动，stdout: ${result.stdout}`);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
