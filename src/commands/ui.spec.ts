import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CliError } from '../errors.js';
import { resolveUiName } from './ui.js';

describe('resolveUiName', () => {
  it('未传参取默认 zash', () => {
    assert.equal(resolveUiName(['ui']), 'zash');
  });

  it('小写归一：DASH/YACD 与小写等价', () => {
    assert.equal(resolveUiName(['ui', 'DASH']), 'dash');
    assert.equal(resolveUiName(['ui', 'Yacd']), 'yacd');
  });

  it('空串报未知 UI，不静默落到默认值', () => {
    assert.throws(
      () => resolveUiName(['ui', '']),
      e => e instanceof CliError && /未知的 UI/.test(e.message),
    );
  });

  it('未知名称报错', () => {
    assert.throws(
      () => resolveUiName(['ui', 'nope']),
      e => e instanceof CliError && /未知的 UI "nope"/.test(e.message),
    );
  });

  it('-c 标志不被当成 UI 名（带与不带名称都取对）', () => {
    assert.equal(resolveUiName(['ui', '-c']), 'zash');
    assert.equal(resolveUiName(['ui', '-c', 'dash']), 'dash');
  });
});

/**
 * CLI 级：控制器地址必须固定可见（自定义端口后托管 UI 默认连 9090 必然失败），
 * 且 secret 默认不得动剪贴板（通用剪贴板会同步到同 Apple ID 设备）。
 * PATH 前置桩目录：open/pbcopy 替换为空操作并记录调用，测试绝不弹浏览器、不碰真实剪贴板。
 */
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');

function runCli(args: string[], settings: Record<string, unknown>): SpawnSyncReturns<string> & { binDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ui-cli-'));
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ui-bin-'));
  fs.writeFileSync(path.join(binDir, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'pbcopy'), '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
  try {
    const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        MIHOMO_CLI_DIR: dataDir,
        MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
        NO_COLOR: '1',
      },
    });
    return Object.assign(r, { binDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('ui CLI：控制器地址与 secret 剪贴板策略', () => {
  it('固定打印控制器实际地址', () => {
    const r = runCli(['ui'], { ports: { controller: 19090 } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /控制器: http:\/\/127\.0\.0\.1:19090/);
    fs.rmSync(r.binDir, { recursive: true, force: true });
  });

  it('配了 secret 但不带 -c：只提示、不碰剪贴板', () => {
    const r = runCli(['ui'], { controller_secret: 'topsecret' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /已配置访问密钥/);
    assert.match(r.stdout, /mihomo ui -c/);
    assert.ok(!r.stdout.includes('已复制到剪贴板'), '默认不应出现复制成功文案');
    fs.rmSync(r.binDir, { recursive: true, force: true });
  });

  it('显式 -c 才复制（pbcopy 被调用）', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ui-cli-'));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ui-bin-'));
    const called = path.join(binDir, 'pbcopy.called');
    fs.writeFileSync(path.join(binDir, 'open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'pbcopy'), `#!/bin/sh\ncat >/dev/null\ntouch '${called}'\nexit 0\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ controller_secret: 'topsecret' }));
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'ui', '-c'], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          MIHOMO_CLI_DIR: dataDir,
          MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
          NO_COLOR: '1',
        },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /访问密钥已复制到剪贴板/);
      assert.ok(fs.existsSync(called), '未带 -c 时不应调用；带 -c 必须调用 pbcopy');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
