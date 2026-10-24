import { spawn } from 'node:child_process';
import os from 'node:os';

import { setSilentSigint, trackChildProcess } from './lifecycle.js';

/**
 * 打开 URL 或文件（macOS `open`）。ui/dir/log 三处共用的薄封装。
 *
 * **无返回值、不检出失败**：`open` 是 detached spawn，失败（ENOENT、目标不存在、
 * 用户无默认程序）全部发生在本函数返回之后，只能被 `child.on('error')` 收到。
 * 真要检出失败得改用 `spawnSync` 并解析退出码，但那会为一个「非阻塞的顺手操作」
 * 引入同步等待；macOS 上 `open` 本就存在（平台守卫已保证），故选择不检出。
 * 调用方一律**无条件打印地址/路径**，用户即便没弹出窗口也能自己点开。
 */
export function openUrl(url: string): void {
  try {
    // `--` 终止选项解析：url 可能来自订阅响应头 web_page_url（服务器可控），以 `-` 开头会被 open 当选项
    // detached 进程的生命周期独立于 CLI，不纳入受管子进程跟踪
    const child = spawn('open', ['--', url], { stdio: 'ignore', detached: true });
    child.unref();
    child.on('error', () => {});
  } catch {
    /* spawn 同步阶段的异常（参数非法等）：地址已由调用方打印，用户可自行打开 */
  }
}

/** close 的 code 与 signal 互斥；两者都未知时按失败处理，不能把未知结果当成功。 */
function tailExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) {
    const signalNumber = os.constants.signals[signal];
    if (typeof signalNumber === 'number') return 128 + signalNumber;
  }
  return 1;
}

export function viewLogWithTail(logPath: string, options?: { follow?: boolean; lines?: number }): void {
  const follow = options?.follow;
  const lines = options?.lines || 100;

  console.log(`日志: ${logPath}`);
  if (follow) {
    console.log('按 Ctrl+C 退出\n');
  } else {
    console.log(`显示最后 ${lines} 行\n`);
  }

  const tailArgs: string[] = [];
  if (follow) tailArgs.push('-f');
  tailArgs.push('-n', lines.toString());
  tailArgs.push(logPath);

  const tail = spawn('tail', tailArgs, { stdio: 'inherit' });
  const untrackTail = trackChildProcess(tail);

  // follow 模式下 Ctrl+C 是常规退出：抑制全局 SIGINT 处理器的"正在退出..."提示
  if (follow) setSilentSigint(true);

  // 透传 tail 的退出码：日志文件不存在时 tail 退 1 并往 stderr 报错，
  // 若恒退 0，脚本里 `mihomo-cli logs 0 > out` 会把「文件不存在的空结果」当成功。
  // 信号退出按 128 + signal number 折算；Ctrl+C 由 index.ts 先终止受管 tail，
  // 再同步退出 130，保持 Unix 信号退出惯例。
  tail.on('close', (code, signal) => {
    untrackTail();
    process.exit(tailExitCode(code, signal));
  });
  tail.on('error', e => {
    untrackTail();
    console.error(`无法读取日志: ${e.message}`);
    process.exit(1);
  });
}
