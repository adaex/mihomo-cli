import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeFixture, runCli, runModule, spawnCli } from './cli.js';

describe('CLI 测试夹具的隔离键不可被 env 覆盖', () => {
  it('runCli 在 spawn 前拒绝覆盖数据目录或服务 label', () => {
    const fixture = makeFixture('mihomo-cli-fixture-guard');
    try {
      assert.throws(() => runCli(['help'], fixture, { env: { MIHOMO_CLI_DIR: '/tmp/other' } }), /不得覆盖 fixture/);
      assert.throws(() => runCli(['help'], fixture, { env: { MIHOMO_CLI_DAEMON_LABEL: 'com.other' } }), /不得覆盖 fixture/);
    } finally {
      fixture.cleanup();
    }
  });

  it('spawnCli 在 spawn 前拒绝覆盖数据目录或服务 label', () => {
    const fixture = makeFixture('mihomo-async-cli-fixture-guard');
    try {
      assert.throws(() => spawnCli(['help'], fixture, { env: { MIHOMO_CLI_DIR: '/tmp/other' } }), /不得覆盖 fixture/);
      assert.throws(() => spawnCli(['help'], fixture, { env: { MIHOMO_CLI_DAEMON_LABEL: 'com.other' } }), /不得覆盖 fixture/);
    } finally {
      fixture.cleanup();
    }
  });

  it('runModule 在 spawn 前拒绝覆盖数据目录', () => {
    const fixture = makeFixture('mihomo-module-fixture-guard');
    try {
      assert.throws(() => runModule('console.log("unreachable")', fixture.dataDir, { env: { MIHOMO_CLI_DIR: '/tmp/other' } }), /不得覆盖 MIHOMO_CLI_DIR/);
    } finally {
      fixture.cleanup();
    }
  });
});
