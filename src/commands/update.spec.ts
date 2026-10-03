import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { recordClearedProxyEnv } from '../system-proxy.js';
import { makeFixture, runCli } from '../test-support/cli.js';
import { getLatestNpmVersion, isProxyPortListening, resolveUpdateAction, restoreProxyEnvForNpm } from './update.js';

after(() => {
  recordClearedProxyEnv(null);
});

/**
 * 桩 npm 的 PATH 污染样板（getLatestNpmVersion 相关用例原各自互抄）：mkdtemp + binDir +
 * 写桩脚本 + chmod + PATH 前置，fn 结束后恢复 PATH、删临时目录。
 * 桩脚本内容各用例不同，经 makeBody 传入（探针用例的日志路径要引用临时目录）；
 * makeBody 返回 null 表示不写脚本——「PATH 只指向空目录、spawn npm 必然 ENOENT」的形态，
 * 配合 replacePath 整个替换 PATH 而非前置。
 */
async function withStubNpm<T>(
  makeBody: (binDir: string, tmpDir: string) => string | null,
  fn: (binDir: string, tmpDir: string) => Promise<T>,
  options: { replacePath?: boolean } = {},
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  const body = makeBody(binDir, tmpDir);
  if (body !== null) {
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/bash\n${body}`);
    fs.chmodSync(path.join(binDir, 'npm'), 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = options.replacePath ? binDir : `${binDir}:${originalPath}`;
  try {
    return await fn(binDir, tmpDir);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

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
  it('npm view 输出版本号：取最后一行 trim 后的值', async () => {
    // npm view 输出可能带多余行（如 notice），协议是取最后一行
    await withStubNpm(
      () => 'echo "npm notice ignore me" >&2\necho "26.10.98"\n',
      async () => {
        assert.equal(await getLatestNpmVersion(5000), '26.10.98');
      },
    );
  });

  it('npm view 失败（exit 1）：返回 null，调用方降级为直接安装', async () => {
    await withStubNpm(
      () => 'echo "npm ERR registry down" >&2\nexit 1\n',
      async () => {
        assert.equal(await getLatestNpmVersion(5000), null);
      },
    );
  });

  it('npm 缺失（ENOENT）：catch 归一返回 null，不抛出', async () => {
    // PATH 只指向空目录（不写桩脚本、整个替换 PATH）：spawn npm 必然 ENOENT
    await withStubNpm(
      () => null,
      async () => {
        assert.equal(await getLatestNpmVersion(5000), null);
      },
      { replacePath: true },
    );
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
  /** 起一个只记录不响应的本地 TCP 监听器充当「在跑的本机代理」 */
  function listenLocal(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
  }

  /** 探针桩脚本：把实际收到的 https_proxy 写进日志，再按协议吐版本号 */
  const probeScript = (probeLog: string) => `echo "\${https_proxy:-NONE}" >"${probeLog}"\necho "26.10.98"\n`;

  it('代理端口在监听：npm 子进程收到用户原本的 https_proxy', async () => {
    const { server, port } = await listenLocal();
    try {
      await withStubNpm(
        (_binDir, tmpDir) => probeScript(path.join(tmpDir, 'probe.log')),
        async (_binDir, tmpDir) => {
          recordClearedProxyEnv({ https_proxy: `http://127.0.0.1:${port}` });
          try {
            assert.equal(await getLatestNpmVersion(5000), '26.10.98');
            assert.equal(fs.readFileSync(path.join(tmpDir, 'probe.log'), 'utf8').trim(), `http://127.0.0.1:${port}`);
          } finally {
            recordClearedProxyEnv(null);
          }
        },
      );
    } finally {
      server.close();
    }
  });

  it('代理端口不监听（env 残留/内核已停）：不注回，npm 收不到代理 env', async () => {
    await withStubNpm(
      (_binDir, tmpDir) => probeScript(path.join(tmpDir, 'probe.log')),
      async (_binDir, tmpDir) => {
        // 端口 1 连接即拒；同时确保当前 process.env 里没有逃逸的同名键
        const saved = process.env.https_proxy;
        delete process.env.https_proxy;
        recordClearedProxyEnv({ https_proxy: 'http://127.0.0.1:1' });
        try {
          assert.equal(await getLatestNpmVersion(5000), '26.10.98');
          assert.equal(fs.readFileSync(path.join(tmpDir, 'probe.log'), 'utf8').trim(), 'NONE');
        } finally {
          recordClearedProxyEnv(null);
          if (saved !== undefined) process.env.https_proxy = saved;
        }
      },
    );
  });

  it('入口没清过任何自指 env：npm env 与进程环境一致（不凭空注入）', async () => {
    await withStubNpm(
      (_binDir, tmpDir) => probeScript(path.join(tmpDir, 'probe.log')),
      async (_binDir, tmpDir) => {
        const saved = process.env.https_proxy;
        delete process.env.https_proxy;
        recordClearedProxyEnv(null);
        try {
          assert.equal(await getLatestNpmVersion(5000), '26.10.98');
          assert.equal(fs.readFileSync(path.join(tmpDir, 'probe.log'), 'utf8').trim(), 'NONE');
        } finally {
          if (saved !== undefined) process.env.https_proxy = saved;
        }
      },
    );
  });
});

describe('入口自指代理清除的接线（D9 契约的最后一环，端到端）', () => {
  /**
   * 纯决策件（proxyEnvPointsAtSelf/restoreProxyEnvForNpm）已各自有测；此前盲区是
   * 接线本身——main() 入口的 clearProxyEnv 六键循环 + readSelfMixedPortEarly 守卫前
   * 读原始 JSON。回归方向是下载死锁（自指代理没被清掉）。端到端：子进程跑 update
   * （npm view 输出 0.0.1 → 领先跳过 install），桩 npm dump 收到的 env 断言。
   */
  function runUpdateWithProxyEnv(settingsJson: string | null, proxyEnv: Record<string, string>): Record<string, string> | null {
    const fixture = makeFixture('mihomo-clearproxy');
    const { dataDir } = fixture;
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-clearproxy-bin-'));
    const dumpFile = path.join(binDir, 'env-dump');
    try {
      if (settingsJson !== null) fs.writeFileSync(path.join(dataDir, 'settings.json'), settingsJson);
      fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/bash\nif [ "$1" = "view" ]; then\n  env > "${dumpFile}"\n  echo "0.0.1"\n  exit 0\nfi\nexit 0\n`);
      fs.chmodSync(path.join(binDir, 'npm'), 0o755);
      const r = runCli(['update'], fixture, {
        timeout: 60_000,
        env: { PATH: `${binDir}:${process.env.PATH}`, ...proxyEnv },
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /领先/, '桩 view 输出 0.0.1 应走「领先跳过」');
      if (!fs.existsSync(dumpFile)) return null;
      const env: Record<string, string> = {};
      for (const line of fs.readFileSync(dumpFile, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return env;
    } finally {
      fixture.cleanup();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }

  it('https_proxy 指向自己的 Mixed 端口（17890）：入口清除，npm 收不到该 env', () => {
    const env = runUpdateWithProxyEnv(JSON.stringify({ ports: { mixed: 17890 } }), {
      https_proxy: 'http://127.0.0.1:17890',
      HTTPS_PROXY: 'http://127.0.0.1:17890',
    });
    assert.ok(env, '桩 npm 应被调用');
    assert.equal(env.https_proxy, undefined, '自指代理必须被入口清除（否则下载死锁）');
    assert.equal(env.HTTPS_PROXY, undefined);
  });

  it('https_proxy 指向别的端口（9999）：原样保留（企业代理不误伤）', () => {
    const env = runUpdateWithProxyEnv(JSON.stringify({ ports: { mixed: 17890 } }), {
      https_proxy: 'http://127.0.0.1:9999',
    });
    assert.ok(env);
    assert.equal(env.https_proxy, 'http://127.0.0.1:9999');
  });

  it('settings 损坏：按默认端口 7890 判定，自指（7890）仍被清除且守卫前不抛错', () => {
    const env = runUpdateWithProxyEnv('{broken json', { https_proxy: 'http://127.0.0.1:7890' });
    assert.ok(env, '损坏的 settings 不该让 update 崩掉');
    assert.equal(env.https_proxy, undefined);
  });
});
