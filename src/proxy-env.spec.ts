import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// stripSelfProxyEnv 缺省端口读 settings.json（PATHS 在 import 期固化 MIHOMO_CLI_DIR）：
// 先隔离再动态 import，不碰真实数据目录
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cli-proxyenv-'));
process.env.MIHOMO_CLI_DIR = dataDir;
const { parseProxyEndpoint, proxyEnvPointsAtSelf, stripSelfProxyEnv } = await import('./proxy-env.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('proxyEnvPointsAtSelf：只认指向本机 Mixed 端口的代理 env', () => {
  it('本机回环 + 自己的端口才判定为自代理', () => {
    for (const url of ['http://127.0.0.1:7890', 'http://localhost:7890', 'socks5://127.0.0.1:7890', '127.0.0.1:7890']) {
      assert.equal(proxyEnvPointsAtSelf(url, 7890), true, url);
    }
  });

  it('裸 localhost:端口也判自代理（curl/gh 认这个形态，漏掉即死锁清除失效）', () => {
    // `new URL('localhost:7890')` 不抛异常而 hostname 为空串（localhost 被当 scheme），
    // 不补协议重解析就会漏判——export https_proxy=localhost:7890 的用户在 start/kernel
    // 重启内核后照样经死代理出网，正是本函数唯一要防的死锁形态
    assert.equal(proxyEnvPointsAtSelf('localhost:7890', 7890), true);
    assert.equal(proxyEnvPointsAtSelf('LOCALHOST:7890', 7890), true, 'scheme 与 host 均忽略大小写');
    assert.equal(proxyEnvPointsAtSelf('localhost:7890', 17890), false, '端口不是自己的仍保留');
  });

  it('未指定地址族写法（0.0.0.0 / :: 及 URL parser 归一变体）也判自代理', () => {
    // macOS 上 connect 到 0.0.0.0 会路由到回环监听器（实测 TCP connect 成功），
    // curl 同样认这些代理形态——漏判让 https_proxy=http://0.0.0.0:7890 逃过自代理
    // 清除，重启先停内核后 update/kernel 必成死锁（与裸 localhost 同族漏网）。
    // URL parser 已把 0、00.0.0.0 归一为 0.0.0.0，[::0]/[::] 归一为 [::]
    for (const url of ['http://0.0.0.0:7890', 'http://0:7890', 'http://00.0.0.0:7890', 'http://[::]:7890', 'http://[::0]:7890']) {
      assert.equal(proxyEnvPointsAtSelf(url, 7890), true, url);
    }
    assert.equal(proxyEnvPointsAtSelf('http://0.0.0.0:7890', 17890), false, '端口不是自己的仍保留');
    assert.equal(proxyEnvPointsAtSelf('http://[::]:7890', 17890), false, 'IPv6 形态同样按端口判');
  });

  it('企业代理、别的工具与无端口形态一律保留（不能误伤 env 代理出网）', () => {
    for (const url of [
      'http://corp-proxy.internal:8080',
      'http://127.0.0.1:1087', // 别的代理工具占用的相邻端口
      'http://192.168.1.10:7890', // 同端口但非本机
      'http://localhost', // 无端口
      'socks5://[::1]:7891',
    ]) {
      assert.equal(proxyEnvPointsAtSelf(url, 7890), false, url);
    }
  });

  it('自定义 Mixed 端口后按新端口判定', () => {
    assert.equal(proxyEnvPointsAtSelf('http://127.0.0.1:17890', 17890), true);
    assert.equal(proxyEnvPointsAtSelf('http://127.0.0.1:7890', 17890), false);
  });

  it('垃圾值不判为自代理（保守保留，交给下游报错而非静默清除）', () => {
    for (const v of ['', 'not a url', '!!!']) {
      assert.equal(proxyEnvPointsAtSelf(v, 7890), false, JSON.stringify(v));
    }
  });
});

describe('parseProxyEndpoint（代理 env 值解析，proxyEnvPointsAtSelf 的拆出件）', () => {
  it('标准/裸形态/大小写 host', () => {
    assert.deepEqual(parseProxyEndpoint('http://127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('socks5://localhost:7890'), { host: 'localhost', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('LOCALHOST:7890'), { host: 'localhost', port: 7890 });
  });

  it('IPv6 字面量剥方括号，未指定地址族保留原样（探活侧归一）', () => {
    assert.deepEqual(parseProxyEndpoint('http://[::1]:7890'), { host: '::1', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('http://[::]:7890'), { host: '::', port: 7890 });
  });

  it('无端口/垃圾值返回 null（不猜端口）', () => {
    assert.equal(parseProxyEndpoint('http://localhost'), null);
    assert.equal(parseProxyEndpoint('not a url'), null);
    assert.equal(parseProxyEndpoint(''), null);
  });
});

describe('stripSelfProxyEnv：per-spawn 去掉自指代理 env，其余原样保留', () => {
  const SELF_PORT = 7890;

  it('六个键（大小写 × http/https/all）里自指的都去掉，removed 返回原值', () => {
    const source: NodeJS.ProcessEnv = {
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://localhost:7890',
      all_proxy: 'socks5://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'localhost:7890',
      ALL_PROXY: 'socks5://[::1]:7890',
      HOME: '/home/u',
    };
    const { env, removed } = stripSelfProxyEnv(source, SELF_PORT);
    assert.deepEqual(env, { HOME: '/home/u' });
    assert.deepEqual(removed, {
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://localhost:7890',
      all_proxy: 'socks5://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'localhost:7890',
      ALL_PROXY: 'socks5://[::1]:7890',
    });
  });

  it('指向别的端口/地址的代理（企业代理、别的工具）原样保留，不误伤', () => {
    const source: NodeJS.ProcessEnv = {
      https_proxy: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://proxy.corp.example:3128',
      all_proxy: 'not a url',
    };
    const { env, removed } = stripSelfProxyEnv(source, SELF_PORT);
    assert.deepEqual(env, source);
    assert.deepEqual(removed, {});
  });

  it('不改 source（返回副本）：自指键只在返回的 env 里消失', () => {
    const source: NodeJS.ProcessEnv = { https_proxy: 'http://127.0.0.1:7890' };
    const { env } = stripSelfProxyEnv(source, SELF_PORT);
    assert.notEqual(env, source);
    assert.equal(source.https_proxy, 'http://127.0.0.1:7890');
    assert.equal(env.https_proxy, undefined);
  });

  it('空值键不算代理：既不去掉也不进 removed', () => {
    const { env, removed } = stripSelfProxyEnv({ https_proxy: '' }, SELF_PORT);
    assert.deepEqual(env, { https_proxy: '' });
    assert.deepEqual(removed, {});
  });
});

describe('stripSelfProxyEnv 缺省端口：读 settings.json 原始 JSON，绝不抛错，异常回退 7890', () => {
  const settingsFile = path.join(dataDir, 'settings.json');
  const at = (port: number): NodeJS.ProcessEnv => ({ https_proxy: `http://127.0.0.1:${port}` });
  /** 缺省端口下该 env 是否被判为自指 */
  const stripped = (port: number): boolean => 'https_proxy' in stripSelfProxyEnv(at(port)).removed;

  const useSettings = (content: string | null): void => {
    fs.rmSync(settingsFile, { force: true });
    if (content !== null) fs.writeFileSync(settingsFile, content);
  };

  it('没有 settings.json：按默认端口 7890', () => {
    useSettings(null);
    assert.equal(stripped(7890), true);
    assert.equal(stripped(17890), false);
  });

  it('ports.mixed 自定义：按新端口判定，默认端口不再算自指', () => {
    useSettings(JSON.stringify({ ports: { mixed: 17890 } }));
    assert.equal(stripped(17890), true);
    assert.equal(stripped(7890), false);
  });

  it('settings 损坏 / 非对象 / 端口非法：回退 7890，不抛错也不动文件', () => {
    for (const content of [
      '{broken json',
      '[1]',
      'null',
      JSON.stringify({ ports: { mixed: 0 } }),
      JSON.stringify({ ports: { mixed: 'x' } }),
      JSON.stringify({ ports: null }),
    ]) {
      useSettings(content);
      assert.equal(stripped(7890), true, content);
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), content, '只读：不备份、不改写损坏文件');
    }
    assert.equal(fs.readdirSync(dataDir).filter(f => f.startsWith('settings.json.')).length, 0, '不产生备份文件');
  });
});
