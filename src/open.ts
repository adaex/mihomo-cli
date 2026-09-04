import { spawn } from 'node:child_process';

import { setSilentSigint } from './lifecycle.js';

/**
 * 打开 URL 或文件（macOS `open`）。ui/dir/log 三处共用的薄封装，
 * 此前错放在 process.ts（进程管理模块）里。
 */
export function openUrl(url: string): boolean {
  try {
    // `--` 终止选项解析：url 可能来自订阅响应头 web_page_url（服务器可控），以 `-` 开头会被 open 当选项
    const child = spawn('open', ['--', url], { stdio: 'ignore', detached: true });
    child.unref();
    child.on('error', () => {});
    return true;
  } catch {
    return false;
  }
}

export function openLogFile(logPath: string, label?: string): void {
  const displayLabel = label || logPath;
  console.log(`用系统默认程序打开: ${displayLabel}`);
  const success = openUrl(logPath);
  if (!success) {
    console.log(`请手动打开: ${logPath}`);
  }
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

  // follow 模式下 Ctrl+C 是常规退出：抑制全局 SIGINT 处理器的"正在退出..."提示
  if (follow) setSilentSigint(true);

  tail.on('close', () => process.exit(0));
  tail.on('error', e => {
    console.error(`无法读取日志: ${e.message}`);
    process.exit(1);
  });
}
