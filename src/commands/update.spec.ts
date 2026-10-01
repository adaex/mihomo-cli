import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { getLatestNpmVersion, resolveUpdateAction } from './update.js';

describe('resolveUpdateAction：update 的版本决策', () => {
  it('当前领先 registry（预发/源码安装）：ahead，必须拦住（npm install 会静默降级）', () => {
    assert.equal(resolveUpdateAction('26.10.99', '26.10.97'), 'ahead');
  });

  it('已是最新：current，跳过', () => {
    assert.equal(resolveUpdateAction('26.10.97', '26.10.97'), 'current');
  });

  it('registry 更新：proceed，继续安装', () => {
    assert.equal(resolveUpdateAction('26.10.97', '26.10.98'), 'proceed');
  });

  it('查询失败（null）：降级 proceed，直接尝试重装', () => {
    assert.equal(resolveUpdateAction('26.10.97', null), 'proceed');
  });

  it('非 semver 无法比较：按 proceed 继续更新', () => {
    assert.equal(resolveUpdateAction('v0-dev', '26.10.97'), 'proceed');
  });
});

describe('getLatestNpmVersion：npm view 查询与失败降级', () => {
  function writeStubNpm(binDir: string, body: string): void {
    const script = `#!/bin/bash\n${body}`;
    fs.writeFileSync(path.join(binDir, 'npm'), script);
    fs.chmodSync(path.join(binDir, 'npm'), 0o755);
  }

  it('npm view 输出版本号：取最后一行 trim 后的值', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    // npm view 输出可能带多余行（如 notice），协议是取最后一行
    writeStubNpm(binDir, 'echo "npm notice ignore me" >&2\necho "26.10.98"\n');
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      assert.equal(await getLatestNpmVersion(5000), '26.10.98');
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('npm view 失败（exit 1）：返回 null，调用方降级为直接安装', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    writeStubNpm(binDir, 'echo "npm ERR registry down" >&2\nexit 1\n');
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    try {
      assert.equal(await getLatestNpmVersion(5000), null);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('npm 缺失（ENOENT）：catch 归一返回 null，不抛出', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    // PATH 只指向空目录：spawn npm 必然 ENOENT
    const originalPath = process.env.PATH;
    process.env.PATH = binDir;
    try {
      assert.equal(await getLatestNpmVersion(5000), null);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
