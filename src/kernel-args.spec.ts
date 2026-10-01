import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AVAILABLE_MIRRORS, MIRROR_ALIASES, MIRROR_BARE, MIRROR_HOST } from './constants.js';
import { CliError } from './errors.js';
import { parseMirrorArg, parseProxyArg } from './kernel-args.js';

describe('parseMirrorArg', () => {
  it('显式报错，不静默按直连继续', () => {
    // 静默忽略会让用户以为 API 仍走镜像 —— 「不报错但行为不对」的失效方式
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror-all']),
      (e: unknown) => e instanceof CliError && /未知的选项/.test((e as CliError).message),
    );
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror-all=hk.gh-proxy.org']),
      (e: unknown) => e instanceof CliError,
    );
  });

  it('--mirror 仍正常工作（仅作用于产物下载），不持久化偏好', () => {
    // 裸 --mirror 固定走裸域；返回的主机名必须在展示清单内
    const bare = parseMirrorArg(['kernel', '--mirror']).mirror;
    assert.equal(bare, MIRROR_BARE);
    assert.ok(AVAILABLE_MIRRORS.includes(new URL(bare).hostname));
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'gh.example.com']).mirror, 'https://gh.example.com/');
    assert.equal(parseMirrorArg(['kernel', '--mirror=gh.example.com']).mirror, 'https://gh.example.com/');
  });

  it('--mirror 短别名展开为完整镜像地址', () => {
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'cdn']).mirror, 'https://cdn.gh-proxy.org/');
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'v4']).mirror, 'https://v4.gh-proxy.org/');
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'v6']).mirror, 'https://v6.gh-proxy.org/');
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'axisnow']).mirror, 'https://axisnow.gh-proxy.org/');
  });

  it('--mirror direct 强制直连（isOverride 但 mirror 为 null）', () => {
    assert.deepEqual(parseMirrorArg(['kernel', '--mirror', 'direct']), { mirror: null, isOverride: true });
  });

  it('重复的 --mirror 报错，hint 直接给出可用镜像而非指向不存在的命令级 --help', () => {
    // 提示里若写「见 mihomo-cli kernel --help」，用户照做会撞上 assertKnownFlags 的
    // 「未知的选项: --help」——`--help` 只是顶层 help 的别名，命令级并不接受它。
    // 把人指向一个必定报错的命令比不给提示更糟，故断言镜像清单真的列了出来
    for (const args of [
      ['kernel', '--mirror', 'cdn', '--mirror', 'v4'],
      ['kernel', '--mirror=cdn', '--mirror=v4'],
    ]) {
      assert.throws(
        () => parseMirrorArg(args),
        (e: unknown) => {
          if (!(e instanceof CliError)) return false;
          assert.match(e.message, /只能指定一次/);
          const hint = e.hint.join('\n');
          assert.ok(!hint.includes('--help'), `hint 不得指向命令级 --help: ${hint}`);
          for (const host of AVAILABLE_MIRRORS) assert.ok(hint.includes(host), `hint 应列出镜像 ${host}`);
          return true;
        },
      );
    }
  });

  it('未支持的选项走通用错误', () => {
    assert.throws(
      () => parseMirrorArg(['kernel', '--no-mirror']),
      (e: unknown) => e instanceof CliError,
    );
    assert.throws(
      () => parseMirrorArg(['kernel', '--direct']),
      (e: unknown) => e instanceof CliError,
    );
  });

  it('无镜像选项时不覆盖', () => {
    assert.deepEqual(parseMirrorArg(['kernel']), { mirror: null, isOverride: false });
  });

  it('空值报错（与 --proxy= 同姿态），不静默落到裸域', () => {
    // `--mirror=` 与 `--mirror ""`（脚本拼接参数产生空值的两种形态）必须显式报错，
    // 不静默按裸域处理（与 --proxy= 姿态一致）。裸 `--mirror`（无值）是文档化的
    // 「强制走镜像、域用默认裸域」，不在此列
    for (const args of [
      ['kernel', '--mirror='],
      ['kernel', '--mirror', ''],
    ]) {
      assert.throws(
        () => parseMirrorArg(args),
        (e: unknown) => e instanceof CliError && /不能为空/.test(e.message),
        args.join(' '),
      );
    }
    assert.deepEqual(parseMirrorArg(['kernel', '--mirror']), { mirror: 'https://gh-proxy.org/', isOverride: true }, '裸 --mirror 保持裸域语义');
  });

  it('拼错的短别名（无点无冒号）报错并给 did-you-mean，不再被当裸主机名 punycode 化', () => {
    // 放行会被当自定义 host 补 https，展示成一串认不出的主机名且下载注定失败
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror', 'cdnn']),
      (e: unknown) => {
        if (!(e instanceof CliError)) return false;
        assert.match(e.message, /未知的镜像别名/);
        assert.ok(e.hint.join('\n').includes('cdn'), '应给出 did-you-mean 建议');
        return true;
      },
    );
    // 纯数字是把 --mirror 当 --proxy 用的常见形态，hint 应指向 --proxy
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror', '7897']),
      (e: unknown) => {
        if (!(e instanceof CliError)) return false;
        assert.ok(e.hint.join('\n').includes('--proxy'), '纯数字别名应提示改用 --proxy');
        return true;
      },
    );
  });

  it('含点或冒号的值仍走自定义主机名/URL 通路（承诺行为不回归）', () => {
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'hk.gh-proxy.org']).mirror, 'https://hk.gh-proxy.org/');
    // normalizeMirrorUrl 统一补尾斜杠（前缀拼接的既有口径）
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'https://gh.example.com/x']).mirror, 'https://gh.example.com/x/');
  });
});

describe('parseProxyArg', () => {
  it('纯数字端口补 127.0.0.1', () => {
    assert.deepEqual(parseProxyArg(['kernel', '--proxy', '7897']), { proxy: 'http://127.0.0.1:7897' });
  });

  it('host:port 补 http 前缀；完整 scheme 原样保留', () => {
    assert.equal(parseProxyArg(['kernel', '--proxy', '127.0.0.1:7897']).proxy, 'http://127.0.0.1:7897');
    assert.equal(parseProxyArg(['kernel', '--proxy', '192.168.1.2:7897']).proxy, 'http://192.168.1.2:7897');
    assert.equal(parseProxyArg(['kernel', '--proxy', 'socks5://127.0.0.1:7897']).proxy, 'socks5://127.0.0.1:7897');
    assert.equal(parseProxyArg(['kernel', '--proxy=http://127.0.0.1:7897']).proxy, 'http://127.0.0.1:7897');
  });

  it('带认证的代理保留 userinfo（URL.host 会静默剥掉凭据，重组用原始 authority）', () => {
    assert.equal(parseProxyArg(['kernel', '--proxy', 'http://user:pass@proxy.corp.example.com:8080']).proxy, 'http://user:pass@proxy.corp.example.com:8080');
  });

  it('显式写出的协议默认端口不误报缺端口（WHATWG URL 会剥 :80/:443）', () => {
    assert.equal(parseProxyArg(['kernel', '--proxy', 'http://gw.example.com:80']).proxy, 'http://gw.example.com:80');
    assert.equal(parseProxyArg(['kernel', '--proxy', 'https://gw.example.com:443']).proxy, 'https://gw.example.com:443');
  });

  it('-p 短形式与 attached/等号形式同口径（登记表 matchValueFlagToken 统一判定）', () => {
    assert.equal(parseProxyArg(['kernel', '-p', '7897']).proxy, 'http://127.0.0.1:7897');
    assert.equal(parseProxyArg(['kernel', '-p7897']).proxy, 'http://127.0.0.1:7897');
  });

  it('与 --mirror 可共存（组合语义在 resolveDownloadChannels，解析层互不干扰）', () => {
    const p = parseProxyArg(['kernel', '--mirror', 'cdn', '--proxy', '7897']);
    assert.equal(p.proxy, 'http://127.0.0.1:7897');
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'cdn', '--proxy', '7897']).mirror, 'https://cdn.gh-proxy.org/');
  });

  it('未指定返回 null；裸 --proxy、缺值、下一个 token 是选项都报错', () => {
    assert.deepEqual(parseProxyArg(['kernel']), { proxy: null });
    assert.deepEqual(parseProxyArg(['kernel', '--mirror', 'cdn']), { proxy: null });
    for (const args of [
      ['kernel', '--proxy'],
      ['kernel', '--proxy', '-s'],
      ['kernel', '--proxy='],
      ['kernel', '-p'],
    ]) {
      // `--proxy -s` 会被白名单先拦（-s 不是 kernel 的选项），同样是显式报错——
      // 用例锁的是「不静默成功」，不锁具体哪一层先报
      assert.throws(
        () => parseProxyArg(args),
        (e: unknown) => e instanceof CliError,
        `应报错: ${args.join(' ')}`,
      );
    }
  });

  it('重复指定报错（与 --mirror 同判，不静默取第一个）', () => {
    assert.throws(
      () => parseProxyArg(['kernel', '--proxy', '7897', '--proxy', '7898']),
      (e: unknown) => e instanceof CliError && /只能指定一次/.test(e.message),
    );
  });

  it('非法值显式报错：端口越界、协议不支持、缺端口', () => {
    for (const [value, pattern] of [
      ['0', /代理端口无效|需要 >= 1/],
      ['70000', /代理端口无效/],
      ['ftp://127.0.0.1:7897', /代理协议不支持/],
      ['127.0.0.1', /代理地址需要端口/],
      // URL 对怪异 host 宽容（'!!' 能解析、只是无端口），两种报错都算显式拦截
      ['!!', /代理地址/],
    ] as const) {
      assert.throws(
        () => parseProxyArg(['kernel', '--proxy', value]),
        (e: unknown) => e instanceof CliError && pattern.test(e.message),
        `应报错: --proxy ${value}`,
      );
    }
  });
});

describe('镜像清单的派生关系（单一真相源）', () => {
  it('每个短别名都能在展示清单里找到对应主机名', () => {
    for (const [alias, url] of Object.entries(MIRROR_ALIASES)) {
      assert.ok(AVAILABLE_MIRRORS.includes(new URL(url).hostname), `别名 ${alias} → ${url} 的主机名不在展示清单内（清单与别名表漂移）`);
    }
  });

  it('展示清单含裸域，且全部指向同一个镜像主机', () => {
    assert.ok(AVAILABLE_MIRRORS.includes(MIRROR_HOST), '裸域必须在展示清单内');
    for (const host of AVAILABLE_MIRRORS) {
      assert.ok(host === MIRROR_HOST || host.endsWith(`.${MIRROR_HOST}`), `${host} 不是 ${MIRROR_HOST} 的裸域或子域`);
    }
  });

  it('别名解析出的地址一律 https（镜像中转的内核随后以 root 运行）', () => {
    for (const [alias, url] of Object.entries(MIRROR_ALIASES)) {
      assert.equal(new URL(url).protocol, 'https:', `别名 ${alias} 必须是 https`);
      assert.ok(url.endsWith('/'), `别名 ${alias} 的地址需以 / 结尾（供 withMirror 直接拼前缀）`);
    }
    assert.equal(new URL(MIRROR_BARE).protocol, 'https:');
  });
});
