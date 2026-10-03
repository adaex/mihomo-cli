import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 假内核（桩「内核」）辅助：落盘、起进程、等出现、判死、收尾击杀，
 * runtime.spec 与 process-stop.spec 共用这一份（commands/stop.spec 复用其中同形片段）。
 *
 * 桩的形态：放在隔离数据目录 kernel/mihomo 位置的长睡 bash 脚本，用真实二进制名与
 * 真实 config 路径拼 `-d <data> -f <configFile>` 命令行，让 pgrep/pkill 能按生产
 * MAIN_INSTANCE_PATTERN 匹配到。隔离靠的不是约定，是物理事实：pattern 内嵌
 * kernel/runtime 的绝对路径，指向 tmpdir 后真实数据目录 ~/.mihomo-cli 下的内核不可能
 * 命中——这些辅助杀的只会是测试自己起的桩，不会碰用户正在跑的代理，全程免 sudo。
 *
 * **本模块不得静态 import paths.js / constants.js / process-probe.js**：它们在模块
 * 加载期求值 MIHOMO_CLI_DIR / MIHOMO_CLI_DAEMON_LABEL，spec 必须先设环境变量再动态
 * import（静态 import 会在 spec 设 env 之前求值、固化到真实数据目录）。所以目录
 * 布局、pattern、探测函数一律由调用方动态 import 后传参进来。
 *
 * 文件名不带 .spec 后缀：测试只收 *.spec.ts 结尾的文件，本支撑模块不会被当套件
 * 执行（同 test-support/cli.ts）。
 */

/** 桩内核脚本：长睡 300s，用例跑不到自然退出，收尾一律显式 kill */
const FAKE_KERNEL_SCRIPT = '#!/bin/bash\nsleep 300\n';

/** 桩配置：一行 mixed-port 即可，刻意不含 tun 字段——runtime.spec 依赖 getRuntimeMode
 * 由此答 mixed（TUN 在跑时仍必须答 tun）；其余消费方只需要文件存在 */
const FAKE_KERNEL_CONFIG = 'mixed-port: 7890\n';

export interface FakeKernelLayout {
  /** 桩二进制位置（默认形态 kernel/mihomo；服务符号链形态经 spawnFakeKernel 的 binary 参数另传） */
  binary: string;
  /** -d 数据目录（pattern 按命令行里的路径字符串匹配，目录本身无需存在） */
  dataDir: string;
  /** -f 配置文件 */
  configFile: string;
}

/**
 * 落盘桩内核文件：建目录、写长睡脚本二进制、写最小配置。binaries 是数组——真实
 * 二进制与服务符号链两种命令行形态都要能测（MAIN_INSTANCE_PATTERN 是二选一分支）。
 */
export function writeFakeKernelFiles(opts: { binaries: string[]; configFile: string; dirs?: string[] }): void {
  for (const dir of opts.dirs ?? []) fs.mkdirSync(dir, { recursive: true });
  for (const binary of opts.binaries) {
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, FAKE_KERNEL_SCRIPT, { mode: 0o755 });
  }
  fs.mkdirSync(path.dirname(opts.configFile), { recursive: true });
  fs.writeFileSync(opts.configFile, FAKE_KERNEL_CONFIG);
}

/** 起一个桩内核进程，返回 pid。detached + unref：桩进程独立于测试进程存活（模拟
 * 真实内核不随 CLI 退出），测试进程不跟踪其退出；stdio ignore——桩无输入输出 */
export function spawnFakeKernel(layout: FakeKernelLayout, binary: string = layout.binary): number {
  const child = spawn(binary, ['-d', layout.dataDir, '-f', layout.configFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid as number;
}

/**
 * 轮询等待谓词为真（50ms 步进，超时后再验一次并返回该次结果）。spawn 返回不代表
 * exec 完成：桩进程的命令行要等 ps/pgrep 能读到才算「在跑」。
 */
export function pollUntil(predicate: () => boolean, timeoutMs = 3000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    spawnSync('sleep', ['0.05']);
  }
  return predicate();
}

/**
 * 等桩进程真的出现在 pgrep 里、数量达到 count，返回满足条件时的 pid 列表。
 * listPids 传 getMihomoPids——与文件头约束同理，process-probe 由调用方动态 import 注入。
 */
export function waitForPids(count: number, listPids: () => number[], timeoutMs = 3000): number[] {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = listPids();
    if (pids.length >= count) return pids;
    spawnSync('sleep', ['0.05']);
  }
  return listPids();
}

/**
 * 进程是否真的死了。**不能用 `process.kill(pid, 0)`**：它对僵尸进程（已死但父进程
 * 尚未收割，detached 桩进程的常态）同样返回成功——这正是 v4.2.3 给 TUN 启动判活修过的
 * 同一个坑（见 process-start.ts）。判据以 ps 状态列为准：Z 开头或查不到都算死。
 */
export function isDead(pid: number): boolean {
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = (r.stdout || '').trim();
  return stat === '' || stat.startsWith('Z');
}

/** 兜底清理：任何一条用例漏杀都不该把桩进程留在开发机上（pattern 为 MAIN_INSTANCE_PATTERN，
 * 隔离依据见文件头注释） */
export function killLeftovers(pattern: string): void {
  spawnSync('pkill', ['-9', '-f', pattern], { timeout: 5000 });
}
