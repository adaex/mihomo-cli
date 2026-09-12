import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLAGS, matchValueFlagToken, VALUE_FLAGS } from './flags.js';
import { assertKnownFlags, extractStartOptions, parseIntArg } from './utils.js';

describe('flags 单一登记表派生', () => {
  it('VALUE_FLAGS 恰好包含全部带值选项的各形式', () => {
    assert.deepEqual([...VALUE_FLAGS].sort(), ['--lines', '--update-timeout', '-n', '-u']);
  });

  it('可选值选项 --mirror 不在 VALUE_FLAGS（只走 parseMirrorArg）', () => {
    // 登记了反而会让 getNonFlagArg 把它的值吞掉
    assert.ok(!VALUE_FLAGS.has('--mirror'));
  });
});

describe('matchValueFlagToken：带值选项形式的唯一判定入口', () => {
  it('exact：整 token 命中，值在下一个 token', () => {
    const m = matchValueFlagToken('-u');
    assert.ok(m);
    assert.equal(m.form, 'exact');
    assert.equal(m.baseForm, '-u');
    assert.equal(m.inlineValue, null);
    assert.ok(m.spec.forms.includes('--update-timeout'));
  });

  it('attached-short：-u30000 携带内联值 30000', () => {
    const m = matchValueFlagToken('-u30000');
    assert.ok(m);
    assert.equal(m.form, 'attached-short');
    assert.equal(m.baseForm, '-u');
    assert.equal(m.inlineValue, '30000');
  });

  it('long-eq：--lines=200 携带内联值 200', () => {
    const m = matchValueFlagToken('--lines=200');
    assert.ok(m);
    assert.equal(m.form, 'long-eq');
    assert.equal(m.baseForm, '--lines');
    assert.equal(m.inlineValue, '200');
  });

  it('布尔选项、未登记选项与 --mirror 不匹配任何形式（非 exact 形式只对带值选项合法）', () => {
    for (const token of ['-s', '-sx', '--no-update=1', '--mirror=x', '-z5', 'foo', '-']) {
      assert.equal(matchValueFlagToken(token), null, `${token} 不应命中`);
    }
  });
});

describe('extractStartOptions：重启透传从登记表派生', () => {
  it('透传 start 的布尔选项', () => {
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '-s']), ['-s']);
    assert.deepEqual(extractStartOptions(['ow', 'on', '--no-update']), ['--no-update']);
  });

  it('透传带值选项及其值', () => {
    assert.deepEqual(extractStartOptions(['start', '-u', '30000', 'tun']), ['-u', '30000']);
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '--update-timeout', '5000']), ['--update-timeout', '5000']);
  });

  it('等号形式整体透传，不再吞掉下一个 token', () => {
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '--update-timeout=30000']), ['--update-timeout=30000']);
  });

  it('attached 短选项整体透传，不吞下一个 token 当值', () => {
    // 此前 `-u30000` 被静默丢弃：`sub use foo -u30000` 白名单放行、重启却走默认超时
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '-u30000']), ['-u30000']);
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '-u30000', 'tun']), ['-u30000']);
  });

  it('布尔 attached 形式不透传（白名单本来就会拒绝）', () => {
    assert.deepEqual(extractStartOptions(['sub', 'use', 'foo', '-sx']), []);
  });

  it('丢弃非 start 选项（含其他命令的布尔/带值选项）', () => {
    assert.deepEqual(extractStartOptions(['logs', '-n', '200', '-f']), []);
    assert.deepEqual(extractStartOptions(['sub', 'remove', 'foo', '-y']), []);
  });

  it('undefined 与空数组返回空', () => {
    assert.deepEqual(extractStartOptions(undefined), []);
    assert.deepEqual(extractStartOptions([]), []);
  });
});

describe('不变量：白名单接受的带值选项形式，下游解析器必可消费', () => {
  // 三套解析（assertKnownFlags 白名单 / parseIntArg 取值 / extractStartOptions 透传）
  // 共用 matchValueFlagToken 判定形式。遍历登记表逐形式锁死「白名单接受 ⟹ 下游可消费」：
  // 任何人改三套解析器之一而破坏一致性，这里当场转红。
  const VALUE = '4321';

  for (const spec of FLAGS) {
    if (!spec.takesValue) continue;
    const short = spec.forms.find(f => !f.startsWith('--'));
    const long = spec.forms.find(f => f.startsWith('--'));
    // 登记表调用约定：带值选项同时具备短/长形式（parseIntArg 的 (short, long) 签名）
    if (!short || !long) {
      it(`${spec.forms.join(' / ')} 缺少短或长形式`, () => {
        assert.fail('带值选项应同时登记短与长形式');
      });
      continue;
    }

    // exact（每个声明形式，值在下一个 token）、attached 短选项、等号长选项
    const cases: [label: string, argv: string[]][] = [
      ...spec.forms.map(f => [f, [f, VALUE]] as [string, string[]]),
      [`${short}${VALUE}`, [`${short}${VALUE}`]],
      [`${long}=${VALUE}`, [`${long}=${VALUE}`]],
    ];

    for (const [label, argv] of cases) {
      it(`${label}：白名单接受且 parseIntArg 解析出 ${VALUE}（不静默回退默认）`, () => {
        assert.doesNotThrow(() => assertKnownFlags(argv, spec.forms, 'invariant'));
        assert.equal(parseIntArg(argv, short, long, 1), 4321);
      });
    }

    if (spec.passthroughToRestart) {
      it(`${short}：三种形式重启透传都不丢，attached 不吞下一个 token`, () => {
        assert.deepEqual(extractStartOptions(['x', short, VALUE]), [short, VALUE]);
        assert.deepEqual(extractStartOptions(['x', `${short}${VALUE}`, 'next']), [`${short}${VALUE}`]);
        assert.deepEqual(extractStartOptions(['x', `${long}=${VALUE}`]), [`${long}=${VALUE}`]);
      });
    }
  }

  // 布尔 start 选项（-s / --no-update）：整 token 精确匹配，透传不丢
  for (const spec of FLAGS) {
    if (spec.takesValue || !spec.passthroughToRestart) continue;
    for (const form of spec.forms) {
      it(`${form}：布尔 start 选项白名单接受且透传不丢`, () => {
        assert.doesNotThrow(() => assertKnownFlags([form], spec.forms, 'invariant'));
        assert.deepEqual(extractStartOptions(['x', form]), [form]);
      });
    }
  }
});
