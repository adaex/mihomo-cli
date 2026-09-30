import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectSystemProxy, parseScutilProxy, proxyEnvPointsAtSelf, summarizeSystemProxy } from './system-proxy.js';

/** 本机实测的未配置形态：只有 ExceptionsList/FTPPassive，无任何代理键 */
const EMPTY_DICT = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
}
`;

/** 本机实测的已配置形态（HTTP/HTTPS/SOCKS 全指向 mixed 端口） */
const CONFIGURED_DICT = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7890
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}
`;

describe('parseScutilProxy（scutil --proxy 输出解析）', () => {
  it('未配置时无任何代理条目（数组元素行不误配为键）', () => {
    const view = parseScutilProxy(EMPTY_DICT);
    assert.equal(view.http, undefined);
    assert.equal(view.https, undefined);
    assert.equal(view.socks, undefined);
  });

  it('已配置时解析出 HTTP/HTTPS/SOCKS 的 host 与 port', () => {
    const view = parseScutilProxy(CONFIGURED_DICT);
    assert.deepEqual(view.http, { host: '127.0.0.1', port: 7890 });
    assert.deepEqual(view.https, { host: '127.0.0.1', port: 7890 });
    assert.deepEqual(view.socks, { host: '127.0.0.1', port: 7890 });
  });

  it('Enable ≠ 1 的条目按缺省处理（启用位独立于地址字段）', () => {
    const view = parseScutilProxy(
      `<dictionary> {
  HTTPEnable : 0
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}
`,
    );
    assert.equal(view.http, undefined);
    assert.deepEqual(view.socks, { host: '127.0.0.1', port: 1080 });
  });
});

describe('summarizeSystemProxy（与 Mixed 端口的关系判定）', () => {
  it('回环 host + 端口一致 → matched（HTTP/HTTPS/SOCKS 任一即可）', () => {
    assert.equal(summarizeSystemProxy({ socks: { host: '127.0.0.1', port: 7890 } }, 7890).matched, true);
    assert.equal(summarizeSystemProxy({ https: { host: 'localhost', port: 7890 } }, 7890).matched, true);
  });

  it('端口不一致或非回环 host → 不 matched，但 active 如实列出（供「指向别处」提示）', () => {
    const s = summarizeSystemProxy({ http: { host: '127.0.0.1', port: 8888 }, socks: { host: '192.168.1.5', port: 7890 } }, 7890);
    assert.equal(s.matched, false);
    assert.deepEqual(s.active, ['127.0.0.1:8888', '192.168.1.5:7890']);
  });

  it('同地址多条目去重', () => {
    const s = summarizeSystemProxy(
      { http: { host: '127.0.0.1', port: 7890 }, https: { host: '127.0.0.1', port: 7890 }, socks: { host: '127.0.0.1', port: 7890 } },
      7890,
    );
    assert.deepEqual(s.active, ['127.0.0.1:7890']);
    assert.deepEqual(s.diverged, []);
  });

  it('部分指向时 diverged 如实列出——matched 不掩盖「另一半指向别处」', () => {
    const s = summarizeSystemProxy({ http: { host: '127.0.0.1', port: 8888 }, https: { host: '127.0.0.1', port: 7890 } }, 7890);
    assert.equal(s.matched, true);
    assert.deepEqual(s.diverged, ['127.0.0.1:8888']);
  });
});

describe('PAC / WPAD（脚本接管的系统代理）', () => {
  it('PAC URL 形态解析并透传到 summary（此时不再给手动代理设置命令）', () => {
    const view = parseScutilProxy(
      `<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://127.0.0.1:6152/proxy.pac
}
`,
    );
    assert.deepEqual(view.pac, { source: 'http://127.0.0.1:6152/proxy.pac', wpad: false });
    const s = summarizeSystemProxy(view, 7890);
    assert.equal(s.pac?.source, 'http://127.0.0.1:6152/proxy.pac');
  });

  it('PAC 老式 host/port 形态与 WPAD 自动发现', () => {
    const legacy = parseScutilProxy(
      `<dictionary> {
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigHost : 127.0.0.1
  ProxyAutoConfigPort : 6152
}
`,
    );
    assert.deepEqual(legacy.pac, { source: '127.0.0.1:6152', wpad: false });
    const wpad = parseScutilProxy(
      `<dictionary> {
  ProxyAutoDiscoveryEnable : 1
}
`,
    );
    assert.deepEqual(wpad.pac, { source: '', wpad: true });
  });

  it('PAC 未启用时 summary.pac 为 null', () => {
    assert.equal(summarizeSystemProxy({}, 7890).pac, null);
  });
});

describe('detectSystemProxy（真实 scutil 调用）', () => {
  it('macOS 上 scutil 必在：无论配置与否都应返回判定结果而非 null', () => {
    // 值不锁死（本机代理状态随测试环境变），锁「检测成功且有结构」；
    // 非 macOS 或 scutil 异常时才允许 null，本仓只支持 darwin
    const s = detectSystemProxy(7890);
    assert.notEqual(s, null);
    assert.equal(typeof s?.matched, 'boolean');
    assert.ok(Array.isArray(s?.active));
  });
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
