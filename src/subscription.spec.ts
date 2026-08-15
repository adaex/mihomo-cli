import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeProxyNamesBeforeSave } from './subscription.js';
import type { ParsedSubscription } from './types.js';

describe('normalizeProxyNamesBeforeSave', () => {
  it('裁剪 _github.com/<repo> 尾缀并同步分组引用', () => {
    const parsed: ParsedSubscription = {
      raw: {},
      proxies: [{ name: 'HK_github.com/foo', server: 's', port: 1 }],
      proxyGroups: [{ name: 'G', proxies: ['HK_github.com/foo'] }],
    };
    const renamed = normalizeProxyNamesBeforeSave(parsed);
    assert.equal(renamed, 1);
    assert.equal(parsed.proxies[0].name, 'HK');
    assert.deepEqual(parsed.proxyGroups[0].proxies, ['HK']);
  });

  it('无可裁剪尾缀时返回 0、名称不变', () => {
    const parsed: ParsedSubscription = {
      raw: {},
      proxies: [{ name: 'HK', server: 's', port: 1 }],
      proxyGroups: [],
    };
    assert.equal(normalizeProxyNamesBeforeSave(parsed), 0);
    assert.equal(parsed.proxies[0].name, 'HK');
  });

  it('同步 rules 中直接引用旧节点名的目标', () => {
    const parsed: ParsedSubscription = {
      raw: { rules: ['DOMAIN,x.com,HK_github.com/foo', 'MATCH,DIRECT'] },
      proxies: [{ name: 'HK_github.com/foo', server: 's', port: 1 }],
      proxyGroups: [],
    };
    normalizeProxyNamesBeforeSave(parsed);
    assert.deepEqual(parsed.raw.rules, ['DOMAIN,x.com,HK', 'MATCH,DIRECT']);
  });

  it('同步 rules 中带 no-resolve 尾缀的目标位', () => {
    const parsed: ParsedSubscription = {
      raw: { rules: ['IP-CIDR,1.1.1.1/32,HK_github.com/foo,no-resolve'] },
      proxies: [{ name: 'HK_github.com/foo', server: 's', port: 1 }],
      proxyGroups: [],
    };
    normalizeProxyNamesBeforeSave(parsed);
    assert.deepEqual(parsed.raw.rules, ['IP-CIDR,1.1.1.1/32,HK,no-resolve']);
  });

  it('裁剪后名称冲突时保留原名（不重命名到已占用名）', () => {
    const parsed: ParsedSubscription = {
      raw: {},
      proxies: [
        { name: 'HK', server: 's', port: 1 },
        { name: 'HK_github.com/foo', server: 's', port: 2 },
      ],
      proxyGroups: [],
    };
    normalizeProxyNamesBeforeSave(parsed);
    // 'HK' 已被首个占用，第二个裁剪后会撞名，保留原名
    assert.equal(parsed.proxies[0].name, 'HK');
    assert.equal(parsed.proxies[1].name, 'HK_github.com/foo');
  });
});
