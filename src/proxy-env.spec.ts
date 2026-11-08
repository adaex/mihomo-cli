import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { clearSelfProxyEnv, getClearedProxyEnv, parseProxyEndpoint, proxyEnvPointsAtSelf, recordClearedProxyEnv } from './proxy-env.js';

afterEach(() => recordClearedProxyEnv(null));

describe('proxyEnvPointsAtSelf：只认指向本机 Mixed 端口的代理 env', () => {
  it('本机回环 + 自己的端口才判定为自代理', () => {
    for (const url of ['http://127.0.0.1:7890', 'http://localhost:7890', 'socks5://127.0.0.1:7890', '127.0.0.1:7890']) {
      assert.equal(proxyEnvPointsAtSelf(url, 7890), true, url);
    }
    assert.equal(proxyEnvPointsAtSelf('LOCALHOST:7890', 7890), true);
    assert.equal(proxyEnvPointsAtSelf('localhost:7890', 17890), false);
  });

  it('未指定地址族写法（0.0.0.0 / :: 及 URL parser 归一变体）也判自代理', () => {
    for (const url of ['http://0.0.0.0:7890', 'http://0:7890', 'http://00.0.0.0:7890', 'http://[::]:7890', 'http://[::0]:7890']) {
      assert.equal(proxyEnvPointsAtSelf(url, 7890), true, url);
    }
  });

  it('企业代理、别的工具、其他协议的无端口形态一律保留', () => {
    for (const url of ['http://corp-proxy.internal:8080', 'http://127.0.0.1:1087', 'http://192.168.1.10:7890', 'socks5://localhost', 'socks5://[::1]:7891']) {
      assert.equal(proxyEnvPointsAtSelf(url, 7890), false, url);
    }
  });

  it('垃圾值不判为自代理（保守保留，交给下游报错而非静默清除）', () => {
    for (const value of ['', 'not a url', '!!!']) {
      assert.equal(proxyEnvPointsAtSelf(value, 7890), false, JSON.stringify(value));
    }
  });
});

describe('parseProxyEndpoint', () => {
  it('标准、裸形态、大小写 host 与 IPv6 都能解析', () => {
    assert.deepEqual(parseProxyEndpoint('http://127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('socks5://localhost:7890'), { host: 'localhost', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('127.0.0.1:7890'), { host: '127.0.0.1', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('LOCALHOST:7890'), { host: 'localhost', port: 7890 });
    assert.deepEqual(parseProxyEndpoint('http://[::1]:7890'), { host: '::1', port: 7890 });
  });

  it('http/https 的显式默认端口不会被 URL 归一化吞掉', () => {
    assert.deepEqual(parseProxyEndpoint('http://127.0.0.1:80'), { host: '127.0.0.1', port: 80 });
    assert.deepEqual(parseProxyEndpoint('https://127.0.0.1:443'), { host: '127.0.0.1', port: 443 });
    assert.equal(proxyEnvPointsAtSelf('http://127.0.0.1:80', 80), true);
    assert.equal(proxyEnvPointsAtSelf('https://127.0.0.1:443', 443), true);
  });

  it('http/https 省略端口使用协议默认值，其他协议不猜端口', () => {
    assert.deepEqual(parseProxyEndpoint('http://localhost'), { host: 'localhost', port: 80 });
    assert.deepEqual(parseProxyEndpoint('https://localhost'), { host: 'localhost', port: 443 });
    assert.equal(parseProxyEndpoint('socks5://localhost'), null);
    assert.equal(parseProxyEndpoint('not a url'), null);
    assert.equal(parseProxyEndpoint(''), null);
  });
});

describe('clearSelfProxyEnv：入口清除自指代理，其余 env 保留', () => {
  it('六个键里的自指值都清除并返回原值', () => {
    const source: NodeJS.ProcessEnv = {
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://localhost:7890',
      all_proxy: 'socks5://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'localhost:7890',
      ALL_PROXY: 'socks5://[::1]:7890',
      HOME: '/home/u',
    };
    const cleared = clearSelfProxyEnv(source, 7890);
    assert.deepEqual(source, { HOME: '/home/u' });
    assert.deepEqual(cleared, {
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://localhost:7890',
      all_proxy: 'socks5://127.0.0.1:7890',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'localhost:7890',
      ALL_PROXY: 'socks5://[::1]:7890',
    });
  });

  it('其他代理、非法值与空值都原样保留', () => {
    const source: NodeJS.ProcessEnv = {
      https_proxy: 'http://127.0.0.1:7897',
      HTTPS_PROXY: 'http://proxy.corp.example:3128',
      all_proxy: 'not a url',
      http_proxy: '',
    };
    const before = { ...source };
    assert.deepEqual(clearSelfProxyEnv(source, 7890), {});
    assert.deepEqual(source, before);
  });
});

describe('clearedSelfProxyEnv 登记', () => {
  it('写入与读取都复制对象，调用方后续修改不会污染登记值', () => {
    const original = { https_proxy: 'http://127.0.0.1:7890' };
    recordClearedProxyEnv(original);
    original.https_proxy = 'changed';
    const restored = getClearedProxyEnv();
    assert.deepEqual(restored, { https_proxy: 'http://127.0.0.1:7890' });
    if (restored) restored.https_proxy = 'changed again';
    assert.deepEqual(getClearedProxyEnv(), { https_proxy: 'http://127.0.0.1:7890' });
    recordClearedProxyEnv(null);
    assert.equal(getClearedProxyEnv(), null);
  });
});
