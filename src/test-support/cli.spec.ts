import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeFixture, runCli, runModule, spawnCli } from './cli.js';

describe('CLI 测试夹具的隔离键不可被 env 覆盖', () => {
  for (const [name, run] of [
    ['runCli', runCli],
    ['spawnCli', spawnCli],
  ] as const) {
    it(`${name} 在 spawn 前拒绝覆盖数据目录或服务 label`, () => {
      const fixture = makeFixture(`mihomo-${name}-fixture-guard`);
      try {
        assert.throws(() => run(['help'], fixture, { env: { MIHOMO_CLI_DIR: '/tmp/other' } }), /不得覆盖 fixture/);
        assert.throws(() => run(['help'], fixture, { env: { MIHOMO_CLI_DAEMON_LABEL: 'com.other' } }), /不得覆盖 fixture/);
      } finally {
        fixture.cleanup();
      }
    });
  }

  it('runModule 在 spawn 前拒绝覆盖数据目录', () => {
    const fixture = makeFixture('mihomo-module-fixture-guard');
    try {
      assert.throws(() => runModule('console.log("unreachable")', fixture.dataDir, { env: { MIHOMO_CLI_DIR: '/tmp/other' } }), /不得覆盖 MIHOMO_CLI_DIR/);
    } finally {
      fixture.cleanup();
    }
  });
});
