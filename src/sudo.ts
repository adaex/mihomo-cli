import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ensureDirs, USER_DATA_DIR } from './paths.js';

/**
 * sudo 脚本执行超时：交互输密码 + 多步 root 操作的统一上限。
 * spawnSync 超时会把密码提示连同整个 sudo 子进程一起杀掉，别处自抄一个更短的数字，
 * 就是在给「密码输得慢的用户」埋「操作失败」的假象。
 * 导出供 runSudoScript 自身与 process-stop.spec 的「交互式 spawnSync 不得自抄超时」
 * 哨兵断言引用同一常量。
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

/**
 * sudo 失败的用户可见短语：取消/密码错误归一说法，其余失败**保留原始 message**——
 * runSudoScript 的非鉴权错误自带具体原因（如非交互环境无法输密码），笼统说
 * 「sudo 执行失败」会把修复方式（换交互终端重跑）藏掉。
 * 各命令的警告文案共用这一份——各写一份会漂移出两三种说法
 */
export function describeSudoFailure(e: Error): string {
  return e instanceof SudoAuthError ? 'sudo 已取消或密码错误' : e.message;
}

interface SudoScriptOptions {
  /** 动作名，用于错误消息，如 "安装服务" */
  action: string;
  /** 临时脚本文件名（写在数据根目录下，用后即删） */
  file: string;
  /** 脚本自定义退出码 → 错误消息（≥2，避开 sudo 的 1=取消/密码错误） */
  codeMessages?: Record<number, string>;
}

/**
 * sudo 退出码 → Error 的纯映射（runSudoScript 的可测内核）：
 * - 1 = sudo 鉴权取消/密码错误 → SudoAuthError。**即便 codeMessages 登记了 1 也不让**——
 *   退出码 1 不归脚本，脚本内部失败必须约定 ≥2，否则真实失败会被映射成「已取消」
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
 * spawnSync 超时错误（runSudoScript 识别 `error.code === 'ETIMEDOUT'` 后使用）。
 * 超时与「外部信号终止」的结果形态相同（status=null、signal=SIGTERM），但对用户的
 * 含义不同：是**本工具的时限**杀掉了进程，脚本可能执行到一半，必须点明超时与可能的
 * 半截状态，而不是漏出 `spawnSync sudo ETIMEDOUT` 内部串
 */
export function sudoTimeoutError(action: string): Error {
  return new Error(`${action}超时（${SUDO_TIMEOUT_MS / 1000}s 未完成）：密码输入或脚本执行超过时限，操作可能只完成了一部分，请检查后重试`);
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
  // 写在数据根目录而非 runtime/：runtime 会被 stop/reset 整体 rmrf（锁文件为此全部
  // 迁到了根目录），而脚本写入到 sudo 执行之间隔着密码窗口（最长 SUDO_TIMEOUT_MS），
  // 期间并发的 stop/reset 会连脚本一起删掉——用户输完密码后 sudo 执行一个不存在的
  // 文件，错误被误诊成「密码错误」或「启动失败 127」，指向完全错的排查方向。
  // 根目录属主是用户自己；文件名带 pid——两个终端并发跑同一动作（双 `mh tun`）时，
  // 固定名会让 B 的覆写 + A 的 finally unlink 把 B 的 sudo 指向不存在的路径，密码
  // 正确却报「已取消或密码错误」。`.tmp` 后缀让崩溃残留（写后未及 unlink）落进
  // cleanupStaleTmpFiles 的按龄清扫，不用等下一次同动作覆盖
  const scriptPath = path.join(USER_DATA_DIR, `${opts.file}.${process.pid}.tmp`);
  fs.writeFileSync(scriptPath, scriptBody, { mode: 0o700 });
  // writeFileSync 的 mode 只在**创建新文件**时生效：前次崩溃残留的同名文件会保留
  // 其原有权限位（实测重写 0666 文件后仍是 0666），而本文件下一步就交给 sudo 执行。
  // 显式 chmod 才能保证「只有属主可写」，避免他人预置/篡改脚本内容。
  fs.chmodSync(scriptPath, 0o700);

  try {
    const result = spawnSync('sudo', [scriptPath], { stdio: 'inherit', timeout: SUDO_TIMEOUT_MS });
    // spawnSync 超时同时设置 error=ETIMEDOUT 与 status=null：先判 error 原样抛出会
    // 绕过下面 sudoExitToError 的 null 分支，把内部串漏给用户
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw sudoTimeoutError(opts.action);
      throw result.error;
    }
    if (result.status !== 0) throw sudoExitToError(opts.action, result.status, opts.codeMessages);
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }
}
