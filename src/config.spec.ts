import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-config-build-'));
process.env.MIHOMO_CLI_DIR = tmpDir;
const { assertConfigShape, buildConfig, buildKernelRejectHint, dumpYaml, parseConfigContent } = await import('./config.js');
const { CliError } = await import('./errors.js');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('parseConfigContent：订阅内容解析（YAML 覆盖 JSON，无独立 JSON 回退）', () => {
  // YAML 1.2 是 JSON 超集，故删掉了此前那条 JSON.parse 回退分支。
  // 这组用例锁住「删掉之后 JSON 输入照样能解析」，防有人以为需要把回退加回来。
  it('标准 JSON 由 YAML 解析器正常收下', () => {
    const r = parseConfigContent('{"proxies":[{"name":"a"}],"mixed-port":7890}');
    assert.deepEqual(r.proxies, [{ name: 'a' }]);
    assert.equal(r['mixed-port'], 7890);
  });

  it('tab 缩进的 JSON 同样解析（YAML 的缩进限制只针对块结构，流式映射不受影响）', () => {
    const r = parseConfigContent('{\n\t"a": 1\n}');
    assert.equal(r.a, 1);
  });

  it('常规 YAML 正常解析', () => {
    const r = parseConfigContent('proxies:\n  - name: hk\nrules:\n  - MATCH,DIRECT\n');
    assert.deepEqual(r.rules, ['MATCH,DIRECT']);
  });

  it('重复键报错，不静默取最后一个值', () => {
    // 这是唯一走得到旧 JSON 回退分支的输入：JSON.parse 静默取 2，把坏数据变成「接受」。
    // 订阅里出现重复键意味着上游生成有问题，取哪个值都是猜，必须让用户看见
    assert.throws(() => parseConfigContent('{"a":1,"a":2}', '订阅内容'), /订阅内容格式错误/);
  });

  it('顶层为列表/标量时报错并说明期望形态', () => {
    assert.throws(() => parseConfigContent('- a\n- b', '订阅内容'), /不是有效的配置对象.*列表/s);
    assert.throws(() => parseConfigContent('just a string', '订阅内容'), /不是有效的配置对象/);
    assert.throws(() => parseConfigContent('42', '订阅内容'), /不是有效的配置对象/);
  });

  it('空内容与纯空白报「为空」', () => {
    assert.throws(() => parseConfigContent('', '订阅内容'), /订阅内容为空/);
    assert.throws(() => parseConfigContent('   \n\t ', '订阅内容'), /订阅内容为空/);
  });

  it('YAML 语法错误带出解析器的定位信息（排查笔误的主要线索）', () => {
    assert.throws(() => parseConfigContent('proxies:\n  - name: a\n   bad-indent: 1\n', '订阅内容'), /订阅内容格式错误，无法解析: .+/);
  });
});

describe('assertConfigShape 形态校验（YAML 笔误转 CliError）', () => {
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
        () => assertConfigShape(config),
        (e: unknown) => {
          assert.ok(e instanceof CliError, `应为 CliError，实际 ${(e as Error).constructor.name}`);
          assert.equal(e.label, '配置错误');
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
      assert.doesNotThrow(() => assertConfigShape(config));
    });
  }
});

describe('配置构建保留用户的节点和分流语义', () => {
  it('不去重节点、不级联删除分组或分流规则，交给内核决定合法性', () => {
    const input = {
      proxies: [{ name: 'p' }, { name: 'p' }],
      'proxy-groups': [
        { name: 'A', proxies: ['B'] },
        { name: 'B', proxies: ['missing'] },
      ],
      rules: ['DOMAIN,example.com,A', 'MATCH,DIRECT'],
    };
    const { config, warnings } = buildConfig(dumpYaml(input), 'mixed');
    assert.deepEqual(config.proxies, input.proxies);
    assert.deepEqual(config['proxy-groups'], input['proxy-groups']);
    assert.deepEqual(config.rules, input.rules);
    assert.deepEqual(warnings, []);
  });

  it('覆写增加的节点遵守原有 include-all 和 exclude-filter，不额外排除', () => {
    fs.writeFileSync(path.join(tmpDir, 'overwrite.yaml'), '~proxies:\n  - {name: local, type: socks5, server: 127.0.0.1, port: 1080}\n');
    try {
      const groups = [{ name: 'AUTO', 'include-all': true, 'exclude-filter': '过期' }];
      const { config } = buildConfig(dumpYaml({ 'proxy-groups': groups, rules: ['MATCH,AUTO'] }), 'mixed');
      assert.deepEqual(config['proxy-groups'], groups);
      assert.equal((config.proxies as unknown[]).length, 1);
    } finally {
      fs.rmSync(path.join(tmpDir, 'overwrite.yaml'));
    }
  });

  it('不改写 group.proxies 的标量或不存在的 provider 引用', () => {
    const groups = [{ name: 'G', proxies: 'DIRECT', use: ['missing-provider'] }];
    const { config } = buildConfig(dumpYaml({ 'proxy-groups': groups }), 'mixed');
    assert.deepEqual(config['proxy-groups'], groups);
  });
});

describe('buildKernelRejectHint：内核拒绝配置时的排查线索', () => {
  it('目标文案逐行一致（含覆写清单与作用域）', () => {
    const hint = buildKernelRejectHint("ProxyGroup Developer: '' has unset fields: type", [
      'overwrite.glados.yaml (url-domain=glados-config.com)',
      'overwrite.seal.yaml (全局)',
    ]);
    assert.deepEqual(hint, [
      '',
      "  ProxyGroup Developer: '' has unset fields: type",
      '',
      '  当前生效的覆写文件:',
      '    overwrite.glados.yaml (url-domain=glados-config.com)',
      '    overwrite.seal.yaml (全局)',
      '  若报错的元素来自覆写追加（~key 未匹配到同名元素时会新增），改用 ~?key 可在缺少该元素的订阅上跳过。',
      '',
      '  请修正订阅或覆写；当前运行时配置未改动。',
    ]);
  });

  // 空清单的三种来源（无覆写文件、ow off、没命中 match）都不该出现这段：
  // 问题必在订阅本身，多打一段只会把排查方向引偏
  it('覆写清单为空时完全不含该段', () => {
    assert.deepEqual(buildKernelRejectHint('boom', []), ['', '  boom', '', '  请修正订阅或覆写；当前运行时配置未改动。']);
  });

  it('内核多行输出逐行缩进，空行仍是空行（不缩出尾随空格）', () => {
    const hint = buildKernelRejectHint('line1\n\nline2', []);
    assert.deepEqual(hint, ['', '  line1', '', '  line2', '', '  请修正订阅或覆写；当前运行时配置未改动。']);
  });

  it('覆写摘要经终端消毒，ESC 序列不进输出', () => {
    const hint = buildKernelRejectHint('boom', ['\x1b[31moverwrite.red.yaml\x1b[0m (全局)']);
    assert.ok(!hint.join('\n').includes('\x1b'), 'hint 不应残留 ESC 字符');
    assert.ok(hint.includes('    overwrite.red.yaml (全局)'));
  });
});

describe('buildConfig 带出本次生效的覆写清单', () => {
  const OW_MAIN = 'overwrite.yaml';
  const OW_SCOPED = 'overwrite.glados.yaml';
  const SUB = dumpYaml({ 'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['DIRECT'] }], rules: ['MATCH,PROXY'] });

  it('按 match 作用域过滤，顺序即合并顺序；未命中的订阅不列该文件', () => {
    fs.writeFileSync(path.join(tmpDir, OW_MAIN), 'log-level: warning\n');
    fs.writeFileSync(path.join(tmpDir, OW_SCOPED), 'match:\n  url-domain: glados-config.com\n~proxy-groups:\n  - {name: Developer, default-selected: TW}\n');
    try {
      const hit = buildConfig(SUB, 'mixed', { subName: 'mini1', subUrl: 'https://update.glados-config.com/mihomo/x/y/z/glados.yaml' });
      assert.deepEqual(hit.overwriteSummaries, [`${OW_MAIN} (全局)`, `${OW_SCOPED} (url-domain=glados-config.com)`]);

      // 追加语义有意保留：mini1 没有 Developer 分组，补丁被追加成缺 type 的分组，
      // 由内核拒绝——提示里的覆写清单正是为这一幕准备的
      assert.deepEqual((hit.config['proxy-groups'] as unknown[])[1], { name: 'Developer', 'default-selected': 'TW' });

      const miss = buildConfig(SUB, 'mixed', { subName: 'other', subUrl: 'https://other.example.com/sub' });
      assert.deepEqual(miss.overwriteSummaries, [`${OW_MAIN} (全局)`]);
    } finally {
      fs.rmSync(path.join(tmpDir, OW_MAIN));
      fs.rmSync(path.join(tmpDir, OW_SCOPED));
    }
  });

  it('没有覆写文件时为空数组', () => {
    assert.deepEqual(buildConfig(SUB, 'mixed').overwriteSummaries, []);
  });

  // 与上一条同一个现场：订阅里没有 Developer 分组。~key 追加出残缺分组交给内核拒绝，
  // ~?key 则跳过并告警——用户不必为此改 match 作用域
  it('~?key 未命中时跳过并产生告警，配置仍可用', () => {
    fs.writeFileSync(path.join(tmpDir, OW_SCOPED), '~?proxy-groups:\n  - {name: Developer, default-selected: TW}\n');
    try {
      const { config, warnings } = buildConfig(SUB, 'mixed', { subName: 'mini1', subUrl: 'https://update.glados-config.com/x/glados.yaml' });
      // 订阅原有分组不受影响，也没有多出缺 type 的残缺分组
      assert.deepEqual(config['proxy-groups'], [{ name: 'PROXY', type: 'select', proxies: ['DIRECT'] }]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Developer/);
      assert.match(warnings[0], /已跳过/);
      assert.match(warnings[0], new RegExp(OW_SCOPED.replace('.', '\\.')));
    } finally {
      fs.rmSync(path.join(tmpDir, OW_SCOPED));
    }
  });

  it('~?key 命中时正常合并且不告警', () => {
    fs.writeFileSync(path.join(tmpDir, OW_SCOPED), '~?proxy-groups:\n  - {name: PROXY, default-selected: DIRECT}\n');
    try {
      const { config, warnings } = buildConfig(SUB, 'mixed');
      assert.deepEqual(config['proxy-groups'], [{ name: 'PROXY', type: 'select', proxies: ['DIRECT'], 'default-selected': 'DIRECT' }]);
      assert.deepEqual(warnings, []);
    } finally {
      fs.rmSync(path.join(tmpDir, OW_SCOPED));
    }
  });
});
