import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertKnownFlags, assertPositionalCount, parseIntArg } from './argv.js';
import { CliError } from './errors.js';
import { VALUE_FLAGS } from './flags.js';

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

  it('可选值选项裸写后跟 flag 时不吞 flag（--mirror --proxy 组合的 exact 形式不再误报）', () => {
    // kernel 的 KERNEL_VALUE_FLAGS = VALUE_FLAGS + --mirror。四种等价组合写法里
    // `--mirror --proxy 7897` / `--mirror -p 7897` 此前被「--mirror 必带值」的跳值
    // 逻辑吞掉 --proxy 本身、把 7897 误判为多余位置参数；等号/紧贴形式却通过
    const kernelValueFlags = new Set([...VALUE_FLAGS, '--mirror']);
    assert.doesNotThrow(() => assertPositionalCount(['kernel', '--mirror', '--proxy', '7897'], 0, 1, 'mihomo kernel', kernelValueFlags));
    assert.doesNotThrow(() => assertPositionalCount(['kernel', '--mirror', '-p', '7897'], 0, 1, 'mihomo kernel', kernelValueFlags));
    // 有值时照常跳（既有行为不回归）
    assert.doesNotThrow(() => assertPositionalCount(['kernel', '--mirror', 'cdn', '--proxy', '7897'], 0, 1, 'mihomo kernel', kernelValueFlags));
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
