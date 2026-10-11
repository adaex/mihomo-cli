import { type ChildProcess, spawn } from 'node:child_process';

/**
 * 异步 spawn 一个 tsx 子进程跑 `-e` 内嵌脚本（runModule 的异步版）。
 *
 * 并发用例**必须 spawn 而非 spawnSync**：后者逐个跑完，根本不产生并发，测不出
 * 跨进程竞争；且 spawnSync 会阻塞父进程事件循环，桩 server 类用例里父子会死锁。
 *
 * env 口径与 runModule 一致：继承 process.env 再叠加覆盖项（调用方给
 * MIHOMO_CLI_DIR 等隔离键）。done 在 close 时给退出码、spawn 失败（error 事件）
 * 给 -1——两者都 resolve，调用方不用防 promise 悬挂。
 *
 * 文件名不带 .spec 后缀：测试只收 *.spec.ts 结尾的文件，本支撑模块不会被当套件执行。
 */
export function spawnEval(
  script: string,
  opts: { env?: NodeJS.ProcessEnv; stdio?: 'ignore' | 'inherit' } = {},
): { child: ChildProcess; done: Promise<number | null> } {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    stdio: opts.stdio ?? 'ignore',
    env: { ...process.env, ...opts.env },
  });
  const done = new Promise<number | null>(resolve => {
    child.on('close', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
  return { child, done };
}
