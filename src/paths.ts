import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
 */
export function atomicWriteFileSync(filePath: string, content: string, options?: { mode?: number }): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
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
