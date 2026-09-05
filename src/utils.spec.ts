import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CliError } from './errors.js';
import {
  assertNoRemovedSshFlag,
  displayWidth,
  formatRelativeTime,
  padEndDisplay,
  parseIntArg,
  parseMirrorArg,
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
  const T = (args: string[]) => parseIntArg(args, '-t', '--timeout', 2000);

  it('合法正整数（空格形式）', () => {
    assert.equal(T(['x', '-t', '3000']), 3000);
  });

  it('合法正整数（= 形式）', () => {
    assert.equal(T(['x', '--timeout=3000']), 3000);
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
        () => T(['x', '-t', bad]),
        (e: unknown) => e instanceof CliError,
      );
    });
  }

  it('缺少值时报错', () => {
    assert.throws(
      () => T(['x', '-t']),
      (e: unknown) => e instanceof CliError,
    );
  });
});

describe('parseMirrorArg：--mirror-all 已移除（v3.10.0）', () => {
  it('显式报错，不静默按直连继续', () => {
    // 静默忽略会让用户以为 API 仍走镜像 —— 「不报错但行为不对」的失效方式
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror-all']),
      (e: unknown) => e instanceof CliError && /已移除/.test((e as CliError).message),
    );
    assert.throws(
      () => parseMirrorArg(['kernel', '--mirror-all=hk.gh-proxy.org']),
      (e: unknown) => e instanceof CliError,
    );
  });

  it('--mirror 仍正常工作（仅作用于产物下载），并记住偏好', () => {
    assert.equal(parseMirrorArg(['kernel', '--mirror']).mirror, 'https://v6.gh-proxy.org/');
    assert.equal(parseMirrorArg(['kernel', '--mirror', 'gh.example.com']).mirror, 'https://gh.example.com/');
    assert.equal(parseMirrorArg(['kernel', '--mirror']).remember, true);
    assert.equal(parseMirrorArg(['kernel', '--mirror=gh.example.com']).remember, true);
  });

  it('--no-mirror 显式直连并清除偏好', () => {
    assert.deepEqual(parseMirrorArg(['kernel', '--no-mirror']), { mirror: null, isOverride: true, clearSaved: true });
  });

  it('无镜像选项时不覆盖', () => {
    assert.deepEqual(parseMirrorArg(['kernel']), { mirror: null, isOverride: false });
  });
});

describe('parseMirrorArg：镜像偏好（settings.kernel_mirror）', () => {
  it('无显式选项时回退已记住的偏好', () => {
    const r = parseMirrorArg(['kernel'], 'https://hk.gh-proxy.org/');
    assert.deepEqual(r, { mirror: 'https://hk.gh-proxy.org/', isOverride: false });
  });

  it('显式 --no-mirror 优先于偏好，并标记清除', () => {
    const r = parseMirrorArg(['kernel', '--no-mirror'], 'https://hk.gh-proxy.org/');
    assert.deepEqual(r, { mirror: null, isOverride: true, clearSaved: true });
  });

  it('显式 --mirror 覆盖偏好并记住新值', () => {
    const r = parseMirrorArg(['kernel', '--mirror', 'cdn.gh-proxy.org'], 'https://hk.gh-proxy.org/');
    assert.equal(r.mirror, 'https://cdn.gh-proxy.org/');
    assert.equal(r.remember, true);
  });

  it('--mirror direct 按直连处理并清除偏好', () => {
    const r = parseMirrorArg(['kernel', '--mirror', 'direct'], 'https://hk.gh-proxy.org/');
    assert.deepEqual(r, { mirror: null, isOverride: true, clearSaved: true });
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

describe('assertNoRemovedSshFlag：--no-ssh 已移除（v4.0.0）', () => {
  it('显式报错，不静默忽略', () => {
    // 静默通过会让 `stop --no-ssh`（原意「停代理但留隧道」）变成「停代理」而用户不知情
    assert.throws(
      () => assertNoRemovedSshFlag(['stop', '--no-ssh']),
      (e: unknown) => e instanceof CliError,
    );
    assert.throws(
      () => assertNoRemovedSshFlag(['start', '--no-ssh=true']),
      (e: unknown) => e instanceof CliError,
    );
  });

  it('不含该选项时放行', () => {
    assert.doesNotThrow(() => assertNoRemovedSshFlag(['start', 'tun', '-s']));
    assert.doesNotThrow(() => assertNoRemovedSshFlag(undefined));
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
