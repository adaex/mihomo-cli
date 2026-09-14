import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * `ow` 列表与 `status` 的覆写展示（CLI 级）。
 *
 * 「被停用的文件仍要列出并标注」是产品承诺：若 loadOverwriteFile 日后改成直接丢弃，
 * 单测层面 selectActiveOverwriteFiles 照样为空、测不出来，只有真跑命令看输出才拦得住。
 * 同 reset.spec：隔离 MIHOMO_CLI_DIR，并隔离 MIHOMO_CLI_DAEMON_LABEL（plist 在数据目录之外）。
 */
function withFixture(check: (dataDir: string, run: (args: string[]) => SpawnSyncReturns<string>) => void): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ow-cli-'));
  const label = `com.mihomo-cli.test.${path.basename(dataDir)}`;
  try {
    assert.ok(dataDir.startsWith(os.tmpdir()));
    assert.equal(fs.existsSync(path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
    fs.mkdirSync(path.join(dataDir, 'subscriptions'));
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        subscriptions: [{ name: 'edu1', url: 'https://update.glados-config.com/x' }],
        active_subscription: 'edu1',
      }),
    );
    fs.writeFileSync(path.join(dataDir, 'subscriptions', 'edu1.yaml'), 'proxies: []\n');
    const run = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/index.ts'), ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, MIHOMO_CLI_DIR: dataDir, MIHOMO_CLI_DAEMON_LABEL: label, NO_COLOR: '1' },
      });
    check(dataDir, run);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('ow 列表展示文件级开关', () => {
  it('停用的文件仍列出并标注已禁用，作用域照常显示', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'match:\n  name: edu*\nlog-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.b.yaml'), 'enabled: false\nlog-level: info\n');
      const out = run(['ow']).stdout;
      assert.match(out, /overwrite\.a\.yaml/);
      assert.match(out, /overwrite\.b\.yaml \[已禁用\]/);
      // 计数区分总数与未禁用数
      assert.match(out, /2 个，1 个未禁用/);
      // 回显用户写的原键名
      assert.match(out, /作用域: name=edu\*/);
    });
  });

  it('用法提示恒在：看到 [已禁用] 却不知怎么改回来是最直接的死路', () => {
    // 该行无条件打印，故断言点在「所有状态下都有」，而不是混在上面那条里
    // 当成功能性断言——那样无论功能好坏它都通过，测不出东西
    withFixture((dataDir, run) => {
      assert.match(run(['ow']).stdout, /停用单个文件: 在该文件顶部写 enabled: false/, '空列表时也应给出用法');
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'enabled: false\nlog-level: debug\n');
      assert.match(run(['ow']).stdout, /停用单个文件: 在该文件顶部写 enabled: false/, '有停用文件时更要给出用法');
    });
  });

  it('无停用文件时计数不加后缀（常态无噪音）', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      const out = run(['ow']).stdout;
      assert.match(out, /1 个，按顺序加载/);
      assert.ok(!out.includes('未禁用'), '没有停用文件时不该出现该计数');
      assert.ok(!out.includes('[已禁用]'));
    });
  });

  it('全局开关与文件级开关是两层，可同时区分', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'enabled: false\nlog-level: debug\n');
      run(['ow', 'off']);
      const out = run(['ow']).stdout;
      assert.match(out, /状态: 已禁用/); // 全局
      assert.match(out, /overwrite\.a\.yaml \[已禁用\]/); // 文件级
    });
  });

  it('enabled 写错时 ow 列表不崩溃，红字标出加载失败与原因', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.bad.yaml'), 'enabled: nope\nlog-level: debug\n');
      // 诊断面（ow/status）永远可渲染：最需要排查工具时工具不能先坏。
      // 合并路径的硬失败由 overwrite.spec 的 loadOverwriteFile 用例锁住
      const r = run(['ow']);
      assert.equal(r.status, 0, 'ow 列表不应被坏文件击穿');
      assert.match(r.stdout, /overwrite\.bad\.yaml \[加载失败\]/);
      assert.match(r.stdout, /enabled 必须是布尔值/);
    });
  });

  it('坏覆写文件在 status 人读与 JSON 两形态都可见，且不混进 files/applied', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.good.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.bad.yaml'), 'enabled: nope\nlog-level: debug\n');
      assert.match(run(['status', '--no-probe']).stdout, /overwrite\.bad\.yaml.*解析|enabled 必须是布尔值/);

      const json = JSON.parse(run(['status', '--json', '--no-probe']).stdout);
      assert.deepEqual(json.overwrite.files, ['overwrite.good.yaml']);
      assert.deepEqual(json.overwrite.applied, ['overwrite.good.yaml']);
      assert.equal(json.overwrite.errors.length, 1);
      assert.equal(json.overwrite.errors[0].name, 'overwrite.bad.yaml');
      assert.match(json.overwrite.errors[0].message, /enabled 必须是布尔值/);
    });
  });

  it('status --json 的 overwrite.files 只含未停用的文件', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.b.yaml'), 'enabled: false\nlog-level: info\n');
      const json = JSON.parse(run(['status', '--json', '--no-probe']).stdout);
      assert.deepEqual(json.overwrite.files, ['overwrite.a.yaml']);
      assert.equal(json.overwrite.enabled, true, 'enabled 仍是全局开关，不受文件级影响');
    });
  });

  it('status 人读形态标出被停用的数量', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.b.yaml'), 'enabled: false\nlog-level: info\n');
      assert.match(run(['status', '--no-probe']).stdout, /覆写:.*已启用 \(a，1 个已禁用\)/);
    });
  });

  it('全部文件都被停用时不显示成「无文件」', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'enabled: false\nlog-level: debug\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /无生效文件，1 个已禁用/);
    });
  });
});

/**
 * status 的覆写行按 match 分列（fixture 的活跃订阅是 edu1）。
 *
 * status 与 `ow` 列表的关键区别：它知道当前活跃订阅是谁，因而判得了 match。不判的话，
 * 只对别的订阅生效的文件会混在「已启用」主行里，和真正生效的文件长得一模一样——用户
 * 会拿它解释自己看到的行为，排查方向整个跑偏。断言都走真跑命令：listOverwriteFile
 * 的 scope 参数若日后被漏传，单测层面 matched 恒为 undefined、照样「通过」。
 */
describe('status 覆写行按 match 区分是否适用当前订阅', () => {
  it('match 不命中的文件移出主行，并说明原因与作用域', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.hit.yaml'), 'match:\n  name: edu*\nlog-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.miss.yaml'), 'match:\n  name: mini*\nlog-level: info\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /覆写:.*已启用 \(hit，1 个不适用\)/);
      // 文件名、当前订阅、作用域三者凑齐才看得出为什么没命中
      assert.match(out, /miss 不适用于当前订阅 edu1（作用域 name=mini\*）/);
      assert.ok(!/\(hit, miss/.test(out), '不命中的文件不得出现在生效清单里');
    });
  });

  it('两类失效分别计数：不适用 ≠ 已禁用（原因与改法都不同）', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.miss.yaml'), 'match:\n  name: mini*\nlog-level: info\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.off.yaml'), 'enabled: false\nlog-level: warning\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /覆写:.*已启用 \(a，1 个不适用，1 个已禁用\)/);
    });
  });

  it('全部文件都不适用时主行说「无生效文件」', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.miss.yaml'), 'match:\n  name: mini*\nlog-level: info\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /无生效文件，1 个不适用/);
    });
  });

  it('全部命中时无补充行（常态不加噪音）', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.hit.yaml'), 'match:\n  name: edu*\nlog-level: info\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /覆写:.*已启用 \(a, hit\)$/m);
      assert.ok(!out.includes('不适用'), '没有落选文件时不该出现该措辞');
    });
  });

  it('url-domain 作用域同样参与判定（两个条件是 AND，任一不命中即不适用）', () => {
    withFixture((dataDir, run) => {
      // fixture 的 edu1 指向 update.glados-config.com，故域名条件命中、名字条件不命中
      fs.writeFileSync(path.join(dataDir, 'overwrite.dom.yaml'), 'match:\n  url-domain: other.com\nlog-level: debug\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /dom 不适用于当前订阅 edu1（作用域 url-domain=other\.com）/);
    });
  });

  it('status --json 分出 applied：files 保持旧契约，applied 才是本次生效的', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.miss.yaml'), 'match:\n  name: mini*\nlog-level: info\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.off.yaml'), 'enabled: false\nlog-level: warning\n');
      const json = JSON.parse(run(['status', '--json', '--no-probe']).stdout);
      assert.deepEqual(json.overwrite.files, ['overwrite.a.yaml', 'overwrite.miss.yaml'], 'files 仍只滤文件级 enabled');
      assert.deepEqual(json.overwrite.applied, ['overwrite.a.yaml'], 'applied 再按 match 过滤');
    });
  });

  it('全局开关关闭时 applied 为空：那时 buildConfig 压根不加载覆写', () => {
    // 漏这道过滤会让同一份 JSON 自相矛盾——enabled:false 却列着「生效文件」，
    // 而人读形态此时只说「已禁用」、一个文件都不列，两种形态对不上
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.a.yaml'), 'log-level: debug\n');
      run(['ow', 'off']);
      const json = JSON.parse(run(['status', '--json', '--no-probe']).stdout);
      assert.equal(json.overwrite.enabled, false);
      assert.deepEqual(json.overwrite.applied, [], '全局关闭时没有任何覆写生效');
      assert.deepEqual(json.overwrite.files, ['overwrite.a.yaml'], 'files 是旧契约，不随全局开关变空');
    });
  });

  it('`ow` 列表不做 match 判定：它不绑定某条订阅，判不了也不该判', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.miss.yaml'), 'match:\n  name: mini*\nlog-level: info\n');
      const out = run(['ow']).stdout;
      assert.match(out, /overwrite\.miss\.yaml/);
      assert.match(out, /作用域: name=mini\*/);
      assert.ok(!out.includes('不适用'), 'ow 列表看不到活跃订阅，不得声称某文件不适用');
    });
  });
});

/**
 * 主文件在 status 覆写行里的显示名。
 *
 * `overwrite.yaml` 是最常见的配置形态（多数用户只有这一个文件），而剥前缀与剥扩展名
 * 的顺序一旦写反，它就显示成 `yaml`——既不是文件名也不是任何有意义的标识，`|| '主文件'`
 * 的兜底还永不触发。整块展示此前无任何用例，故单列一组按文件名形态锁死。
 */
describe('status 覆写行的文件显示名', () => {
  it('主文件显示为「主文件」，不是扩展名 yaml', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), 'log-level: debug\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /覆写:.*已启用 \(主文件\)$/m);
      assert.ok(!/\(yaml\)/.test(out), '主文件不得显示成扩展名 yaml');
    });
  });

  it('主文件与扩展文件并列时各自可辨', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), 'log-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.dns.yaml'), 'log-level: info\n');
      // 主文件恒排在最前（loadOverwriteFile 的排序约定）
      assert.match(run(['status', '--no-probe']).stdout, /覆写:.*已启用 \(主文件, dns\)$/m);
    });
  });

  it('.yml 扩展文件与不适用补充行同样按显示名规则', () => {
    withFixture((dataDir, run) => {
      fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), 'match:\n  name: mini*\nlog-level: debug\n');
      fs.writeFileSync(path.join(dataDir, 'overwrite.dns.yml'), 'log-level: info\n');
      const out = run(['status', '--no-probe']).stdout;
      assert.match(out, /覆写:.*已启用 \(dns，1 个不适用\)/);
      assert.match(out, /主文件 不适用于当前订阅 edu1（作用域 name=mini\*）/);
    });
  });
});
