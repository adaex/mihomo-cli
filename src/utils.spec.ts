import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AVAILABLE_MIRRORS, MIRROR_ALIASES, MIRROR_BARE, MIRROR_HOST } from './constants.js';
import { CliError } from './errors.js';
import { VALUE_FLAGS } from './flags.js';
import {
  assertKnownFlags,
  assertPositionalCount,
  displayWidth,
  formatRelativeTime,
  padEndDisplay,
  parseIntArg,
  parseMirrorArg,
  proxyEnvPointsAtSelf,
  subscriptionUrgency,
  suggestSimilar,
} from './utils.js';

const TOKENS = ['start', 'stop', 'status', 'subscription', 'sub', 'kernel', 'ui'];

describe('suggestSimilar', () => {
  it('前缀匹配命中（含别名），按相似度排序', () => {
    assert.deepEqual(suggestSimilar('su', TOKENS), ['sub', 'subscription']);
  });

  it('编辑距离 <= 2 命中拼错的命令', () => {
    assert.ok(suggestSimilar('strt', TOKENS).includes('start'));
    assert.ok(suggestSimilar('stats', TOKENS).includes('status'));
  });

  it('大小写不敏感', () => {
    assert.ok(suggestSimilar('START', TOKENS).includes('start'));
  });

  it('完全一致不返回（调用方仅在未命中时使用）', () => {
    assert.ok(!suggestSimilar('start', TOKENS).includes('start'));
  });

  it('无相近词返回空数组', () => {
    assert.deepEqual(suggestSimilar('zzzzzzzz', TOKENS), []);
  });

  it('至多返回 3 个候选', () => {
    const many = ['abc', 'abd', 'abe', 'abf', 'abg'];
    assert.ok(suggestSimilar('abx', many).length <= 3);
  });
});

describe('parseIntArg 范围与格式校验', () => {
  // attached / 等号形式的判定走 FLAGS 登记表（matchValueFlagToken），
  // fixture 必须用已登记的选项；未登记选项的非 exact 形式由白名单统一报错
  const T = (args: string[]) => parseIntArg(args, '-n', '--lines', 2000);

  it('合法正整数（空格形式）', () => {
    assert.equal(T(['x', '-n', '3000']), 3000);
  });

  it('合法正整数（= 形式）', () => {
    assert.equal(T(['x', '--lines=3000']), 3000);
  });

  it('合法正整数（attached 短选项）', () => {
    assert.equal(T(['x', '-n3000']), 3000);
  });

  it('缺省返回默认值', () => {
    assert.equal(T(['x']), 2000);
  });

  it('无关 flag 不受影响', () => {
    assert.equal(T(['x', '-o', '-s']), 2000);
  });

  // 以下此前会静默取到危险值：'5s' 被 parseInt 静默取成 5（ms）
  for (const bad of ['0', '-1', '5s', 'abc', '', '1.5', ' ']) {
    it(`拒绝非法值 ${JSON.stringify(bad)}`, () => {
      assert.throws(
        () => T(['x', '-n', bad]),
        (e: unknown) => e instanceof CliError,
      );
    });
  }

  // attached 短选项后缀非纯数字：与空格形式同一报错路径，不再静默返回默认值
  for (const bad of ['-n5s', '-n=3000', '-nfoo']) {
    it(`attached 形式 ${JSON.stringify(bad)} 报错而非静默取默认`, () => {
      assert.throws(
        () => T(['x', bad]),
        (e: unknown) => e instanceof CliError && /需要正整数/.test((e as CliError).message),
      );
    });
  }

  it('缺少值时报错', () => {
    assert.throws(
      () => T(['x', '-n']),
      (e: unknown) => e instanceof CliError,
    );
  });
});

describe('parseIntArg：-u 更新超时（attached 形式回归）', () => {
  // 此前 `-u5s` 白名单放行但这里静默回退默认值，`mihomo start -u5s`
  // 一路走到后面才以「未找到内核」收场；统一为与空格形式同一条报错路径
  it('-u30000 解析为 30000', () => {
    assert.equal(parseIntArg(['start', '-u30000'], '-u', '--update-timeout', 10000), 30000);
  });

  it('-u5s 抛错而非静默回退默认值', () => {
    assert.throws(
      () => parseIntArg(['start', '-u5s'], '-u', '--update-timeout', 10000),
      (e: unknown) => e instanceof CliError && /需要正整数/.test((e as CliError).message),
    );
  });

  it('-u=3000 明确报错：短选项等号形式不是合法写法，后缀 "=3000" 非纯整数', () => {
    assert.throws(
      () => parseIntArg(['start', '-u=3000'], '-u', '--update-timeout', 10000),
      (e: unknown) => e instanceof CliError && /需要正整数/.test((e as CliError).message),
    );
  });
});

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
    // 提示里若写「见 mihomo kernel --help」，用户照做会撞上 assertKnownFlags 的
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

describe('formatRelativeTime', () => {
  const now = Date.now();
  it('刚刚 / 分钟 / 小时 / 天', () => {
    assert.equal(formatRelativeTime(new Date(now - 5_000), now), '刚刚');
    assert.equal(formatRelativeTime(new Date(now - 3 * 60_000), now), '3 分钟前');
    assert.equal(formatRelativeTime(new Date(now - 5 * 3_600_000), now), '5 小时前');
    assert.equal(formatRelativeTime(new Date(now - 3 * 86_400_000), now), '3 天前');
  });

  it('ISO 字符串与 Date 都接受', () => {
    assert.equal(formatRelativeTime(new Date(now - 60_000).toISOString(), now), '1 分钟前');
  });

  it('未来时间（时钟偏移）与非法值返回 null，由调用方回退绝对时间', () => {
    assert.equal(formatRelativeTime(new Date(now + 60_000), now), null);
    assert.equal(formatRelativeTime(undefined, now), null);
    assert.equal(formatRelativeTime('not-a-date', now), null);
  });
});

describe('subscriptionUrgency', () => {
  const now = Date.now();
  it('已过期优先判定', () => {
    assert.equal(subscriptionUrgency({ expire: Math.floor(now / 1000) - 100, total: 100, upload: 50, download: 50 }, now), 'expired');
  });

  it('流量用尽', () => {
    assert.equal(subscriptionUrgency({ total: 100, upload: 60, download: 40 }, now), 'traffic-exhausted');
  });

  it('7 天内到期', () => {
    assert.equal(subscriptionUrgency({ expire: Math.floor(now / 1000) + 3 * 86_400 }, now), 'expiring');
  });

  it('永久（expire=0）与不限量不误报', () => {
    assert.equal(subscriptionUrgency({ expire: 0 }, now), null);
    assert.equal(subscriptionUrgency({}, now), null);
    assert.equal(subscriptionUrgency({ expire: Math.floor(now / 1000) + 365 * 86_400 }, now), null);
  });
});

describe('选项白名单只接受当前支持的写法', () => {
  it('无选项命令拒绝任意未知选项', () => {
    assert.throws(() => assertKnownFlags(['stop', '--no-ssh'], [], 'stop'), CliError);
  });
  it('布尔选项不能带值或附加尾缀', () => {
    for (const arg of ['--full=false', '-yes', '-y1']) {
      assert.throws(() => assertKnownFlags([arg], ['--full', '-y'], 'reset'), CliError);
    }
  });
  it('带值选项接受等号与短选项紧贴值', () => {
    assert.doesNotThrow(() => assertKnownFlags(['--lines=20', '-n20'], ['-n', '--lines'], 'logs'));
  });
  it('未知选项的 attached / 等号形式同样拒绝', () => {
    for (const arg of ['-z5', '-z=5', '--unknown=1']) {
      assert.throws(() => assertKnownFlags([arg], ['-n', '--lines'], 'logs'), CliError);
    }
  });
  it('带值选项的非 exact 形式按命令白名单隔离：logs 认 -n200 但不认 -u30000', () => {
    assert.doesNotThrow(() => assertKnownFlags(['-n200'], ['-n', '--lines'], 'logs'));
    assert.throws(() => assertKnownFlags(['-u30000'], ['-n', '--lines'], 'logs'), CliError);
  });
});

/**
 * 位置参数个数校验：与 assertKnownFlags 配对（flag 严格、位置参数此前只认第一个）。
 * 重点锁两件事：超上限抛「参数错误」并指明多余者；带值选项的值不算位置参数——
 * `sub use name -u 5000`、`logs 3 -f` 这类合法形态绝不能被误伤。
 */
describe('assertPositionalCount：多余位置参数报错、合法形态不误伤', () => {
  it('超出上限抛 CliError，label 为参数错误并附用法', () => {
    assert.throws(
      () => assertPositionalCount(['start', 'mixed', 'garbage'], 1, 1, 'mihomo start [tun|mixed]'),
      (e: unknown) =>
        e instanceof CliError && e.label === '参数错误' && /多余的参数: garbage/.test(e.message) && e.hint.some(l => l.includes('用法: mihomo start')),
    );
  });

  it('恰好等于上限不报错', () => {
    assert.doesNotThrow(() => assertPositionalCount(['start', 'mixed'], 1, 1, 'mihomo start'));
    assert.doesNotThrow(() => assertPositionalCount(['sub', 'add', 'https://e.test/s', 'n'], 2, 2, 'mihomo sub add'));
    assert.doesNotThrow(() => assertPositionalCount(['sub', 'add'], 2, 2, 'mihomo sub add'));
  });

  it('带值选项的值不算位置参数（flag 与值交错）', () => {
    assert.doesNotThrow(() => assertPositionalCount(['sub', 'use', 'name', '-u', '5000'], 1, 2, 'mihomo sub use'));
    assert.doesNotThrow(() => assertPositionalCount(['start', '-u', '5000', 'mixed'], 1, 1, 'mihomo start'));
    assert.doesNotThrow(() => assertPositionalCount(['sub', 'remove', '-y', 'foo'], 1, 2, 'mihomo sub remove'));
    // 布尔 flag 不吃值：-y 后面的 foo 是位置参数，计数仍为 1
    assert.throws(() => assertPositionalCount(['sub', 'remove', '-y', 'foo', 'bar'], 1, 2, 'mihomo sub remove'), CliError);
  });

  it('等号长选项与紧贴短选项不产生位置参数', () => {
    assert.doesNotThrow(() => assertPositionalCount(['logs', '--lines=200', '3'], 1, 1, 'mihomo logs'));
    assert.doesNotThrow(() => assertPositionalCount(['logs', '-n200', '-f'], 1, 1, 'mihomo logs'));
  });

  it('startIdx 之前的位置参数不计数（子命令 token 由分发负责）', () => {
    assert.doesNotThrow(() => assertPositionalCount(['sub', 'use', 'name'], 1, 2, 'mihomo sub use'));
    assert.throws(() => assertPositionalCount(['ow', 'on', 'garbage'], 0, 2, 'mihomo ow'), CliError);
  });

  it('args 缺省（可选参数的调用方）与空数组直接通过', () => {
    assert.doesNotThrow(() => assertPositionalCount(undefined, 0, 1, 'mihomo status'));
    assert.doesNotThrow(() => assertPositionalCount([], 0, 1, 'mihomo status'));
  });

  it('自定义 valueFlags：kernel 的 --mirror 值不算位置参数', () => {
    // --mirror 是可选值选项、不在 VALUE_FLAGS（见 flags.ts），kernel 需自带口径
    const kernelFlags = new Set([...VALUE_FLAGS, '--mirror']);
    assert.doesNotThrow(() => assertPositionalCount(['kernel', '--mirror', 'cdn'], 0, 1, 'mihomo kernel', kernelFlags));
    assert.doesNotThrow(() => assertPositionalCount(['kernel', '--mirror=cdn'], 0, 1, 'mihomo kernel', kernelFlags));
    assert.doesNotThrow(() => assertPositionalCount(['kernel', '--mirror'], 0, 1, 'mihomo kernel', kernelFlags));
    // 默认口径下 cdn 会被算成位置参数——这正是 kernel 必须传自定义表的原因（锁住口径差异）
    assert.throws(() => assertPositionalCount(['kernel', '--mirror', 'cdn'], 0, 1, 'mihomo kernel'), CliError);
    assert.throws(() => assertPositionalCount(['kernel', '--mirror', 'cdn', 'garbage'], 0, 1, 'mihomo kernel', kernelFlags), CliError);
    assert.throws(() => assertPositionalCount(['kernel', 'garbage'], 0, 1, 'mihomo kernel', kernelFlags), CliError);
  });
});

/**
 * 帮助文本的说明列靠 padEndDisplay 对齐。用 `.length` 的话含中文占位符的签名
 * （`logs [编号]`、`--mirror [镜像]`、`reset [目标...]`）会少缩进 2~3 格，
 * 正是这次要修的错位本身，故对宽度口径加锁。
 */
describe('displayWidth：CJK 占两列', () => {
  it('纯 ASCII 等于码点数', () => {
    assert.equal(displayWidth('install'), 7);
    assert.equal(displayWidth('start [tun|mixed] [-s] [-u ms]'), 30);
  });

  it('中文字符按两列计', () => {
    assert.equal(displayWidth('编号'), 4);
    assert.equal(displayWidth('logs [-f] [-n N] [编号] [-o]'), 28);
  });

  it('全角标点同样按两列计', () => {
    assert.equal(displayWidth('（默认）'), 8);
  });

  it('空串为 0', () => {
    assert.equal(displayWidth(''), 0);
  });
});

describe('padEndDisplay：按显示宽度补齐', () => {
  it('含中文的签名补到与纯 ASCII 签名相同的显示宽度', () => {
    const a = padEndDisplay('logs [-f] [-n N] [编号] [-o]', 30);
    const b = padEndDisplay('start [tun|mixed] [-s] [-u ms]', 30);
    assert.equal(displayWidth(a), displayWidth(b), '两者显示宽度应一致');
    assert.equal(displayWidth(a), 30);
  });

  it('已超出目标宽度时原样返回，不截断', () => {
    assert.equal(padEndDisplay('subscription remove <name>', 5), 'subscription remove <name>');
  });
});

describe('proxyEnvPointsAtSelf：只认指向本机 Mixed 端口的代理 env', () => {
  it('本机回环 + 自己的端口才判定为自代理', () => {
    for (const url of ['http://127.0.0.1:7890', 'http://localhost:7890', 'socks5://127.0.0.1:7890', '127.0.0.1:7890']) {
      assert.equal(proxyEnvPointsAtSelf(url, 7890), true, url);
    }
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
