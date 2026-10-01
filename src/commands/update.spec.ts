import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { recordClearedProxyEnv } from '../system-proxy.js';
import { getLatestNpmVersion, isProxyPortListening, resolveUpdateAction, restoreProxyEnvForNpm } from './update.js';

after(() => {
  recordClearedProxyEnv(null);
});

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

describe('restoreProxyEnvForNpm（npm 子进程代理恢复的纯决策）', () => {
  const cleared = { https_proxy: 'http://127.0.0.1:7890' };

  it('有清除记录且端口活着：原样恢复（键与值都不改写）', () => {
    assert.deepEqual(restoreProxyEnvForNpm(cleared, true), cleared);
  });

  it('没清过（null）：空对象，不替用户发明代理配置', () => {
    assert.deepEqual(restoreProxyEnvForNpm(null, true), {});
  });

  it('清过但端口不活（env 残留/内核已停）：空对象，D9 死端口防护照旧', () => {
    assert.deepEqual(restoreProxyEnvForNpm(cleared, false), {});
  });
});

describe('isProxyPortListening（本机代理端口 TCP 探活）', () => {
  it('本地在监听的端口：true；拒绝端口：false（不依赖外网）', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    try {
      assert.equal(await isProxyPortListening('127.0.0.1', port), true);
      assert.equal(await isProxyPortListening('127.0.0.1', 1), false, '端口 1 连接即拒');
    } finally {
      server.close();
    }
  });

  it('0.0.0.0 / :: 形态归一到确定回环地址再探', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    try {
      assert.equal(await isProxyPortListening('0.0.0.0', port), true);
    } finally {
      server.close();
    }
  });
});

describe('getLatestNpmVersion：入口清掉的自指代理 env 按端口存活 per-spawn 注回', () => {
  function writeStubNpm(binDir: string, body: string): void {
    const script = `#!/bin/bash\n${body}`;
    fs.writeFileSync(path.join(binDir, 'npm'), script);
    fs.chmodSync(path.join(binDir, 'npm'), 0o755);
  }

  /** 起一个只记录不响应的本地 TCP 监听器充当「在跑的本机代理」 */
  function listenLocal(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
  }

  it('代理端口在监听：npm 子进程收到用户原本的 https_proxy', async () => {
    const { server, port } = await listenLocal();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const probeLog = path.join(tmpDir, 'probe.log');
    // 桩 npm 把实际收到的 https_proxy 写日志，再按协议吐版本号
    writeStubNpm(binDir, `echo "\${https_proxy:-NONE}" >"${probeLog}"\necho "26.10.98"\n`);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    recordClearedProxyEnv({ https_proxy: `http://127.0.0.1:${port}` });
    try {
      assert.equal(await getLatestNpmVersion(5000), '26.10.98');
      assert.equal(fs.readFileSync(probeLog, 'utf8').trim(), `http://127.0.0.1:${port}`);
    } finally {
      recordClearedProxyEnv(null);
      process.env.PATH = originalPath;
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('代理端口不监听（env 残留/内核已停）：不注回，npm 收不到代理 env', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const probeLog = path.join(tmpDir, 'probe.log');
    writeStubNpm(binDir, `echo "\${https_proxy:-NONE}" >"${probeLog}"\necho "26.10.98"\n`);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    // 端口 1 连接即拒；同时确保当前 process.env 里没有逃逸的同名键
    const saved = process.env.https_proxy;
    delete process.env.https_proxy;
    recordClearedProxyEnv({ https_proxy: 'http://127.0.0.1:1' });
    try {
      assert.equal(await getLatestNpmVersion(5000), '26.10.98');
      assert.equal(fs.readFileSync(probeLog, 'utf8').trim(), 'NONE');
    } finally {
      recordClearedProxyEnv(null);
      if (saved !== undefined) process.env.https_proxy = saved;
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('入口没清过任何自指 env：npm env 与进程环境一致（不凭空注入）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir);
    const probeLog = path.join(tmpDir, 'probe.log');
    writeStubNpm(binDir, `echo "\${https_proxy:-NONE}" >"${probeLog}"\necho "26.10.98"\n`);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    const saved = process.env.https_proxy;
    delete process.env.https_proxy;
    recordClearedProxyEnv(null);
    try {
      assert.equal(await getLatestNpmVersion(5000), '26.10.98');
      assert.equal(fs.readFileSync(probeLog, 'utf8').trim(), 'NONE');
    } finally {
      if (saved !== undefined) process.env.https_proxy = saved;
      process.env.PATH = originalPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
