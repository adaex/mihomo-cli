import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DIRS, ensureDirs } from './paths.js';

/**
 * sudo 脚本执行超时：交互输密码 + 多步 root 操作的统一上限。
 * 导出供进程路径（killAllMihomo 的 sudo pkill 分支）引用同一常量：spawnSync 超时会把
 * 密码提示连同整个 sudo 子进程一起杀掉，别处自抄一个更短的数字，就是在给
 * 「密码输得慢的用户」埋「操作失败」的假象。
 */
export const SUDO_TIMEOUT_MS = 60_000;

/**
 * sudo 鉴权取消/密码错误（退出码 1）。独立类型而非裸 Error：调用方的包装层要区分
 * 「用户主动取消」（常规操作，label 用「已取消」）与「脚本内部失败」（≥2，真错误）。
 * 按消息文本匹配太脆——sudo.ts 里消息一改，判定就静默失效。
 */
export class SudoAuthError extends Error {
  constructor() {
    super('已取消或密码错误');
    this.name = 'SudoAuthError';
  }
}

interface SudoScriptOptions {
  /** 动作名，用于错误消息，如 "安装服务" */
  action: string;
  /** 临时脚本文件名（写在 DIRS.runtime 下，用后即删） */
  file: string;
  /** 脚本自定义退出码 → 错误消息（≥2，避开 sudo 的 1=取消/密码错误） */
  codeMessages?: Record<number, string>;
}

/**
 * sudo 退出码 → Error 的纯映射（runSudoScript 的可测内核）：
 * - 1 = sudo 鉴权取消/密码错误 → SudoAuthError。**即便 codeMessages 登记了 1 也不让**，
 *   退出码 1 不归脚本——legacy-cleanup 脚本曾用 exit 1 报 bootout 真实失败，
 *   被这里映射成「已取消或密码错误」，用户密码明明输对了
 * - null = sudo 进程被信号终止
 * - 其余非零码先查 codeMessages（脚本内部失败，约定 ≥2），未登记的落到「动作失败（退出码 N）」
 */
export function sudoExitToError(action: string, status: number | null, codeMessages?: Record<number, string>): Error {
  if (status === 1) return new SudoAuthError();
  if (status == null) return new Error(`${action}被中断（sudo 进程被信号终止）`);
  const custom = codeMessages?.[status];
  return new Error(custom ?? `${action}失败（退出码 ${status}）`);
}

/**
 * 写临时 bash 脚本并用单次交互式 sudo 执行（TUN 启动与系统级服务操作共用的范式）。
 * stdio:'inherit' 让 sudo 直接在 TTY 读密码；一个脚本内完成多步 root 操作，只弹一次密码。
 * 退出码 1 保留给 sudo 鉴权取消/密码错误；脚本内部失败用 ≥2 区分，映射见 sudoExitToError。
 */
export function runSudoScript(scriptBody: string, opts: SudoScriptOptions): void {
  if (!process.stdin.isTTY) {
    throw new Error('当前环境无法输入管理员密码（需要在交互式终端运行 sudo）');
  }

  ensureDirs();
  const scriptPath = path.join(DIRS.runtime, opts.file);
  fs.writeFileSync(scriptPath, scriptBody, { mode: 0o700 });
  // writeFileSync 的 mode 只在**创建新文件**时生效：前次崩溃残留的同名文件会保留
  // 其原有权限位（实测重写 0666 文件后仍是 0666），而本文件下一步就交给 sudo 执行。
  // 显式 chmod 才能保证「只有属主可写」，避免他人预置/篡改脚本内容。
  fs.chmodSync(scriptPath, 0o700);

  try {
    const result = spawnSync('sudo', [scriptPath], { stdio: 'inherit', timeout: SUDO_TIMEOUT_MS });
    if (result.error) throw result.error;
    if (result.status !== 0) throw sudoExitToError(opts.action, result.status, opts.codeMessages);
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }
}
