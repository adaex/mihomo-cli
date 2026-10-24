import { type ChildProcess, spawn } from 'node:child_process';

/** 同步与异步测试子进程共用的默认超时；真网络等慢场景由调用方显式调整 */
export const DEFAULT_TEST_PROCESS_TIMEOUT_MS = 20_000;

/**
 * 异步 spawn 一个 tsx 子进程跑 `-e` 内嵌脚本（runModule 的异步版）。
 *
 * 并发用例**必须 spawn 而非 spawnSync**：后者逐个跑完，根本不产生并发，测不出
 * 跨进程竞争；且 spawnSync 会阻塞父进程事件循环，桩 server 类用例里父子会死锁。
 *
 * env 口径与 runModule 一致：继承 process.env 再叠加覆盖项（调用方给
 * MIHOMO_CLI_DIR 等隔离键）。done 在 close 时给退出码、spawn 失败（error 事件）
 * 给 -1。默认 20s 超时终止子进程，避免 barrier 或锁回归留下永久等待；调用方可调整。
 * 调用方仍应在 finally 清理自建子进程，超时是兜底而不是常规收尾。
 *
 * 文件名不带 .spec 后缀：测试只收 *.spec.ts 结尾的文件，本支撑模块不会被当套件执行。
 */
export function spawnEval(
  script: string,
  opts: { env?: NodeJS.ProcessEnv; stdio?: 'ignore' | 'inherit'; timeout?: number } = {},
): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    stdio: opts.stdio ?? 'ignore',
    env: { ...process.env, ...opts.env },
    timeout: opts.timeout ?? DEFAULT_TEST_PROCESS_TIMEOUT_MS,
  });
  const done = new Promise<number | null>(resolve => {
    child.on('close', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
  return { child, done };
}
