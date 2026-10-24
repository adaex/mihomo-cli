import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { withTimeout } from './errors.js';
import { runInheritedChild } from './kernel.js';
import { type CliFixture, makeFixture, spawnCli } from './test-support/cli.js';
import { isDead } from './test-support/fake-kernel.js';
import { pollUntil } from './test-support/poll.js';
import { writeStubExecutable } from './test-support/stub-bin.js';

const CHILD_READY_ENV = 'MIHOMO_TEST_CHILD_READY';
const IDLE_CHILD = `
const fs = require('node:fs');
fs.writeFileSync(process.env.${CHILD_READY_ENV}, String(process.pid));
setInterval(() => {}, 1000);
`;

interface SignalFixture {
  fixture: CliFixture;
  fakeBin: string;
  readyFile: string;
  env: NodeJS.ProcessEnv;
}

function makeSignalFixture(prefix: string): SignalFixture {
  const fixture = makeFixture(prefix);
  const fakeBin = path.join(fixture.dataDir, 'test-bin');
  fs.mkdirSync(fakeBin);
  const readyFile = path.join(fixture.dataDir, 'child-ready');
  return {
    fixture,
    fakeBin,
    readyFile,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, [CHILD_READY_ENV]: readyFile },
  };
}

function readReadyPid(readyFile: string): number {
  assert.ok(
    pollUntil(() => fs.existsSync(readyFile), 5000),
    '受管桩子进程未在 5s 内就绪',
  );
  const pid = Number(fs.readFileSync(readyFile, 'utf8'));
  assert.ok(Number.isInteger(pid) && pid > 0, `无效的桩 PID: ${pid}`);
  return pid;
}

function assertProcessDead(pid: number): void {
  assert.ok(
    pollUntil(() => isDead(pid), 3000),
    `PID ${pid} 仍是活进程`,
  );
}

function forceKill(pid: number | undefined): void {
  if (pid === undefined || isDead(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 已退出：无需再清理
  }
  assertProcessDead(pid);
}

async function runLogsSignalCase(signal: 'SIGINT' | 'SIGTERM', expectedStatus: number, signalTarget: 'cli' | 'tail' = 'cli'): Promise<void> {
  const { fixture, fakeBin, readyFile, env } = makeSignalFixture(`mihomo-logs-${signalTarget}-${signal.toLowerCase()}`);
  writeStubExecutable(path.join(fakeBin, 'tail'), IDLE_CHILD, process.execPath);
  fs.mkdirSync(path.join(fixture.dataDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(fixture.dataDir, 'logs', 'mihomo.log'), 'line\n');
  const { child, done } = spawnCli(['logs', '-f'], fixture, { env });
  let tailPid: number | undefined;
  try {
    tailPid = readReadyPid(readyFile);
    if (signalTarget === 'cli') {
      // 只发给 CLI PID，不发给整个进程组；tail 只能由 CLI 的受管子进程清理退出
      assert.equal(child.kill(signal), true);
    } else {
      process.kill(tailPid, signal);
    }
    const result = await withTimeout(done, 3000);
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(result.signal, null);
    if (signalTarget === 'cli') {
      assert.doesNotMatch(result.stdout, /正在退出/);
      assert.doesNotMatch(result.stderr, /正在退出/);
    }
    assertProcessDead(tailPid);
  } finally {
    forceKill(tailPid);
    forceKill(child.pid);
    fixture.cleanup();
  }
}

describe('logs -f 的受管 tail 信号语义', () => {
  it('只 SIGTERM CLI PID：CLI 退 143，tail 也被终止', async () => {
    await runLogsSignalCase('SIGTERM', 143);
  });

  it('只 SIGINT CLI PID：保持 Ctrl+C 的 130 与静默提示，tail 不成为孤儿', async () => {
    await runLogsSignalCase('SIGINT', 130);
  });

  it('tail 自身被 SIGTERM 杀死：close(code=null, signal) 折算为 143', async () => {
    await runLogsSignalCase('SIGTERM', 143, 'tail');
  });
});

describe('kernel 下载的异步子进程信号语义', () => {
  it('慢 curl 下载中只 SIGTERM CLI PID：及时退 143 且 curl 被终止', async () => {
    const { fixture, fakeBin, readyFile, env } = makeSignalFixture('mihomo-kernel-signal');
    writeStubExecutable(path.join(fakeBin, 'launchctl'), 'exit 113');
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    const assetName = `mihomo-${process.platform}-${arch}-v1.19.30.gz`;
    const releases = JSON.stringify([
      {
        tag_name: 'v1.19.30',
        prerelease: false,
        assets: [
          {
            name: assetName,
            browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/${assetName}`,
            size: 3,
          },
        ],
      },
    ]);
    writeStubExecutable(
      path.join(fakeBin, 'curl'),
      `
const fs = require('node:fs');
if (process.argv.includes('https://api.github.com/repos/MetaCubeX/mihomo/releases')) {
  process.stdout.write(${JSON.stringify(`${releases}\n200`)});
} else {
  fs.writeFileSync(process.env.${CHILD_READY_ENV}, String(process.pid));
  setInterval(() => {}, 1000);
}
`,
      process.execPath,
    );

    const { child, done } = spawnCli(['kernel', '--mirror', 'direct'], fixture, { env });
    let curlPid: number | undefined;
    try {
      // ready 只在 release 查询完成之后、产物下载 curl 内写入，不访问真实网络
      curlPid = readReadyPid(readyFile);
      const started = Date.now();
      assert.equal(child.kill('SIGTERM'), true);
      const result = await withTimeout(done, 3000);
      assert.ok(Date.now() - started < 3000, 'SIGTERM 必须及时打断下载');
      assert.equal(result.status, 143, result.stderr);
      assert.equal(result.signal, null);
      assert.match(result.stdout, /下载内核/);
      assertProcessDead(curlPid);
    } finally {
      forceKill(curlPid);
      forceKill(child.pid);
      fixture.cleanup();
    }
  });
});

describe('kernel 下载子进程的硬超时', () => {
  it('子进程忽略 SIGTERM 时在宽限后 SIGKILL，下载不会无限等待', async () => {
    const fixture = makeFixture('mihomo-kernel-hard-timeout');
    const readyFile = path.join(fixture.dataDir, 'child-ready');
    let childPid: number | undefined;
    try {
      const script = `
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
setInterval(() => {}, 1000);
`;
      const resultPromise = runInheritedChild(process.execPath, ['-e', script], { timeout: 50 });
      childPid = readReadyPid(readyFile);
      const result = await withTimeout(resultPromise, 4000);
      assert.equal(result.error?.code, 'ETIMEDOUT');
      assertProcessDead(childPid);
    } finally {
      forceKill(childPid);
      fixture.cleanup();
    }
  });
});
