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

describe('系统锁定项：订阅自带的端口与控制面字段不进运行配置', () => {
  const BASE = {
    proxies: [{ name: 'a', type: 'socks5', server: '127.0.0.1', port: 1080 }],
    'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['a', 'DIRECT'] }],
    rules: ['MATCH,PROXY'],
  };

  // redir/tproxy 与 port/socks-port 同族，都是订阅自带的入站端口；泄漏进 mixed 会让内核
  // 额外开透明代理入站监听。删除清单在 mode 分支之前执行，Mixed 与 TUN 共用同一份，
  // 故两种模式各锁一条：TUN 是 L3 透明代理，透明端口同样不该由订阅决定
  for (const mode of ['mixed', 'tun'] as const) {
    it(`${mode}: 订阅自带的 redir-port/tproxy-port 被剥掉`, () => {
      const { config } = buildConfig(dumpYaml({ ...BASE, 'redir-port': 7893, 'tproxy-port': 7894 }), mode);
      assert.equal('redir-port' in config, false, 'redir-port 不应进入运行配置');
      assert.equal('tproxy-port' in config, false, 'tproxy-port 不应进入运行配置');
    });
  }

  it('锁定项家族整体生效：端口与控制面取 settings（默认值），订阅提供的值全部被剥掉', () => {
    const sub = dumpYaml({
      ...BASE,
      port: 7891,
      'socks-port': 7892,
      'redir-port': 7893,
      'tproxy-port': 7894,
      'mixed-port': 17890,
      'external-controller': '0.0.0.0:19090',
      secret: 'from-subscription',
      'external-ui': 'ui',
      'external-ui-name': 'yacd',
      'external-ui-url': 'https://example.com/ui.zip',
    });
    const { config } = buildConfig(sub, 'mixed');
    // 本 spec 未写 settings.json，getPorts 取默认 7890/9090、无 controller_secret
    assert.equal(config['mixed-port'], 7890);
    assert.equal(config['external-controller'], '127.0.0.1:9090');
    for (const key of ['port', 'socks-port', 'redir-port', 'tproxy-port', 'secret', 'external-ui', 'external-ui-name', 'external-ui-url']) {
      assert.equal(key in config, false, `${key} 应从运行配置中剥掉`);
    }
  });

  it('settings.ports 与 controller_secret 才是生效来源，订阅同名字段对结果无影响', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ ports: { mixed: 17891, controller: 19091 }, controller_secret: 'from-settings' }));
    try {
      const sub = dumpYaml({ ...BASE, 'mixed-port': 7890, 'external-controller': '0.0.0.0:9090', secret: 'from-subscription' });
      const { config } = buildConfig(sub, 'mixed');
      assert.equal(config['mixed-port'], 17891);
      assert.equal(config['external-controller'], '127.0.0.1:19091');
      assert.equal(config.secret, 'from-settings');
    } finally {
      fs.rmSync(path.join(tmpDir, 'settings.json'));
    }
  });

  // redir/tproxy 曾是漏网之鱼；external-controller-tls/-unix/-cors、-doh、tuic-server
  // 与 tls 段同族——订阅是远端不可信内容，留着任一个都能开出 CLI 不知道的入站
  // （无鉴权控制器、开放代理，可监听全网卡）
  for (const mode of ['mixed', 'tun'] as const) {
    it(`${mode}: 控制器家族键、tuic-server 与 tls 证书段不进运行配置`, () => {
      const sub = dumpYaml({
        ...BASE,
        'external-controller-tls': '0.0.0.0:19443',
        'external-controller-unix': '/tmp/evil.sock',
        'external-controller-pipe': '\\\\.\\pipe\\evil',
        'external-controller-cors': { 'allow-origins': ['*'], 'allow-private-network': true },
        'external-controller-routing-mark': 42,
        'external-doh-server': '/dns-query',
        'tuic-server': { enable: true, listen: '0.0.0.0:9999', token: ['abc'] },
        tls: { certificate: '/tmp/cert.pem', 'private-key': '/tmp/key.pem' },
      });
      const { config } = buildConfig(sub, mode);
      for (const key of [
        'external-controller-tls',
        'external-controller-unix',
        'external-controller-pipe',
        'external-controller-cors',
        'external-controller-routing-mark',
        'external-doh-server',
        'tuic-server',
        'tls',
      ]) {
        assert.equal(key in config, false, `${key} 不应进入运行配置`);
      }
      // 主控制器仍是回环 + settings 端口，不被同段其他键影响
      assert.equal(config['external-controller'], '127.0.0.1:9090');
    });
  }

  // ss-config/vmess-config 与 tuic-server 是上游 config.Inbound 里并列的三个字段、
  // 同由 updateListeners() 逐个 ReCreate* 起监听，但形态是一行 URL 而非映射，容易漏。
  // 上游 ParseSSURL/ParseVmessURL 把 URL 的 host 直接当 Listen 且不经 genAddr，
  // 故 allow-lan/bind-address 都拦不住：一行订阅字段即全网卡开放代理
  for (const mode of ['mixed', 'tun'] as const) {
    it(`${mode}: 订阅的 ss-config/vmess-config 入站服务端不进运行配置`, () => {
      const sub = dumpYaml({
        ...BASE,
        'ss-config': 'ss://aes-128-gcm:leaked-password@0.0.0.0:8388',
        'vmess-config': 'vmess://user:b831381d-6324-4d53-ad4f-8cda48b30811@0.0.0.0:8443',
      });
      const { config } = buildConfig(sub, mode);
      assert.equal('ss-config' in config, false, 'ss-config 会开出带密码的 Shadowsocks 入站，必须剥除');
      assert.equal('vmess-config' in config, false, 'vmess-config 会开出 Vmess 入站，必须剥除');
    });
  }

  // allow-lan 自 v4.13.0 起也是锁定项（订阅写 true 也恒回落 false），但它与 ss-config
  // 的剥除仍是**两套独立机制**：上游 ParseSSURL 把 URL 的 host 直接当 Listen、不经
  // genAddr，即便 allow-lan 为假也照样全网卡监听。故这里刻意用 `allow-lan: true` 施压——
  // 同时证明新锁生效、且 ss-config 的剥除不依赖 allow-lan 的取值
  it('订阅把 allow-lan 开成 true 也拦不住 ss-config：两者是独立机制，且 allow-lan 自身被锁回 false', () => {
    const sub = dumpYaml({ ...BASE, 'allow-lan': true, 'ss-config': 'ss://aes-128-gcm:p@0.0.0.0:8388' });
    const { config } = buildConfig(sub, 'mixed');
    assert.equal(config['allow-lan'], false, '订阅的 allow-lan: true 必须被锁回 false');
    assert.equal('ss-config' in config, false);
  });

  // listeners/tunnels 是通用入站声明，与 ss/vmess/tuic 满足完全相同的判据：
  // 订阅可指定监听地址、不经 genAddr、allow-lan 管不到。v4.12.0 前它们被记成
  // 「未定的产品决策」挂了三个版本，而「待定」在实现上等于放行——实测订阅里写
  // listeners 会原样进运行配置，与 README「入站默认关闭」的承诺冲突。
  // iptables 是 Linux 专用、darwin 无此路径，继续保留
  for (const mode of ['mixed', 'tun'] as const) {
    it(`${mode}: 订阅的 listeners/tunnels 入站声明不进运行配置`, () => {
      const sub = dumpYaml({
        ...BASE,
        listeners: [{ name: 'x', type: 'socks', listen: '0.0.0.0', port: 18080 }],
        tunnels: ['tcp,0.0.0.0:4444,1.2.3.4:443,DIRECT'],
      });
      const { config } = buildConfig(sub, mode);
      assert.equal('listeners' in config, false, 'listeners 一条即可开出无鉴权入站，必须剥除');
      assert.equal('tunnels' in config, false, 'tunnels 自带本地监听地址，必须剥除');
    });
  }

  it('订阅把 allow-lan 开成 true 也拦不住 listeners：与 ss-config 同理，且 allow-lan 自身被锁回 false', () => {
    const sub = dumpYaml({
      ...BASE,
      'allow-lan': true,
      listeners: [{ name: 'x', type: 'socks', listen: '0.0.0.0', port: 18080 }],
    });
    const { config } = buildConfig(sub, 'mixed');
    assert.equal(config['allow-lan'], false, '订阅的 allow-lan: true 必须被锁回 false');
    assert.equal('listeners' in config, false);
  });

  it('iptables 仍原样保留：Linux 专用的系统集成开关，非监听、darwin 无该路径', () => {
    const sub = dumpYaml({ ...BASE, iptables: { enable: true } });
    const { config } = buildConfig(sub, 'mixed');
    assert.deepEqual(config.iptables, { enable: true });
  });

  // 局域网暴露与入站鉴权家族（v4.13.0 新锁）。上游 config.Inbound 里与 ss-config 等
  // 并列的字段，只因形态是布尔/字符串而非映射被漏了五轮。实测链条见 LOCKED_CONFIG_KEYS
  const LAN_AUTH_KEYS = ['bind-address', 'authentication', 'skip-auth-prefixes', 'lan-allowed-ips', 'lan-disallowed-ips'];

  for (const mode of ['mixed', 'tun'] as const) {
    it(`${mode}: 订阅的局域网暴露与入站鉴权键不进运行配置，allow-lan 锁回 false`, () => {
      const sub = dumpYaml({
        ...BASE,
        'allow-lan': true,
        'bind-address': '*',
        authentication: ['attacker:pass'],
        'skip-auth-prefixes': ['0.0.0.0/0'],
        'lan-allowed-ips': ['0.0.0.0/0'],
        'lan-disallowed-ips': ['10.0.0.0/8'],
      });
      const { config } = buildConfig(sub, mode);
      for (const key of LAN_AUTH_KEYS) {
        assert.equal(key in config, false, `${key} 不应进入运行配置`);
      }
      // allow-lan 是锁定项里唯一有恒定值的：不是消失，而是被 systemConfig 写回 false
      assert.equal(config['allow-lan'], false, 'allow-lan 必须恒为 false，而不是从配置里消失');
    });
  }

  // 实测复现过的完整攻击形态：这三行 YAML 曾让远端订阅把 Mixed 端口开到全网卡且无鉴权
  //（genAddr 在 allow-lan 为真、bind-address 为 "*" 时返回 ":%d"；skip-auth-prefixes
  // 命中后 http/server.go 把鉴权 store 换成 authStore.Nil）
  it('组合攻击形态：allow-lan + bind-address + skip-auth-prefixes 三键同时投递也全部失效', () => {
    const sub = dumpYaml({ ...BASE, 'allow-lan': true, 'bind-address': '*', 'skip-auth-prefixes': ['0.0.0.0/0'] });
    const { config } = buildConfig(sub, 'mixed');
    assert.equal(config['allow-lan'], false, 'Mixed 必须留在回环');
    assert.equal('bind-address' in config, false);
    assert.equal('skip-auth-prefixes' in config, false, '鉴权绕过键必须剥除');
    assert.equal(config['mixed-port'], 7890);
  });

  it('订阅侧的局域网/鉴权键同样静默剥除，不产生锁定 warning', () => {
    const sub = dumpYaml({ ...BASE, 'allow-lan': true, authentication: ['a:b'], 'skip-auth-prefixes': ['0.0.0.0/0'] });
    const { warnings } = buildConfig(sub, 'mixed');
    assert.deepEqual(warnings, [], `订阅侧锁定键不应告警，实际: ${JSON.stringify(warnings)}`);
  });

  it('覆写里的局域网/鉴权键剥除并告警（含 allow-lan! 与 +authentication 操作符形式）', () => {
    const owPath = path.join(tmpDir, 'overwrite.yaml');
    fs.writeFileSync(owPath, ['allow-lan!: true', '+authentication:', '  - "me:pass"', "skip-auth-prefixes: ['0.0.0.0/0']"].join('\n'));
    try {
      const { config, warnings } = buildConfig(dumpYaml(BASE), 'mixed');
      assert.equal(config['allow-lan'], false);
      assert.equal('authentication' in config, false);
      assert.equal('skip-auth-prefixes' in config, false);
      const locked = warnings.find(w => w.includes('系统锁定项已忽略'));
      assert.ok(locked, `覆写锁定键应告警，实际: ${JSON.stringify(warnings)}`);
      assert.match(locked, /overwrite\.yaml/);
      assert.match(locked, /allow-lan/);
      assert.match(locked, /authentication/);
      assert.match(locked, /skip-auth-prefixes/);
    } finally {
      fs.rmSync(owPath);
    }
  });

  // 锁住的是「刻意放行」这个决策，不是它们的正确性：TFO/MPTCP 是传输层 socket 选项，
  // 不开监听、不改绑定地址、不绕鉴权（信任边界不是配置洁癖）。决策改变时这条会明确失败
  it('inbound-tfo / inbound-mptcp 仍原样保留：传输层 socket 调优，非监听、不绕鉴权', () => {
    const sub = dumpYaml({ ...BASE, 'inbound-tfo': true, 'inbound-mptcp': true });
    const { config } = buildConfig(sub, 'mixed');
    assert.equal(config['inbound-tfo'], true);
    assert.equal(config['inbound-mptcp'], true);
  });

  it('订阅侧的锁定键静默剥除：机场订阅普遍自带端口段，不产生锁定 warning', () => {
    const sub = dumpYaml({ ...BASE, 'mixed-port': 17890, port: 7891, 'socks-port': 7892, secret: 'x' });
    const { config, warnings } = buildConfig(sub, 'mixed');
    assert.equal(config['mixed-port'], 7890);
    assert.equal('secret' in config, false);
    assert.deepEqual(warnings, [], `订阅侧锁定键不应告警，实际: ${JSON.stringify(warnings)}`);
  });

  it('生效覆写文件里的锁定键（含操作符形式）才告警并带文件名', () => {
    const owPath = path.join(tmpDir, 'overwrite.yaml');
    fs.writeFileSync(owPath, ['redir-port: 7893', 'external-doh-server: /dns-query', 'tls!:', '  certificate: /x.pem'].join('\n'));
    try {
      const { config, warnings } = buildConfig(dumpYaml(BASE), 'mixed');
      assert.equal('redir-port' in config, false);
      assert.equal('tls' in config, false);
      const locked = warnings.find(w => w.includes('系统锁定项已忽略'));
      assert.ok(locked, `覆写锁定键应告警，实际: ${JSON.stringify(warnings)}`);
      assert.match(locked, /overwrite\.yaml/);
      assert.match(locked, /redir-port/);
      assert.match(locked, /external-doh-server/);
      assert.match(locked, /\btls\b/);
    } finally {
      fs.rmSync(owPath);
    }
  });

  it('覆写里的 ss-config/vmess-config 同样剥除并告警（含 +key 操作符形式）', () => {
    const owPath = path.join(tmpDir, 'overwrite.yaml');
    fs.writeFileSync(owPath, ["ss-config: 'ss://aes-128-gcm:p@0.0.0.0:8388'", "vmess-config!: 'vmess://user:uuid@0.0.0.0:8443'"].join('\n'));
    try {
      const { config, warnings } = buildConfig(dumpYaml(BASE), 'mixed');
      assert.equal('ss-config' in config, false);
      assert.equal('vmess-config' in config, false);
      const locked = warnings.find(w => w.includes('系统锁定项已忽略'));
      assert.ok(locked, `覆写锁定键应告警，实际: ${JSON.stringify(warnings)}`);
      assert.match(locked, /ss-config/);
      assert.match(locked, /vmess-config/);
    } finally {
      fs.rmSync(owPath);
    }
  });

  it('未命中当前订阅作用域的覆写文件不产生锁定告警', () => {
    const owPath = path.join(tmpDir, 'overwrite.other.yaml');
    fs.writeFileSync(owPath, ['match:', '  subscription: other-sub', 'redir-port: 7893'].join('\n'));
    try {
      const { warnings } = buildConfig(dumpYaml(BASE), 'mixed', { subName: 'demo', subUrl: 'https://example.com/x' });
      assert.deepEqual(warnings, []);
    } finally {
      fs.rmSync(owPath);
    }
  });

  it('不设置任何锁定项时无锁定告警（普通订阅不被噪音打扰）', () => {
    const { warnings } = buildConfig(dumpYaml(BASE), 'mixed');
    assert.deepEqual(warnings, []);
  });

  it('controller_secret 非字符串时报错，不把数字/布尔送进内核或展示出口', () => {
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ controller_secret: 123456 }));
    try {
      assert.throws(
        () => buildConfig(dumpYaml(BASE), 'mixed'),
        e => e instanceof CliError && /controller_secret 需为字符串/.test(e.message),
      );
    } finally {
      fs.rmSync(path.join(tmpDir, 'settings.json'));
    }
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
      '  若订阅或覆写本身没有明显错误，也可能是内核版本过旧、不认识新配置键，可尝试: mihomo kernel',
    ]);
  });

  // 空清单的三种来源（无覆写文件、ow off、没命中 match）都不该出现这段：
  // 问题必在订阅本身，多打一段只会把排查方向引偏
  it('覆写清单为空时完全不含该段', () => {
    assert.deepEqual(buildKernelRejectHint('boom', []), [
      '',
      '  boom',
      '',
      '  请修正订阅或覆写；当前运行时配置未改动。',
      '  若订阅或覆写本身没有明显错误，也可能是内核版本过旧、不认识新配置键，可尝试: mihomo kernel',
    ]);
  });

  it('内核多行输出逐行缩进，空行仍是空行（不缩出尾随空格）', () => {
    const hint = buildKernelRejectHint('line1\n\nline2', []);
    assert.deepEqual(hint, [
      '',
      '  line1',
      '',
      '  line2',
      '',
      '  请修正订阅或覆写；当前运行时配置未改动。',
      '  若订阅或覆写本身没有明显错误，也可能是内核版本过旧、不认识新配置键，可尝试: mihomo kernel',
    ]);
  });

  it('覆写摘要经终端消毒，ESC 序列不进输出', () => {
    const hint = buildKernelRejectHint('boom', ['\x1b[31moverwrite.red.yaml\x1b[0m (全局)']);
    assert.ok(!hint.join('\n').includes('\x1b'), 'hint 不应残留 ESC 字符');
    assert.ok(hint.includes('    overwrite.red.yaml (全局)'));
  });

  it('超时分支：不附覆写清单，尾行指向内核/系统异常而非「修正订阅或覆写」', () => {
    const hint = buildKernelRejectHint('内核输出不该出现', ['overwrite.x.yaml (全局)'], { timedOut: true });
    assert.deepEqual(hint, ['', '  内核在 30s 内未给出校验结论，可能是内核或系统异常（与配置内容无关）；当前运行时配置未改动。']);
    assert.ok(!hint.join('\n').includes('overwrite.x.yaml'), '超时与配置无关，不列覆写文件');
    assert.ok(!hint.join('\n').includes('内核输出不该出现'), '超时不展示内核输出');
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

  it('name 通配命中时进入清单，摘要回显用户写的原键名', () => {
    // 用 debug 而非 warning 作探针：BASE_CONFIG 的默认 log-level 就是 warning，
    // 拿它断言「未生效」永远为真、测不出东西
    fs.writeFileSync(path.join(tmpDir, OW_SCOPED), 'match:\n  name: edu*\nlog-level: debug\n');
    try {
      const hit = buildConfig(SUB, 'mixed', { subName: 'edu2', subUrl: 'https://update.glados-config.com/x' });
      assert.deepEqual(hit.overwriteSummaries, [`${OW_SCOPED} (name=edu*)`]);
      assert.equal(hit.config['log-level'], 'debug');

      const miss = buildConfig(SUB, 'mixed', { subName: 'mini1', subUrl: 'https://update.glados-config.com/x' });
      assert.deepEqual(miss.overwriteSummaries, []);
      assert.equal(miss.config['log-level'], 'warning', '未命中时应回落到系统默认');
    } finally {
      fs.rmSync(path.join(tmpDir, OW_SCOPED));
    }
  });

  it('enabled: false 的文件不合并、不进清单、不产生告警', () => {
    // 三者都消费同一份筛选结果，故一并验证：停用的文件里即便写了锁定键与 ~?key 补丁，
    // 也不该冒出「系统锁定项已忽略」或「未匹配到同名元素」的告警
    fs.writeFileSync(path.join(tmpDir, OW_MAIN), 'log-level: info\n');
    fs.writeFileSync(
      path.join(tmpDir, OW_SCOPED),
      'enabled: false\nsecret: leaked\nlog-level: debug\n~?proxy-groups:\n  - {name: NoSuchGroup, default-selected: X}\n',
    );
    try {
      const r = buildConfig(SUB, 'mixed', { subName: 'edu1', subUrl: 'https://update.glados-config.com/x' });
      assert.deepEqual(r.overwriteSummaries, [`${OW_MAIN} (全局)`]);
      assert.equal(r.config['log-level'], 'info', '停用文件的 log-level 不应生效');
      assert.deepEqual(r.warnings, []);
      // 元数据键不得落进最终配置
      assert.ok(!('enabled' in r.config), 'enabled 不得出现在运行配置中');
    } finally {
      fs.rmSync(path.join(tmpDir, OW_MAIN));
      fs.rmSync(path.join(tmpDir, OW_SCOPED));
    }
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

  // 操作符只在覆写顶层生效：嵌套层的键按字面处理，形似操作符的形态进 warnings 提示
  it('嵌套层形似操作符的键按字面保留并进 warnings（含文件名与键名）', () => {
    fs.writeFileSync(path.join(tmpDir, OW_SCOPED), "dns:\n  nameserver-policy:\n    '~x': 'https://q.example.com/dns-query'\n");
    try {
      const subWithDns = dumpYaml({
        // 订阅自带 nameserver-policy 映射，覆写的同名段才会走逐键合并（递归）路径，
        // 嵌套键被实际遍历；订阅没有该段时整棵移植，键天然字面、不产生告警
        dns: { enable: true, 'nameserver-policy': { 'geosite:cn': 'https://doh.pub/dns-query' } },
        'proxy-groups': [{ name: 'PROXY', type: 'select', proxies: ['DIRECT'] }],
        rules: ['MATCH,PROXY'],
      });
      const { config, warnings } = buildConfig(subWithDns, 'mixed');
      assert.deepEqual((config.dns as Record<string, unknown>)['nameserver-policy'], {
        'geosite:cn': 'https://doh.pub/dns-query',
        '~x': 'https://q.example.com/dns-query',
      });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /~x/);
      assert.match(warnings[0], /字面/);
      assert.match(warnings[0], /顶层/);
      assert.match(warnings[0], new RegExp(OW_SCOPED.replace('.', '\\.')));
    } finally {
      fs.rmSync(path.join(tmpDir, OW_SCOPED));
    }
  });
});
