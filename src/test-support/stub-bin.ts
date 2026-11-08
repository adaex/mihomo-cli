import fs from 'node:fs';

/**
 * PATH 桩可执行文件原语：写桩脚本并赋 0755，返回该路径。默认使用 `#!/bin/bash`，
 * Node 桩传 `process.execPath`，不经过 shell，也不产生额外孙进程。
 * 子进程经 PATH 前置找到它——shebang 与权限在此单点，桩的执行形态不随各 spec 自演化。
 * 只 owns「写 + chmod」：桩怎么进 PATH（spawn env 前置 / 进程内改写后恢复 / 场景
 * env 函数拼装）生命周期形态各异，归调用方。
 *
 * 文件名不带 .spec 后缀：测试只收 *.spec.ts 结尾的文件，本支撑模块不会被当套件执行。
 */
export function writeStubExecutable(file: string, body: string, interpreter = '/bin/bash'): string {
  fs.writeFileSync(file, `#!${interpreter}\n${body}\n`, { mode: 0o755 });
  return file;
}

/** 解析桩脚本 `env > file` 落盘的内容为键值表：桩实见的 env 断言（代理键是否透传/被去掉）共用 */
export function parseEnvDump(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}
