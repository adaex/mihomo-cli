import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactConfigSecrets } from './redact.js';

describe('redactConfigSecrets：配置凭据脱敏', () => {
  it('各出站协议的凭据键在任意嵌套层掩码', () => {
    const input = {
      secret: 'controller-secret',
      proxies: [
        { name: 'ss', type: 'ss', password: 'ss-pw' },
        { name: 'vmess', type: 'vmess', uuid: 'uuid-123', cipher: 'auto' },
        { name: 'wg', type: 'wireguard', 'private-key': 'WG-PRIVATE' },
        { name: 'hy2', type: 'hysteria2', 'auth-str': 'hy-pw' },
        { name: 'hy2-obfs', type: 'hysteria2', obfs: 'salamander', 'obfs-password': 'obfs-secret' },
        { name: 'hy1', type: 'hysteria', auth: 'hy1-auth-b64' },
        { name: 'hy2-realm', type: 'hysteria2', 'realm-opts': { enable: true, token: 'realm-token-789' } },
        {
          name: 'nested',
          type: 'whatever',
          'plugin-opts': { password: 'nested-pw', mode: 'tls' },
        },
      ],
    };
    const { config, changed } = redactConfigSecrets(input);
    const c = config as typeof input;
    assert.equal(c.secret, '***');
    assert.equal(c.proxies[0].password, '***');
    assert.equal(c.proxies[1].uuid, '***');
    assert.equal(c.proxies[1].cipher, 'auto', 'cipher 是算法名不是凭据，不能掩码');
    assert.equal(c.proxies[2]['private-key'], '***');
    assert.equal(c.proxies[3]['auth-str'], '***');
    assert.equal(c.proxies[4]['obfs-password'], '***');
    assert.equal(c.proxies[5].auth, '***');
    assert.equal((c.proxies[6]['realm-opts'] as { token: string }).token, '***');
    assert.equal((c.proxies[7]['plugin-opts'] as { password: string }).password, '***');
    assert.equal(changed, true);
    // 输入不被原地修改
    assert.equal(input.proxies[0].password, 'ss-pw');
  });

  it('provider 容器内的订阅/规则集 URL 脱敏 token，容器外的探测 URL 不动', () => {
    const input = {
      'proxy-providers': {
        airport: { type: 'http', url: 'https://sub.example.com/api/v1/client/subscribe?token=abcdef1234567890' },
      },
      'rule-providers': {
        reject: { type: 'http', behavior: 'domain', url: 'https://rules.example.com/rules.txt' },
      },
      'proxy-groups': [{ name: 'auto', type: 'url-test', url: 'https://www.gstatic.com/generate_204' }],
    };
    const { config } = redactConfigSecrets(input);
    const c = config as typeof input;
    assert.match(c['proxy-providers'].airport.url, /\*\*\*/);
    assert.doesNotMatch(c['proxy-providers'].airport.url, /abcdef1234567890/);
    assert.equal(c['rule-providers'].reject.url, 'https://rules.example.com/rules.txt', '无敏感成分的 provider URL 原样返回');
    assert.equal(c['proxy-groups'][0].url, 'https://www.gstatic.com/generate_204', '容器外的 url 不动');
  });

  it('无凭据时 changed 为 false（命令层据此不显示脱敏提示）', () => {
    const input = {
      proxies: [{ name: 'direct-out', type: 'direct' }],
      rules: ['MATCH,DIRECT'],
    };
    const { changed } = redactConfigSecrets(input);
    assert.equal(changed, false);
  });

  it('非对象/数组标量原样返回', () => {
    assert.deepEqual(redactConfigSecrets('str').config, 'str');
    assert.deepEqual(redactConfigSecrets(42).config, 42);
    assert.deepEqual(redactConfigSecrets(null).config, null);
    assert.deepEqual(redactConfigSecrets([{ password: 'x' }, 1]).config, [{ password: '***' }, 1]);
  });

  it('own __proto__ 键：副本保留键与内容，原型不被替换（可正常 dump）', () => {
    // 回归：js-yaml 解析订阅里的顶层 `__proto__: {...}` 得到 own 键（不污染
    // Object.prototype，但键真实存在）。旧实现 walk 里 out['__proto__'] = ...
    // 命中原型 setter：键从副本静默丢失、副本原型被换成键内容，随后的 dumpYaml
    // 抛「unacceptable kind of an object to dump」让 mihomo-cli config 按程序 bug 渲染
    // （与覆写合并层的同族问题在展示路径的漏网）。JSON.parse 构造 own 键等价
    const doc = JSON.parse('{"proxies":[{"name":"a","password":"x"}],"__proto__":{"evil":true}}');
    const { config } = redactConfigSecrets(doc);
    const out = config as Record<string, unknown>;

    assert.equal(Object.hasOwn(out, '__proto__'), true, '键必须保留在副本里');
    assert.equal(Object.getPrototypeOf(out), Object.prototype, '副本原型仍是 Object.prototype，没被键内容换掉');
    assert.equal((out as { evil?: boolean }).evil, undefined, '键内容没有漏成实例属性');
    assert.deepEqual(out.__proto__, { evil: true }, '键内容原样保留（mihomo-cli 按未知顶层键忽略）');
    assert.equal((out.proxies as [{ password: string }])[0].password, '***', '同文档其他键照常脱敏');
  });
});
