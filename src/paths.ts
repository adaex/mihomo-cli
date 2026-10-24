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
   * - subscriptionCommitLock：同一订阅的 YAML 与缓存提交、缓存失败回滚必须作为一个串行区间
   */
  settingsLock: path.join(USER_DATA_DIR, 'settings.lock'),
  subscriptionCacheLock: path.join(USER_DATA_DIR, 'subscription-cache.lock'),
  subscriptionCommitLock: path.join(USER_DATA_DIR, 'subscription-commit.lock'),
  serviceLock: path.join(USER_DATA_DIR, 'service.lock'),
  /**
   * 「服务被要求停止」的单调计数（`stop-epoch.ts` 的 `bumpStopEpoch`/`readStopEpoch`，
   * 为什么用计数而非 disable 位见 docs/decisions.md D2）。
   *
   * 与锁同放 USER_DATA_DIR 根下：`runtime/` 等目录会被 `rmrf`，文件消失即读作 0，
   * 会让「期间发生过 stop」丢失。命名**刻意不以 `Lock` 结尾**——它不是锁，
   * 不该进 `paths.spec.ts` 那条锁位置断言的枚举。
   */
  serviceStopEpoch: path.join(USER_DATA_DIR, 'service-stop-epoch'),
  // 用户级 LaunchAgent（默认）：gui/<uid> 域，全程免 sudo。随 homedir 走
  userAgentPlist: path.join(os.homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`),
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
 * - 内核下载临时目录 `kernel/.tmp-XXXXXX`（mkdtempSync）：下载/解压中被 kill -9 或断电时
 *   整个目录残留（可能含几十 MB 的 .gz），旧内核完好时用户没有理由 reset kernel，
 *   没有任何别的清理路径
 *
 * 只删修改时间超过 1 小时、且名称与类型都符合 CLI 实际产物的条目——正在进行的
 * 原子写/下载（别的进程刚创建的）与形态不符的用户文件绝不能碰。
 */
export function cleanupStaleTmpFiles(): void {
  // atomicWriteFileSync 的目标分布在根目录（settings/cache/epoch）、subscriptions/
  // （原始订阅）与 runtime/（config.yaml）；kernel/ 是下载临时目录。四处都扫，
  // runtime 另有 stop/reset 整删兜底，其余三处的残留没有别的清理路径
  const cutoff = Date.now() - 60 * 60 * 1000;
  const isCliMkdtempEntry = (entry: string, prefix: string): boolean => {
    const suffix = entry.startsWith(prefix) ? entry.slice(prefix.length) : '';
    // 全小写六字母与 check-backup/.tmp-backup 这类手工目录不可区分。清扫宁可漏掉
    // mkdtemp 理论上也偶发生成的全小写名，也不拿用户数据换这点覆盖率。
    return /^[A-Za-z0-9]{6}$/.test(suffix) && /[A-Z0-9]/.test(suffix);
  };
  for (const dir of [USER_DATA_DIR, DIRS.subscriptions, DIRS.runtime, DIRS.kernel]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // 目录不存在/不可读时无事可做
    }
    for (const entry of entries) {
      // 原子写只认完整的 <目标>.<pid>.<序号>.tmp 文件名，且必须是文件；
      // mkdtemp 只认保守的六位随机后缀目录，位置仍分别限定在 kernel/ 与数据根。
      // service.plist.stage 是文件；lstat 让符号链接也不会被当成 CLI 产物删除。
      const isAtomicTmpFile = /^.+\.\d+\.\d+\.tmp$/.test(entry);
      const isKernelTmpDir = dir === DIRS.kernel && isCliMkdtempEntry(entry, '.tmp-');
      const isConfigCheckTmpDir = dir === USER_DATA_DIR && isCliMkdtempEntry(entry, 'check-');
      const isPlistStage = dir === USER_DATA_DIR && entry === 'service.plist.stage';
      if (!isAtomicTmpFile && !isKernelTmpDir && !isConfigCheckTmpDir && !isPlistStage) continue;
      const full = path.join(dir, entry);
      try {
        const stat = fs.lstatSync(full);
        if ((isAtomicTmpFile || isPlistStage) && !stat.isFile()) continue;
        if ((isKernelTmpDir || isConfigCheckTmpDir) && !stat.isDirectory()) continue;
        if (stat.mtimeMs >= cutoff) continue;
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
 * 跨进程互斥执行 `fn`（同一 `lockPath` 一把锁）。锁文件绝不能与数据文件同目录
 * （数据目录会被 reset/stop 整删，见 PATHS 里锁常量的注释）。
 *
 * 必要性：settings.json 等的读-改-写无跨进程保护时，后写者会把先写者的条目整块抹掉，
 * 而先写者已打印成功（实测并发 `sub add` 丢条目）。
 *
 * 机制与不变量：
 * - `O_EXCL` 建锁文件，忙等直到拿到
 * - 强夺的**唯一依据是锁龄**（> LOCK_STALE_MS 视为持锁者已崩溃）——等得久不代表锁无人持有，
 *   无条件强夺会删掉别人刚建的新鲜锁；活性同样由锁龄保证
 * - `fn` 必须同步：持锁期间 await 等于把锁按住整个异步等待，等到被强夺即等于没锁
 * - 锁文件写入 `pid+hrtime` token，释放时内容一致才删——被强夺者的 finally 不得删掉新持有者的锁
 *
 * 已接受风险：两个等待者同时 stat 到陈旧锁时，`rm 旧锁 → open(wx)` 非原子，可能双双进入
 * 临界区。macOS 无用户态原子比较-删除原语，仅在「持锁者已崩溃 + ≥2 个等待者」时出现，
 * 与「陈旧锁退回无锁竞态」同级，不做半吊子修补。
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
