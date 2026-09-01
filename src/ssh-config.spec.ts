import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { excludeOverwriteProxiesFromIncludeAll, parseYamlOrJson } from './config.js';
import { isOverwriteFilename } from './overwrite.js';
import { applySshConfig, collectSshProxyNames, isSshFilename, renderSshConfigTemplate, renderSshProxy } from './ssh-config.js';
import type { SshConfig, SshFileEntry } from './types.js';

const tunnel = (over: Partial<SshConfig> = {}): SshConfig => ({ name: 'work', host: 'm4', port: 1080, auto: true, ...over });
const file = (config: Record<string, unknown>, name = 'ssh.work.yaml'): SshFileEntry => ({ name, path: `/tmp/${name}`, config });

describe('applySshConfig 合并顺序', () => {
  // 本次解耦的核心不变量：节点的 host/port 只有一个真相（settings）。
  // `~proxies` 是字段级合并且后合并者胜，所以 CLI 注入必须排在用户文件之后——
  // 顺序一旦写反，用户在 ssh.<名字>.yaml 里手写同名节点就能改掉端口，
  // 配置与 `mihomo ssh` 显示的端口对不上，退回改造前的两份真相
  it('用户手写同名节点不能覆盖 CLI 注入的端口', () => {
    const result = applySshConfig({}, [file({ '~proxies': [{ name: 'SSH-Work-Host', port: 9999 }] })], [tunnel()]);
    const proxies = result.proxies as Array<Record<string, unknown>>;
    assert.equal(proxies.length, 1, '同名只应留一条');
    assert.equal(proxies[0].port, 1080, '端口须以 settings 为准，而非用户文件里的 9999');
  });

  it('用户手写同名节点不能覆盖 server（防绕过 127.0.0.1 绑定）', () => {
    const result = applySshConfig({}, [file({ '~proxies': [{ name: 'SSH-Work-Host', server: '0.0.0.0' }] })], [tunnel()]);
    const proxies = result.proxies as Array<Record<string, unknown>>;
    assert.equal(proxies[0].server, '127.0.0.1');
  });

  it('保留订阅原有节点，只追加注入节点', () => {
    const result = applySshConfig({ proxies: [{ name: 'Sub-A' }] }, [], [tunnel()]);
    const proxies = result.proxies as Array<Record<string, unknown>>;
    assert.deepEqual(
      proxies.map(p => p.name),
      ['Sub-A', 'SSH-Work-Host'],
    );
  });

  it('用户文件里的分组与规则照常生效', () => {
    const result = applySshConfig(
      { rules: ['MATCH,DIRECT'] },
      [file({ '~proxy-groups': [{ name: 'SSH-Work', proxies: ['SSH-Work-Host'] }], '+rules': ['DOMAIN-SUFFIX,x.internal,SSH-Work'] })],
      [tunnel()],
    );
    assert.equal((result['proxy-groups'] as unknown[]).length, 1);
    // +rules 是前置插入，用户规则须排在订阅的 MATCH 兜底之前，否则永不命中
    assert.deepEqual(result.rules, ['DOMAIN-SUFFIX,x.internal,SSH-Work', 'MATCH,DIRECT']);
  });

  it('无隧道时不改动配置（也不产生空 proxies 键）', () => {
    const result = applySshConfig({ proxies: [{ name: 'Sub-A' }] }, [], []);
    assert.deepEqual(result.proxies, [{ name: 'Sub-A' }]);
  });

  it('不原地改写入参（污染会让调试用的分阶段文件失真）', () => {
    const base = { proxies: [{ name: 'Sub-A' }] };
    applySshConfig(base, [], [tunnel()]);
    assert.equal(base.proxies.length, 1, '入参 proxies 不应被追加');
  });

  it('多条隧道各自注入独立节点', () => {
    const result = applySshConfig({}, [], [tunnel(), tunnel({ name: 'home', port: 1081 })]);
    const proxies = result.proxies as Array<Record<string, unknown>>;
    assert.deepEqual(
      proxies.map(p => p.name),
      ['SSH-Work-Host', 'SSH-Home-Host'],
    );
    assert.deepEqual(
      proxies.map(p => p.port),
      [1080, 1081],
    );
  });
});

describe('renderSshProxy', () => {
  it('恒绑 127.0.0.1（安全红线，绝不取用户输入的 host）', () => {
    const proxy = renderSshProxy(tunnel({ host: 'evil.example.com' }));
    assert.equal(proxy.server, '127.0.0.1');
    assert.equal(proxy.type, 'socks5');
    assert.equal(proxy.port, 1080);
  });
});

describe('文件名双向隔离', () => {
  // ssh 配置与覆写文件必须互不匹配：交叉命中会让 ssh 文件重新受 `ow off` 影响
  // （本次解耦要消灭的正是这一点），或让覆写文件被 `reset ssh` 误删
  for (const name of ['ssh.work.yaml', 'ssh.home.yml', 'ssh.公司.yaml']) {
    it(`isSshFilename 匹配 ${name}，isOverwriteFilename 不匹配`, () => {
      assert.ok(isSshFilename(name));
      assert.ok(!isOverwriteFilename(name));
    });
  }

  for (const name of ['overwrite.yaml', 'overwrite.dns.yaml', 'overwrite.ssh.yaml']) {
    it(`isOverwriteFilename 匹配 ${name}，isSshFilename 不匹配`, () => {
      assert.ok(isOverwriteFilename(name));
      assert.ok(!isSshFilename(name));
    });
  }

  for (const name of ['ssh.yaml', 'sshfoo.yaml', 'ssh.work.txt', 'notes.md']) {
    it(`isSshFilename 不匹配 ${name}`, () => {
      assert.ok(!isSshFilename(name));
    });
  }
});

describe('注入节点从 include-all 分组排除', () => {
  /** 模拟 mihomo 的 exclude-filter 语义：Go regexp.MatchString，无锚点子串搜索 */
  const excludedBy = (pattern: string, names: string[]): string[] => names.filter(n => new RegExp(pattern).test(n));

  it('整名锚定，不误伤名字包含注入名的订阅节点', () => {
    const config = {
      'proxy-groups': [{ name: 'AUTO', 'include-all': true }],
    };
    excludeOverwriteProxiesFromIncludeAll(config, [], collectSshProxyNames([tunnel()]));
    const pattern = (config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'] as string;
    assert.deepEqual(excludedBy(pattern, ['SSH-Work-Host', 'SSH-Work-Host-2', 'HK-01']), ['SSH-Work-Host']);
  });

  it('与覆写注入的节点名合并到同一条模式里', () => {
    const config = { 'proxy-groups': [{ name: 'AUTO', 'include-all': true }] };
    excludeOverwriteProxiesFromIncludeAll(config, [{ config: { '~proxies': [{ name: 'Manual' }] } }], collectSshProxyNames([tunnel()]));
    const pattern = (config['proxy-groups'][0] as Record<string, unknown>)['exclude-filter'] as string;
    assert.deepEqual(excludedBy(pattern, ['Manual', 'SSH-Work-Host', 'Other']), ['Manual', 'SSH-Work-Host']);
  });

  it('无任何注入节点时不写 exclude-filter', () => {
    const config = { 'proxy-groups': [{ name: 'AUTO', 'include-all': true }] };
    excludeOverwriteProxiesFromIncludeAll(config, [], []);
    assert.ok(!('exclude-filter' in (config['proxy-groups'][0] as Record<string, unknown>)));
  });
});

describe('renderSshConfigTemplate', () => {
  const yamlText = renderSshConfigTemplate(tunnel());
  const parsed = parseYamlOrJson(yamlText, '模板') as Record<string, unknown>;

  it('产物是合法 YAML 且顶层为对象', () => {
    assert.ok(parsed && typeof parsed === 'object');
  });

  it('不含节点定义——节点由 CLI 注入，写进模板会让用户以为改这里能改端口', () => {
    assert.ok(!('~proxies' in parsed), `模板不应声明节点: ${Object.keys(parsed).join(', ')}`);
    assert.ok(!('proxies' in parsed));
    assert.ok(!('+proxies' in parsed));
  });

  it('分组引用 CLI 注入的节点名并带 DIRECT 兜底', () => {
    const groups = parsed['~proxy-groups'] as Array<Record<string, unknown>>;
    assert.equal(groups[0].name, 'SSH-Work');
    assert.deepEqual(groups[0].proxies, ['SSH-Work-Host', 'DIRECT']);
  });

  it('规则段默认注释掉（CLI 无从知道用户的内网域名）', () => {
    assert.ok(!('rules' in parsed) && !('+rules' in parsed));
    assert.ok(yamlText.includes('# +rules:'), '应保留注释形式的 rules 引导');
  });

  it('不含 match 块（ssh 恒全局，match 是 overwrite 专属）', () => {
    assert.ok(!('match' in parsed));
  });
});
