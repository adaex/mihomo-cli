import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { excludeOverwriteProxiesFromIncludeAll, getRuleTarget, validateConfig } from './config.js';
import { CliError } from './errors.js';

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

describe('validateConfig 级联删除的空洞（此前全部静默通过）', () => {
  it('proxy 与 proxy-group 同名时告警（mihomo 会因重复名拒绝加载）', () => {
    const config = {
      proxies: [{ name: 'HK', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'HK', type: 'select', proxies: ['DIRECT'] }],
    };
    const warnings = validateConfig(config);
    assert.ok(
      warnings.some(w => w.includes('名称冲突') && w.includes('HK')),
      `应告警名称冲突，实际: ${JSON.stringify(warnings)}`,
    );
  });

  it('use 引用不存在的 provider 时移除并告警', () => {
    const config = {
      proxies: [{ name: 'a', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: ['a'], use: ['ghost-provider'] }],
    };
    const warnings = validateConfig(config);
    const groups = config['proxy-groups'] as Array<{ use: string[] }>;
    assert.deepEqual(groups[0].use, []);
    assert.ok(warnings.some(w => w.includes('provider')));
  });

  it('use 引用真实存在的 provider 时保留', () => {
    const config = {
      'proxy-providers': { mysub: { type: 'http', url: 'https://x' } },
      proxies: [],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: [], use: ['mysub'] }],
    };
    const warnings = validateConfig(config);
    const groups = config['proxy-groups'] as Array<{ use: string[] }>;
    assert.deepEqual(groups[0].use, ['mysub'], '真实 provider 不应被移除');
    assert.equal(groups.length, 1, '有有效 use 的组不应被删');
    assert.equal(warnings.length, 0);
  });

  it('节点池为空 + include-all 的空组被移除（此前保留，实际无任何出口）', () => {
    const config = {
      proxies: [],
      'proxy-groups': [{ name: 'AUTO', type: 'select', proxies: [], 'include-all': true }],
      rules: ['MATCH,AUTO'],
    };
    validateConfig(config);
    assert.equal((config['proxy-groups'] as unknown[]).length, 0, '空组应被移除');
    assert.equal((config.rules as unknown[]).length, 0, '指向空组的规则应连带移除');
  });

  it('节点池非空 + include-all 的组保留（不能误删正常配置）', () => {
    const config = {
      proxies: [{ name: 'HK-01', server: 's', port: 1, type: 'ss' }],
      'proxy-groups': [{ name: 'AUTO', type: 'select', proxies: [], 'include-all': true }],
      rules: ['MATCH,AUTO'],
    };
    const warnings = validateConfig(config);
    assert.equal((config['proxy-groups'] as unknown[]).length, 1);
    assert.equal((config.rules as unknown[]).length, 1);
    assert.equal(warnings.length, 0);
  });

  it('group.proxies 写成字符串时按单元素处理并告警（此前整体跳过、非法结构落盘）', () => {
    const config = {
      proxies: [],
      'proxy-groups': [{ name: 'G', type: 'select', proxies: 'DIRECT' }],
    };
    const warnings = validateConfig(config);
    const groups = config['proxy-groups'] as Array<{ proxies: unknown }>;
    assert.deepEqual(groups[0].proxies, ['DIRECT']);
    assert.ok(warnings.some(w => w.includes('应为列表')));
  });
});

describe('validateConfig 形态校验（YAML 笔误转 CliError）', () => {
  // 这些输入此前会抛裸 TypeError，经 main().catch 当成程序 bug 打印堆栈
  const malformed: { label: string; config: Record<string, unknown> }[] = [
    { label: 'proxies 含 null 元素（列表留空行）', config: { proxies: [{ name: 'a' }, null] } },
    { label: 'rules 写成标量（漏写 -）', config: { rules: 'MATCH,DIRECT' } },
    { label: 'proxy-groups 写成映射', config: { 'proxy-groups': { name: 'G' } } },
    { label: 'rules 含非字符串', config: { rules: [123] } },
    { label: 'proxies 元素缺 name', config: { proxies: [{ server: 's', port: 1 }] } },
    { label: 'proxies 元素是标量', config: { proxies: ['just-a-string'] } },
  ];

  for (const { label, config } of malformed) {
    it(`${label} → CliError 而非 TypeError`, () => {
      assert.throws(
        () => validateConfig(config),
        (e: unknown) => {
          assert.ok(e instanceof CliError, `应为 CliError，实际 ${(e as Error).constructor.name}`);
          assert.equal((e as CliError).label, '配置错误');
          return true;
        },
      );
    });
  }

  const valid: { label: string; config: Record<string, unknown> }[] = [
    { label: '完全为空', config: {} },
    { label: '各段为 null', config: { proxies: null, 'proxy-groups': null, rules: null } },
    { label: '各段为空列表', config: { proxies: [], 'proxy-groups': [], rules: [] } },
    { label: '中文节点名', config: { proxies: [{ name: '香港01' }], 'proxy-groups': [{ name: '自动', proxies: ['香港01'] }], rules: ['MATCH,自动'] } },
  ];

  for (const { label, config } of valid) {
    it(`合法配置不被误拒: ${label}`, () => {
      assert.doesNotThrow(() => validateConfig(config));
    });
  }
});

describe('excludeOverwriteProxiesFromIncludeAll（排除模式整名锚定）', () => {
  /** 模拟 mihomo 的 exclude-filter 语义：Go regexp.MatchString，无锚点子串搜索 */
  const excludedBy = (pattern: string, names: string[]) => names.filter(n => new RegExp(pattern).test(n));

  it('注入短名节点不误排除订阅里的同前缀节点', () => {
    const config = {
      proxies: [{ name: 'HK-01' }, { name: 'HK-02' }, { name: 'JP-Tokyo' }, { name: 'HK' }],
      'proxy-groups': [{ name: 'AUTO', type: 'url-test', 'include-all': true }],
    };
    excludeOverwriteProxiesFromIncludeAll(config, [{ config: { 'proxies+': [{ name: 'HK' }] } }]);
    const pattern = (config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'] as string;
    // 只排除注入的 HK 自身，HK-01/HK-02 仍留在 include-all 分组
    assert.deepEqual(excludedBy(pattern, ['HK-01', 'HK-02', 'JP-Tokyo', 'HK']), ['HK']);
  });

  it('与订阅自带 exclude-filter 拼接后双方语义都保留', () => {
    const config = {
      'proxy-groups': [{ name: 'AUTO', 'include-all': true, 'exclude-filter': '过期|剩余' }],
    };
    excludeOverwriteProxiesFromIncludeAll(config, [{ config: { '~proxies': [{ name: 'HK' }] } }]);
    const pattern = (config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'] as string;
    // 订阅原有的子串语义（过期流量 被排除）与新增的整名语义（HK 排除、HK-01 保留）并存
    assert.deepEqual(excludedBy(pattern, ['过期流量', 'HK', 'HK-01']), ['过期流量', 'HK']);
  });

  it('~proxies patch 订阅已有节点时不把它排除出 include-all（节点本就在池子里）', () => {
    // 回归：~ 的正当用法是就地 patch 已有节点字段，不注入新节点——照收进
    // exclude-filter 会把该节点从所有 include-all 分组剔除，分流静默改变
    const config = {
      proxies: [{ name: 'HK-01', port: 443 }, { name: 'HK-02' }],
      'proxy-groups': [{ name: 'AUTO', type: 'url-test', 'include-all': true }],
    };
    excludeOverwriteProxiesFromIncludeAll(config, [{ config: { '~proxies': [{ name: 'HK-01', port: 8443 }] } }], new Set(['HK-01', 'HK-02']));
    assert.equal((config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'], undefined, 'patch 已有节点不应产生 exclude-filter');
  });

  it('~proxies 新增订阅里没有的节点时仍被排除（真注入才排除）', () => {
    const config = {
      proxies: [{ name: 'HK-01' }],
      'proxy-groups': [{ name: 'AUTO', type: 'url-test', 'include-all': true }],
    };
    excludeOverwriteProxiesFromIncludeAll(config, [{ config: { '~proxies': [{ name: 'Self-Node' }] } }], new Set(['HK-01']));
    const pattern = (config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'] as string;
    assert.deepEqual(excludedBy(pattern, ['HK-01', 'Self-Node']), ['Self-Node']);
  });

  it('正则元字符按字面量转义', () => {
    const config = { 'proxy-groups': [{ name: 'AUTO', 'include-all': true }] };
    excludeOverwriteProxiesFromIncludeAll(config, [{ config: { 'proxies+': [{ name: 'A.B+C' }] } }]);
    const pattern = (config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'] as string;
    assert.deepEqual(excludedBy(pattern, ['A.B+C', 'AxBxC', 'A.B+CD']), ['A.B+C']);
  });

  it('无 include-all 的分组不加 exclude-filter', () => {
    const config = { 'proxy-groups': [{ name: 'G', type: 'select', proxies: ['HK'] }] };
    excludeOverwriteProxiesFromIncludeAll(config, [{ config: { 'proxies+': [{ name: 'HK' }] } }]);
    assert.equal((config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'], undefined);
  });
});
