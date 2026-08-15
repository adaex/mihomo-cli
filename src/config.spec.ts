import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRuleTarget, validateConfig } from './config.js';

describe('getRuleTarget', () => {
  it('取末段为目标', () => {
    assert.equal(getRuleTarget('DOMAIN,example.com,PROXY'), 'PROXY');
  });

  it('no-resolve 尾缀时取倒数第二段', () => {
    assert.equal(getRuleTarget('IP-CIDR,1.1.1.1/32,DIRECT,no-resolve'), 'DIRECT');
  });

  it('no-resolve 大小写不敏感', () => {
    assert.equal(getRuleTarget('IP-CIDR,1.1.1.1/32,DIRECT,NO-RESOLVE'), 'DIRECT');
  });

  it('段数不足返回空', () => {
    assert.equal(getRuleTarget('MATCH'), '');
  });

  it('MATCH 兜底规则', () => {
    assert.equal(getRuleTarget('MATCH,PROXY'), 'PROXY');
  });
});

describe('validateConfig', () => {
  it('移除重名节点', () => {
    const config = {
      proxies: [
        { name: 'a', server: 's', port: 1, type: 'ss' },
        { name: 'a', server: 's2', port: 2, type: 'ss' },
        { name: 'b', server: 's', port: 3, type: 'ss' },
      ],
    };
    const warnings = validateConfig(config);
    assert.equal((config.proxies as unknown[]).length, 2);
    assert.ok(warnings.some(w => w.includes('重名节点')));
  });

  it('分组移除不存在的节点引用', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: ['a', 'ghost'] }],
    };
    const warnings = validateConfig(config);
    const groups = config['proxy-groups'] as Array<{ proxies: string[] }>;
    assert.deepEqual(groups[0].proxies, ['a']);
    assert.ok(warnings.some(w => w.includes('不存在的引用')));
  });

  it('内置代理名（DIRECT/REJECT）视为合法引用', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: ['a', 'DIRECT', 'REJECT'] }],
    };
    validateConfig(config);
    const groups = config['proxy-groups'] as Array<{ proxies: string[] }>;
    assert.deepEqual(groups[0].proxies, ['a', 'DIRECT', 'REJECT']);
  });

  it('清空的分组被删除', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: ['ghost'] }],
    };
    validateConfig(config);
    assert.equal((config['proxy-groups'] as unknown[]).length, 0);
  });

  it('有 include-all 的空分组不删除', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: ['ghost'], 'include-all': true }],
    };
    validateConfig(config);
    assert.equal((config['proxy-groups'] as unknown[]).length, 1);
  });

  it('级联删除：分组 A 只引用被删的分组 B，A 也被删', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [
        { name: 'B', type: 'select', proxies: ['ghost'] },
        { name: 'A', type: 'select', proxies: ['B'] },
      ],
    };
    validateConfig(config);
    // B 因空被删 → A 的唯一引用 B 失效 → A 也被删
    assert.equal((config['proxy-groups'] as unknown[]).length, 0);
  });

  it('删除引用不存在目标的规则', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: ['a'] }],
      rules: ['DOMAIN,x.com,G', 'DOMAIN,y.com,ghost', 'MATCH,a'],
    };
    validateConfig(config);
    assert.deepEqual(config.rules, ['DOMAIN,x.com,G', 'MATCH,a']);
  });

  it('SUB-RULE 类型末段非代理引用，不参与目标校验', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      rules: ['SUB-RULE,(NETWORK,udp),myrule'],
    };
    validateConfig(config);
    assert.deepEqual(config.rules, ['SUB-RULE,(NETWORK,udp),myrule']);
  });
});
