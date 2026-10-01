import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { MAIN_INSTANCE_PATTERN } from './process-probe.js';

/**
 * MAIN_INSTANCE_PATTERN 的语法回归。
 *
 * 这里锁的是一个「静默失效」缺陷：pattern 曾用 JS 的非捕获组 `(?:a|b)`，而 pgrep/pkill 走
 * POSIX ERE（`regcomp(REG_EXTENDED)`），ERE 里 `(` 后紧跟 `?` 是语法错误。后果不是报错而是
 * **全线静默失效**——pgrep 退出码 2、无输出，getMihomoPids 返回空；pkill 一个进程都不杀却
 * 照常返回。于是 `mihomo-cli stop` 打印「已停止」，内核仍在跑。
 *
 * 断言直接调真实 pgrep 编译该 pattern，不做字符串匹配：字符串断言（如「不含 `(?:`」）
 * 只能挡住已知的这一种写法，而任何 JS-only 的正则语法（`\d`、`(?=)`、`{,n}`）都会以同样的
 * 方式失效。让 libc 的 regcomp 当裁判才是真的把关。
 */
describe('MAIN_INSTANCE_PATTERN', () => {
  it('能被 pgrep 的 POSIX ERE 编译（退出码只允许 0/1，2 = 正则编译失败）', () => {
    const result = spawnSync('pgrep', ['-f', MAIN_INSTANCE_PATTERN], { encoding: 'utf8', timeout: 10_000 });

    assert.notEqual(result.status, 2, `pgrep 无法编译该 pattern，进程探测会全线静默失效:\n${result.stderr}`);
    assert.ok(result.status === 0 || result.status === 1, `pgrep 异常退出 (${result.status}): ${result.stderr}`);
  });

  it('两种内核路径分支都在（服务经符号链启动，tun 经真实二进制）', () => {
    assert.match(MAIN_INSTANCE_PATTERN, /mihomo-cli-service/);
    assert.match(MAIN_INSTANCE_PATTERN, /\|/);
  });
});

describe('isMihomoProcess（kill 前复核的判据）', () => {
  // 子进程隔离：PATHS 在模块加载时固定，隔离 MIHOMO_CLI_DIR 后探测/pattern 都落在临时目录
  it('内核命令行启动的进程判 true，无关进程（如 node 自身）判 false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-isprobe-'));
    try {
      const probeUrl = pathToFileURL(path.resolve('src/process-probe.ts')).href;
      const pathsUrl = pathToFileURL(path.resolve('src/paths.ts')).href;
      // 假内核：可执行 sleep 脚本，spawn 后命令行含 kernel/mihomo 与 -f <configFile>
      const fakeKernel = path.join(dir, 'kernel', 'mihomo');
      fs.mkdirSync(path.dirname(fakeKernel), { recursive: true });
      fs.writeFileSync(fakeKernel, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
      const fakeConfig = path.join(dir, 'runtime', 'config.yaml');
      fs.mkdirSync(path.dirname(fakeConfig), { recursive: true });
      fs.writeFileSync(fakeConfig, 'x: 1');

      const child = spawn(fakeKernel, ['-d', path.join(dir, 'data'), '-f', fakeConfig], { stdio: 'ignore' });
      try {
        const code = `
          const m = await import(${JSON.stringify(probeUrl)});
          const { PATHS } = await import(${JSON.stringify(pathsUrl)});
          process.stdout.write('SELF:' + m.isMihomoProcess(process.pid) + '\\n');
          process.stdout.write('KERNEL:' + m.isMihomoProcess(${JSON.stringify(String(child.pid))}) + '\\n');
          process.stdout.write('GONE:' + m.isMihomoProcess(999999) + '\\n');
        `;
        const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', code], {
          encoding: 'utf8',
          env: { ...process.env, MIHOMO_CLI_DIR: dir },
        });
        assert.equal(r.status, 0, r.stderr || r.stdout);
        assert.match(r.stdout, /SELF:false/, 'node 自身命令行不含内核路径，应判 false');
        assert.match(r.stdout, /KERNEL:true/, `假内核进程应判 true: ${r.stdout}`);
        assert.match(r.stdout, /GONE:false/, '不存在的 pid 判 false');
      } finally {
        child.kill('SIGKILL');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
