import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseYamlOrJson } from './config.js';
import { CliError } from './errors.js';
import { buildSshArgs, renderTunnelOverwrite, validateTunnelHost, validateTunnelName } from './tunnel.js';

const isCliError = (e: unknown): boolean => e instanceof CliError;

describe('buildSshArgs', () => {
  const args = buildSshArgs({ host: 'm4', port: 1080 });

  // 六个选项各自防一种失败模式，缺任何一个都会退化成「看着还活着但不通」的状态，
  // 见 docs/tunnel-requirement.md 的「硬约束 1」
  for (const opt of ['ExitOnForwardFailure=yes', 'BatchMode=yes', 'ServerAliveInterval=30', 'ServerAliveCountMax=3', 'ConnectTimeout=15']) {
    it(`包含 -o ${opt}`, () => {
      const idx = args.indexOf(opt);
      assert.ok(idx > 0, `缺少 ${opt}: ${args.join(' ')}`);
      assert.equal(args[idx - 1], '-o', `${opt} 前应是 -o`);
    });
  }

  it('包含 -N（不执行远程命令）', () => {
    assert.ok(args.includes('-N'));
  });

  it('-D 恒绑 127.0.0.1，绝不绑 0.0.0.0（安全红线）', () => {
    const idx = args.indexOf('-D');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], '127.0.0.1:1080');
    assert.ok(!args.some(a => a.includes('0.0.0.0')), `不得出现 0.0.0.0: ${args.join(' ')}`);
  });

  it('主机名在最后一位', () => {
    assert.equal(args[args.length - 1], 'm4');
  });

  it('-D 偏移足够小，不会撞上 BSD ps 的 79 列截断', () => {
    // isProcessCommandMatching 用 `-D 127.0.0.1:<port>` 作 needle；该片段若偏移过大，
    // ps 截断会让匹配恒 false → 进程探测失效（历史上测速实例踩过这个坑）
    const needleOffset = `ssh ${args.join(' ')}`.indexOf('-D 127.0.0.1:1080');
    assert.ok(needleOffset < 79, `needle 偏移 ${needleOffset} 过大`);
  });
});

describe('validateTunnelHost', () => {
  it('拒绝以 - 开头的主机名（ssh 会当选项解析 → 任意命令执行）', () => {
    assert.throws(() => validateTunnelHost('-oProxyCommand=touch /tmp/pwned'), isCliError);
  });

  it('拒绝单独的 -o', () => {
    assert.throws(() => validateTunnelHost('-o'), isCliError);
  });

  for (const bad of ['a b', 'a;rm -rf /', 'a$(id)', 'a`id`', 'a|b', 'a&b', '', 'a>b']) {
    it(`拒绝非法主机名 ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validateTunnelHost(bad), isCliError);
    });
  }

  for (const good of ['m4', 'user@host', 'host.example.com', 'my-host_1', 'user@10.0.0.1']) {
    it(`接受合法主机名 ${good}`, () => {
      assert.doesNotThrow(() => validateTunnelHost(good));
    });
  }
});

describe('validateTunnelName', () => {
  // 名字会被拼进 overwrite.tunnel-<name>.yaml 与 tunnel/<name>.json 两处路径
  for (const bad of ['../evil', 'a/b', 'a.b', '', 'a b', 'a'.repeat(65)]) {
    it(`拒绝非法名称 ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validateTunnelName(bad), isCliError);
    });
  }

  for (const good of ['work', 'work-1', 'work_1', '公司']) {
    it(`接受合法名称 ${good}`, () => {
      assert.doesNotThrow(() => validateTunnelName(good));
    });
  }
});

describe('renderTunnelOverwrite', () => {
  const yaml = renderTunnelOverwrite({ name: 'work', host: 'm4', port: 1080, auto: true });
  const parsed = parseYamlOrJson(yaml, '模板') as Record<string, unknown>;

  it('产物是合法 YAML 且顶层为对象', () => {
    assert.ok(parsed && typeof parsed === 'object');
  });

  it('用 ~ 语义（按 name 就地合并），而非依赖文件加载顺序的 +proxies', () => {
    // ~ 是唯一顺序无关的机制：按 name 定位，不受字母序影响。
    // 用 + 的话，用户再加个 overwrite.zzz.yaml 就会把隧道节点压过去
    assert.ok('~proxies' in parsed, `应有 ~proxies: ${Object.keys(parsed).join(', ')}`);
    assert.ok('~proxy-groups' in parsed);
    assert.ok(!('+proxies' in parsed));
  });

  it('注入的 socks5 节点指向 127.0.0.1 与配置端口', () => {
    const proxies = parsed['~proxies'] as Array<Record<string, unknown>>;
    assert.equal(proxies.length, 1);
    assert.equal(proxies[0].type, 'socks5');
    assert.equal(proxies[0].server, '127.0.0.1');
    assert.equal(proxies[0].port, 1080);
    assert.equal(proxies[0].name, 'Tunnel-work-Host');
  });

  it('分组引用该节点并带 DIRECT 兜底', () => {
    const groups = parsed['~proxy-groups'] as Array<Record<string, unknown>>;
    assert.equal(groups[0].name, 'Tunnel-work');
    assert.deepEqual(groups[0].proxies, ['Tunnel-work-Host', 'DIRECT']);
  });

  it('规则段默认注释掉（CLI 无从知道用户的内网域名）', () => {
    assert.ok(!('rules' in parsed) && !('+rules' in parsed));
    assert.ok(yaml.includes('# +rules:'), '应保留注释形式的 rules 引导');
  });

  it('不含 match 块（模板应全局生效，不 fail-closed 地限定作用域）', () => {
    assert.ok(!('match' in parsed));
  });
});
