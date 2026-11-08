import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { makeFixture, runCli } from '../test-support/cli.js';
import { parseEnvDump, writeStubExecutable } from '../test-support/stub-bin.js';

// 自指判定读 settings.json（PATHS 在 import 期固化 MIHOMO_CLI_DIR）：先隔离再动态 import，
// 不读真实数据目录；用例经 setMixedPort 在这里写入自己的 Mixed 端口
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-data-'));
process.env.MIHOMO_CLI_DIR = dataDir;
const { getLatestNpmVersion, isProxyPortListening, resolveUpdateAction } = await import('./update.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/**
 * 桩 npm 的 PATH 污染样板（getLatestNpmVersion 相关用例原各自互抄）：mkdtemp + binDir +
 * 写桩脚本 + PATH 前置，fn 结束后恢复 PATH、删临时目录。
 * 桩脚本内容各用例不同，经 makeBody 传入（探针用例的日志路径要引用临时目录）；
 * makeBody 返回 null 表示不写脚本——「PATH 只指向空目录、spawn npm 必然 ENOENT」的形态，
 * 配合 replacePath 整个替换 PATH 而非前置。
 */
async function withStubNpm<T>(
  makeBody: (tmpDir: string) => string | null,
  fn: (tmpDir: string) => Promise<T>,
  options: { replacePath?: boolean } = {},
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-upd-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  const body = makeBody(tmpDir);
  if (body !== null) writeStubExecutable(path.join(binDir, 'npm'), body);
  const originalPath = process.env.PATH;
  process.env.PATH = options.replacePath ? binDir : `${binDir}:${originalPath}`;
  try {
    return await fn(tmpDir);
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

describe('getLatestNpmVersion：env 里自指代理的 per-spawn 处理（D9）', () => {
  const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];

  /** 起一个只记录不响应的本地 TCP 监听器充当「在跑的本机代理」 */
  function listenLocal(): Promise<{ server: net.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
  }

  /** 自指判定的依据：隔离数据目录 settings.json 里的 Mixed 端口 */
  const setMixedPort = (port: number): void => fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ports: { mixed: port } }));

  /** 以给定代理 env（先清空六键）跑 getLatestNpmVersion，返回桩 npm 实见的 env */
  async function npmSeenEnv(proxyEnv: Record<string, string>): Promise<Record<string, string>> {
    const saved = Object.fromEntries(PROXY_KEYS.map(k => [k, process.env[k]]));
    for (const k of PROXY_KEYS) delete process.env[k];
    Object.assign(process.env, proxyEnv);
    try {
      return await withStubNpm(
        tmpDir => `env >"${path.join(tmpDir, 'env-dump')}"\necho "26.10.98"\n`,
        async tmpDir => {
          assert.equal(await getLatestNpmVersion(5000), '26.10.98');
          return parseEnvDump(fs.readFileSync(path.join(tmpDir, 'env-dump'), 'utf8'));
        },
      );
    } finally {
      for (const k of PROXY_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('自指代理且端口在监听（内核在跑）：npm 收到用户原本的全部代理 env', async () => {
    const { server, port } = await listenLocal();
    try {
      setMixedPort(port);
      const url = `http://127.0.0.1:${port}`;
      const env = await npmSeenEnv({ https_proxy: url, HTTPS_PROXY: url });
      assert.equal(env.https_proxy, url);
      assert.equal(env.HTTPS_PROXY, url);
    } finally {
      server.close();
    }
  });

  it('自指代理但端口不监听（env 残留/内核已停）：npm 收不到自指键，死端口防护', async () => {
    setMixedPort(1); // 端口 1 连接即拒
    const env = await npmSeenEnv({ https_proxy: 'http://127.0.0.1:1', ALL_PROXY: 'socks5://127.0.0.1:1' });
    assert.equal(env.https_proxy, undefined);
    assert.equal(env.ALL_PROXY, undefined);
  });

  it('指向别的端口：原样保留（企业代理、别的代理工具不误伤）', async () => {
    setMixedPort(1);
    const env = await npmSeenEnv({ https_proxy: 'http://127.0.0.1:9999' });
    assert.equal(env.https_proxy, 'http://127.0.0.1:9999');
  });

  it('没配任何 env 代理：npm env 里也没有（不凭空注入）', async () => {
    setMixedPort(1);
    const env = await npmSeenEnv({});
    for (const k of PROXY_KEYS) assert.equal(env[k], undefined, k);
  });
});

describe('update 命令的 npm env 接线（view 与 install 两处 spawn，端到端）', () => {
  /**
   * getLatestNpmVersion 的单元用例碰不到 cmdUpdate 里第二处 spawn（npm install -g）：
   * 子进程跑 update，桩 npm 的 view 报一个更新的版本让流程走到 install，
   * 两处都 dump 收到的 env。回归方向是下载死锁（自指代理没被去掉）。
   */
  function runUpdateWithProxyEnv(proxyEnv: Record<string, string>): { view: Record<string, string>; install: Record<string, string> } {
    const fixture = makeFixture('mihomo-upd-env');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-upd-env-bin-'));
    try {
      fs.writeFileSync(path.join(fixture.dataDir, 'settings.json'), JSON.stringify({ ports: { mixed: 17890 } }));
      writeStubExecutable(
        path.join(binDir, 'npm'),
        [
          'case "$1" in',
          `  view) env > "${binDir}/env-view"; echo "999.0.0" ;;`,
          `  install) env > "${binDir}/env-install" ;;`,
          `  list) echo '{"dependencies":{"mihomo-cli":{"version":"999.0.0"}}}' ;;`,
          'esac',
        ].join('\n'),
      );
      const r = runCli(['update'], fixture, { timeout: 60_000, env: { PATH: `${binDir}:${process.env.PATH}`, ...proxyEnv } });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      const dump = (name: string) => parseEnvDump(fs.readFileSync(path.join(binDir, name), 'utf8'));
      return { view: dump('env-view'), install: dump('env-install') };
    } finally {
      fixture.cleanup();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  }

  it('代理指向自己的 Mixed 端口（17890，无监听）：view 与 install 都收不到该 env', () => {
    const { view, install } = runUpdateWithProxyEnv({ https_proxy: 'http://127.0.0.1:17890', HTTPS_PROXY: 'http://127.0.0.1:17890' });
    for (const env of [view, install]) {
      assert.equal(env.https_proxy, undefined, '自指代理必须被去掉（否则下载死锁）');
      assert.equal(env.HTTPS_PROXY, undefined);
    }
  });

  it('代理指向别的端口（9999）：view 与 install 原样保留', () => {
    const { view, install } = runUpdateWithProxyEnv({ https_proxy: 'http://127.0.0.1:9999' });
    assert.equal(view.https_proxy, 'http://127.0.0.1:9999');
    assert.equal(install.https_proxy, 'http://127.0.0.1:9999');
  });
});
