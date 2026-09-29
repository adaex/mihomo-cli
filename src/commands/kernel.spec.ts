import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');

function runCli(args: string[]): SpawnSyncReturns<string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-kernel-cli-'));
  try {
    return spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        MIHOMO_CLI_DIR: dataDir,
        MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
        NO_COLOR: '1',
      },
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('kernel 命令：版本查询失败的提示分档', () => {
  it('镜像 + 代理组合查询失败：提示检查代理并说明镜像不碰 API', () => {
    // 回归：显式 --mirror 用户的版本查询失败曾被整体压制（提示补给的 else if 以
    // !mirrorInfo.mirror 为条件，镜像用户两个提示块都进不去），只剩裸「更新失败」。
    // 镜像只作用于内核下载，版本查询按设计直连 GitHub API——失败与镜像无关，
    // 出路是检查代理本身。127.0.0.1:1 连接即拒，不依赖外网
    const r = runCli(['kernel', '--mirror', 'cdn', '--proxy', '127.0.0.1:1']);

    assert.notEqual(r.status, 0, '查询失败应非 0 退出');
    assert.match(r.stderr, /版本查询（GitHub API）经代理失败/, `应给出可执行指引而非裸报错，stderr: ${r.stderr}`);
    assert.match(r.stderr, /镜像只作用于内核下载，与查询无关/);
  });
});
