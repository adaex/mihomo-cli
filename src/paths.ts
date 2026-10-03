import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SERVICE_BINARY_NAME, SERVICE_LABEL } from './constants.js';
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
} as const;

// 内核面板自升级（POST /upgrade）的固定目录，命名由内核 updater 写死：
// meta-backup 存旧内核备份，meta-update 是下载暂存（成功后自清，残留即异常中断）。
// **不放进 DIRS**：其生命周期由内核 updater 自管，ensureDirs 预建会让它们被反复
//「复活」、doctor 永远误报
export const KERNEL_SELF_BACKUP_DIR = path.join(DIRS.kernel, 'meta-backup');
export const KERNEL_SELF_UPDATE_DIR = path.join(DIRS.kernel, 'meta-update');

export const PATHS = {
  mihomoBinary: path.join(DIRS.kernel, 'mihomo'),
  /**
   * 服务启动用的符号链（→ mihomoBinary，同目录相对链接）。
   * plist 的 ProgramArguments[0] 指向它而非真实二进制：「系统设置 → 通用 → 登录项与扩展」
   * 按 ProgramArguments[0] 的 basename 显示，直接指向内核的话用户只看到一个没有上下文的
   * "mihomo"，无从判断这是什么、能不能关掉。
   *
   * 注意：进程命令行记录的是**符号链路径**而非真实路径（实测 ps -ww -o command= 输出符号链名，
   * 用真实文件名 pgrep -f 匹配不到），故 MAIN_INSTANCE_PATTERN 必须同时匹配两者。
   */
  serviceBinary: path.join(DIRS.kernel, SERVICE_BINARY_NAME),
  settingsFile: path.join(USER_DATA_DIR, 'settings.json'),
  subscriptionsCacheFile: path.join(DIRS.subscriptions, 'cache.json'),
  configFile: path.join(DIRS.runtime, 'config.yaml'),
  logFile: path.join(DIRS.logs, 'mihomo.log'),
  pidFile: path.join(DIRS.runtime, 'pid'),
  /**
   * installService 的 plist 暂存文件（plutil -lint 校验通过后才原子写
   * 到 LaunchAgents，见 service.ts 的 atomicWriteFileSync 落位）。**不放 runtime/**：stage 要活到原子写落位那一刻，中间隔着 plutil、
   * bootout、waitUntilUnloaded（最多 5s）——此窗口并发 stop（游离内核路径 rmrf runtime/）
   * 或含 runtime 目标的 reset 删掉目录，读 stage 就裸 ENOENT。与锁文件同族
   * （「runtime 会被整体删除，不能放有生命周期的文件」），用后即删（service.ts finally）
   */
  servicePlistStage: path.join(USER_DATA_DIR, 'service.plist.stage'),
  /**
   * 跨进程锁文件。**全部以 `Lock` 结尾命名并放在 USER_DATA_DIR 根下**——这两点都是不变量，
   * `paths.spec.ts` 按命名约定枚举它们并断言位置，故新增锁只要照此命名就自动进回归测试。
   *
   * **锁绝不能放在会被整体删除的目录里**（`runtime/`、`logs/`、`data/`、`subscriptions/`、
   * `kernel/`）：`stop()` 的 clearRuntime() 与各 `reset` target 都会 `rmrf` 这些目录，
   * 把别的进程正持着的锁文件一起删掉——于是第三个进程立刻 `openSync(..., 'wx')` 成功，
   * 两个进程同时进临界区（实测复现）。withFileLock 的 token 所有权校验挡不住这种情形：
   * 它防的是「被强夺者误删新持有者的锁」，而这里锁是被第三方连目录一起删的，持锁方毫不知情。
   *
   * 各锁的可达竞态路径：
   * - serviceLock：慢速 start（订阅更新约 10s）持锁期间另一终端 stop
   * - subscriptionCacheLock：慢速 `sub update`（并行下载、逐条回写缓存）期间另一终端 `reset`
   */
  settingsLock: path.join(USER_DATA_DIR, 'settings.lock'),
  subscriptionCacheLock: path.join(USER_DATA_DIR, 'subscription-cache.lock'),
  serviceLock: path.join(USER_DATA_DIR, 'service.lock'),
  /**
   * 「服务被要求停止」的单调计数（`service.ts` 的 `bumpStopEpoch`/`readStopEpoch`，
   * 为什么用计数而非 disable 位见 docs/decisions.md D2）。
   *
   * 与锁同放 USER_DATA_DIR 根下：`runtime/` 等目录会被 `rmrf`，文件消失即读作 0，
   * 会让「期间发生过 stop」丢失。命名**刻意不以 `Lock` 结尾**——它不是锁，
   * 不该进 `paths.spec.ts` 那条锁位置断言的枚举。
   */
  serviceStopEpoch: path.join(USER_DATA_DIR, 'service-stop-epoch'),
  // 用户级 LaunchAgent（默认）：gui/<uid> 域，全程免 sudo。随 homedir 走
  userAgentPlist: path.join(os.homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`),
  // 旧版本（v3.0–v4.0 的 daemon on）装的系统级 LaunchDaemon：root:wheel 拥有。
  // 本版不再往这里安装，仅用于识别并清理遗留安装（它带 KeepAlive，不清就是抢端口的幽灵）
  systemDaemonPlist: path.join('/Library/LaunchDaemons', `${SERVICE_LABEL}.plist`),
} as const;

export const DIRECTORY_TARGETS: Record<string, DirectoryTarget> = {
  root: { path: null, label: '根目录' },
  subs: { path: DIRS.subscriptions, label: '订阅目录' },
  logs: { path: DIRS.logs, label: '日志目录' },
  data: { path: DIRS.data, label: '运行数据目录' },
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
 * 原子写文件：写同目录临时文件 → fsync → rename → fsync 目录。
 *
 * 保证范围分两层：
 * - **进程崩溃**：rename 原子（POSIX），目标文件要么旧要么新，不会截断半截
 * - **OS 崩溃/掉电**：无 fsync 时 rename 的元数据可先于数据块持久化，目标可能
 *   变空或半截（POSIX 不提供保证）。写前 fsync 临时文件 + rename 后 fsync 父目录
 *   把该窗口收窄到「fsync 返回后的掉电」。macOS 上严格落盘需 F_FULLFSYNC（Node
 *   无 API），普通 fsync 只到页缓存刷写——已知边界，接受：settings/cache 丢回
 *   上次成功写的状态可用，比静默截断强
 *
 * 临时名带 pid + 进程内自增序号：同一进程并发写同一目标（如 Promise.all 更新缓存）
 * 时各自落到独立临时文件，避免同名临时文件互相踩踏导致内容交错或 rename ENOENT。
 */
let atomicWriteSeq = 0;
export function atomicWriteFileSync(filePath: string, content: string, options?: { mode?: number }): void {
  const tmp = `${filePath}.${process.pid}.${atomicWriteSeq++}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', options?.mode ?? 0o600);
    try {
      // open(2) 的 mode 受 umask 掩蔽（mode 0644 在 umask 077 下实际 0600）；
      // fchmod 作用于 fd、不受掩蔽——mode 是调用方契约（如 plist 的 0644），
      // 不能随用户 shell 的 umask 漂移
      fs.fchmodSync(fd, options?.mode ?? 0o600);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
    // 持久化 rename 本身：目录项变更不 fsync 会随掉电回滚，目标退回旧内容甚至消失
    try {
      const dirFd = fs.openSync(path.dirname(filePath), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      /* 目录不可打开/fsync 不可用时退化到 rename-only：写本身已成功 */
    }
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

/**
 * 清扫崩溃遗留的临时产物（main 每次执行顺带跑一次，幂等、容错，失败不影响命令本身）：
 * - 原子写临时文件 `<目标>.<pid>.<n>.tmp`：进程在写与 rename 之间被杀时残留，
 *   `dir open root` 会把垃圾展示给用户
 * - 内核下载临时目录 `kernel/.tmp-*`（mkdtempSync）：下载/解压中被 kill -9 或断电时
 *   整个目录残留（可能含几十 MB 的 .gz），旧内核完好时用户没有理由 reset kernel，
 *   没有任何别的清理路径
 *
 * 只删修改时间超过 1 小时的——正在进行的原子写/下载（别的进程刚创建的）绝不能碰。
 */
export function cleanupStaleTmpFiles(): void {
  // atomicWriteFileSync 的目标分布在根目录（settings/cache/epoch）、subscriptions/
  // （原始订阅）与 runtime/（config.yaml）；kernel/ 是下载临时目录。四处都扫，
  // runtime 另有 stop/reset 整删兜底，其余三处的残留没有别的清理路径
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const dir of [USER_DATA_DIR, DIRS.subscriptions, DIRS.runtime, DIRS.kernel]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // 目录不存在/不可读时无事可做
    }
    for (const entry of entries) {
      // 原子写临时文件认 .tmp 后缀（四个目录都可能有）；.tmp- 前缀目录**只认
      // kernel/**——mkdtemp 的下载临时目录只建在那里，前缀不能在全数据目录通用，
      // 否则根目录将来出现别的 .tmp- 设施会被误扫。
      // check- 前缀目录只认根目录（config 校验的 mkdtemp，仅 finally 清理，SIGKILL
      // 即残留；曾放 runtime/，因整目录会被 rmrf 而迁出，见 validateConfigWithKernel）；
      // service.plist.stage 是 install 的 lint 载体（同样仅 finally 清理）
      const isAtomicTmpFile = entry.endsWith('.tmp');
      const isKernelTmpDir = dir === DIRS.kernel && entry.startsWith('.tmp-');
      const isConfigCheckTmpDir = dir === USER_DATA_DIR && entry.startsWith('check-');
      const isPlistStage = dir === USER_DATA_DIR && entry === 'service.plist.stage';
      if (!isAtomicTmpFile && !isKernelTmpDir && !isConfigCheckTmpDir && !isPlistStage) continue;
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).mtimeMs >= cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* 单个条目失败跳过 */
      }
    }
  }
}

/**
 * 锁等待上限：超过即判定持锁者已死（正常持锁只有几毫秒的同步读-改-写）。
 *
 * 导出仅供测试：service-concurrency.spec 断言「stop 锁内临界区最坏持锁低于该阈值」，
 * 用真实常量而非抄一个 10_000，两边漂移（有人调阈值、有人改锁内预算）时测试当场红。
 */
export const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;

/**
 * 跨进程互斥执行 `fn`（同一 `lockPath` 一把锁）。锁位置由 PATHS 集中决定、
 * 显式传锁文件路径——锁绝不能与数据文件同目录（数据目录会被 reset/stop 整删，
 * 见 PATHS 里锁常量的注释）。
 *
 * 为什么必须有：`settings.json` 的读-改-写若无跨进程保护，两个 CLI 进程（慢速
 * `sub add` 跨网络下载期间用户在另一个终端操作，是日常场景）会各自读到旧全量、
 * 各自写回，后写者把先写者的条目整块抹掉——**而先写者已经打印了「已添加」**
 * （实测 6 个并发 `sub add` 丢 3 条；仅靠「写前重读盘」不够，读与写之间仍有窗口）。
 *
 * 用 `O_EXCL` 建锁文件（POSIX 下创建即原子，NFS 外均可靠），忙等到拿到为止。
 * 陈旧锁（持有超过 LOCK_STALE_MS，说明持锁进程已崩溃）会被强夺，避免一次崩溃
 * 让后续所有命令永久卡死——宁可退回到无锁时的竞态，也不能把 CLI 锁死。
 *
 * **强夺的唯一依据是锁龄，没有「等太久也强夺」的旁路**：等待时长只说明「我等久了」，
 * 说明不了「锁无人持有」——能等到超时的场景，锁多半刚被另一个等待者按陈旧路径
 * 强夺，无条件强夺删掉的就是人家几毫秒前才建的新鲜锁（实测 B/C 临界区重叠 1.24s）。
 * 活性同样由锁龄保证：任何锁持有超 LOCK_STALE_MS 必然变陈旧、可被强夺，等待者
 * 不会无限期卡住。
 *
 * `fn` 必须是同步的：持锁期间插入 await 会把锁按住整个异步等待，
 * 慢速网络下会让另一个进程等到强夺陈旧锁，等于没锁。
 *
 * **释放前必须校验锁还是自己的**：被强夺者的 `finally` 若无条件 rm，删掉的是
 * **新持有者**的锁——第三方随即直接进门，与持锁者并发（三进程实测：A 持锁 12s
 * 被强夺 → B 持新锁 → A 释放时误删 → C 进门，B/C 并发 4.6s），发生的正是锁要防的
 * 静默丢数据且双方都拿到成功回执。故锁文件写入 `pid+hrtime` token，内容一致才删。
 *
 * **陈旧强夺路径自身仍有一个未关闭的双窃取者窗口（已接受风险）**：两个等待者
 * 同时 stat 到陈旧锁时，各自的 `rmSync 旧锁 → openSync(wx) 新锁` 不是原子的——
 * B 先夺到手后，C 在自己的 stat 与 rm 之间被挂起、恢复后会删掉 B 刚建的新鲜锁
 * 并自己 open 成功，B/C 同时进临界区；token 校验只防 finally 误删，撤不回已经
 * 并发的读-改-写。macOS 无用户态原子比较-删除原语（系统不自带 flock、Node 内置
 * 无建议锁），stat 之后的任何读后复核都只能缩小窗口并制造虚假安全感；彻底关闭
 * 需要更换锁原语。该残余仅在「持锁者已崩溃 + 至少两个等待者」同时成立时出现，
 * 与上文「陈旧锁退回无锁竞态」同一风险级别，不在这里做半吊子修补。
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  /**
   * 仅供测试把锁龄阈值缩放到毫秒级（LOCK_STALE_MS 是 10s 常量，真实等待太慢）；
   * 生产调用方不传，语义与默认常量完全一致。
   */
  opts?: { staleMs?: number },
): T {
  const staleMs = opts?.staleMs ?? LOCK_STALE_MS;
  const token = `${process.pid}-${process.hrtime.bigint()}`;
  let fd: number | null = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, token);
    } catch (e) {
      if (fd !== null) {
        // 创建成功但写 token 失败（如磁盘满）：关掉并删除这个空锁再抛，
        // 别留下一个无人认领、只能等 10s 强夺的锁
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
        fd = null;
        throw e;
      }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // 锁被占：陈旧则强夺，否则短睡重试
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
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
    // 释放前比对锁文件内容：仍是自己的 token 才删。锁被强夺后这里读到的是
    // 新持有者的 token（或其尚未写完的空内容），都不该动它
    try {
      if (fs.readFileSync(lockPath, 'utf8') === token) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch {
      /* ignore：锁文件已不在（正常）或读取失败 */
    }
  }
}

/** 同步睡眠。不能用 sleep(ms) 的 Promise 版：持锁期间必须全程同步，不得让出事件循环。 */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
