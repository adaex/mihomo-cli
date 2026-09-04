import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LAUNCH_DAEMON_LABEL } from './constants.js';
import type { DirectoryTarget } from './types.js';

function getUserDataDir(): string {
  if (process.env.MIHOMO_CLI_DIR) {
    return process.env.MIHOMO_CLI_DIR;
  }
  return path.join(os.homedir(), '.mihomo-cli');
}

export const USER_DATA_DIR = getUserDataDir();

export const DIRS = {
  kernel: path.join(USER_DATA_DIR, 'kernel'),
  subscriptions: path.join(USER_DATA_DIR, 'subscriptions'),
  logs: path.join(USER_DATA_DIR, 'logs'),
  data: path.join(USER_DATA_DIR, 'data'),
  runtime: path.join(USER_DATA_DIR, 'runtime'),
  // ssh 隧道运行态。刻意独立于 runtime/：clearRuntime() 会在 stop() 成功路径 rmrf 整个
  // runtime 目录，隧道状态放那里会被 `mihomo stop` 连同 config.yaml 一起抹掉，
  // 于是「谁起的」标记丢失、手动起的隧道再也无法被识别
  ssh: path.join(USER_DATA_DIR, 'ssh'),
} as const;

export const PATHS = {
  mihomoBinary: path.join(DIRS.kernel, 'mihomo'),
  settingsFile: path.join(USER_DATA_DIR, 'settings.json'),
  subscriptionsCacheFile: path.join(DIRS.subscriptions, 'cache.json'),
  configFile: path.join(DIRS.runtime, 'config.yaml'),
  logFile: path.join(DIRS.logs, 'mihomo.log'),
  pidFile: path.join(DIRS.runtime, 'pid'),
  configStage1Subscription: path.join(DIRS.runtime, '1.subscription.yaml'),
  configStage2Overwrite: path.join(DIRS.runtime, '2.overwrite.yaml'),
  configStage3System: path.join(DIRS.runtime, '3.system.yaml'),
  // launchd LaunchDaemon plist 位于系统级 /Library/LaunchDaemons/，root:wheel 拥有，与 homedir / MIHOMO_CLI_DIR 无关
  launchDaemonPlist: path.join('/Library/LaunchDaemons', `${LAUNCH_DAEMON_LABEL}.plist`),
} as const;

export const DIRECTORY_TARGETS: Record<string, DirectoryTarget> = {
  root: { path: null, label: '根目录' },
  subs: { path: DIRS.subscriptions, label: '订阅目录' },
  logs: { path: DIRS.logs, label: '日志目录' },
  data: { path: DIRS.data, label: 'mihomo 数据目录' },
  runtime: { path: DIRS.runtime, label: '运行时目录' },
  kernel: { path: DIRS.kernel, label: '内核目录' },
};

export function ensureDirs(): void {
  for (const dir of Object.values(DIRS)) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

/**
 * 原子写文件：先写同目录临时文件再 rename（POSIX 下 rename 原子）。
 * 避免写入中途崩溃/磁盘满导致目标文件被截断为空或半截内容。
 * 临时名带 pid + 进程内自增序号：同一进程并发写同一目标（如 Promise.all 更新缓存）
 * 时各自落到独立临时文件，避免同名临时文件互相踩踏导致内容交错或 rename ENOENT。
 */
let atomicWriteSeq = 0;
export function atomicWriteFileSync(filePath: string, content: string, options?: { mode?: number }): void {
  const tmp = `${filePath}.${process.pid}.${atomicWriteSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, content, options);
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 锁等待上限：超过即判定持锁者已死（正常持锁只有几毫秒的同步读-改-写）。 */
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;

/**
 * 跨进程互斥执行 `fn`（同一 `filePath` 一把锁）。
 *
 * 为什么必须有：`settings.json` 的读-改-写此前无任何跨进程保护，两个 CLI 进程
 * （慢速 `sub add` 跨网络下载期间用户在另一个终端操作，是日常场景）会各自读到旧
 * 全量、各自写回，后写者把先写者的条目整块抹掉——**而先写者已经打印了「已添加」**。
 * 实测 6 个并发 `sub add` 丢 3 条；`ssh add` 被并发 `sub add` 抹成 null。
 * 仅靠「写前重读盘」不够：读与写之间仍有窗口，实测仍丢 3 条。
 *
 * 用 `O_EXCL` 建锁文件（POSIX 下创建即原子，NFS 外均可靠），忙等到拿到为止。
 * 陈旧锁（持有超过 LOCK_STALE_MS，说明持锁进程已崩溃）会被强夺，避免一次崩溃
 * 让后续所有命令永久卡死——宁可退回到无锁时的竞态，也不能把 CLI 锁死。
 *
 * `fn` 必须是同步的：持锁期间插入 await 会把锁按住整个异步等待，
 * 慢速网络下会让另一个进程等到强夺陈旧锁，等于没锁。
 */
export function withFileLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_STALE_MS;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // 锁被占：陈旧则强夺，否则短睡重试
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        // 锁文件刚被持有者释放，下一轮就能拿到
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* ignore：另一个进程可能同时在强夺 */
        }
        continue;
      }
      if (Date.now() > deadline) {
        // 兜底：等太久也强夺，绝不无限期卡住用户
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      sleepSyncMs(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 同步睡眠。不能用 sleep(ms) 的 Promise 版：持锁期间必须全程同步，不得让出事件循环。 */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
