import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { subscriptionUrgency } from './settings.js';
import { moduleUrl, runModule } from './test-support/cli.js';

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

  it('手改缓存写入字符串时不误判流量用尽（Number 化，非有限值不参与）', () => {
    // 回归：裸相加遇到字符串会拼接成 "1234"，"1234" >= 200 被误报 traffic-exhausted
    const dirty = (e: Record<string, unknown>) => e as unknown as Parameters<typeof subscriptionUrgency>[0];
    assert.equal(subscriptionUrgency(dirty({ total: 200, upload: '12', download: '34' }), now), null);
    assert.equal(subscriptionUrgency(dirty({ total: 100, upload: 'oops', download: 1 }), now), null);
    // 数字字符串仍按数值判：12 >= 10 必须照常报用尽，硬化不是把字符串一概忽略
    assert.equal(subscriptionUrgency(dirty({ total: 10, upload: '6', download: '6' }), now), 'traffic-exhausted');
  });
});

describe('损坏文件的备份只保留第一份原件', () => {
  // readSettings/readSubscriptionCache 在模块加载时即经 PATHS 固定数据目录，
  // 故在子进程里用隔离 MIHOMO_CLI_DIR 跑真实模块
  const settingsModuleUrl = moduleUrl('src/settings.ts');
  const pathsModuleUrl = moduleUrl('src/paths.ts');

  function readBackupAfterTwoCorruptions(kind: 'settings' | 'cache'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-bak-'));
    const code = `
      const fs = await import('node:fs');
      const nodePath = await import('node:path');
      const m = await import(${JSON.stringify(settingsModuleUrl)});
      const { PATHS } = await import(${JSON.stringify(pathsModuleUrl)});
      const file = ${JSON.stringify(kind)} === 'settings' ? PATHS.settingsFile : PATHS.subscriptionsCacheFile;
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'FIRST-CORRUPT{{');
      ${JSON.stringify(kind)} === 'settings' ? m.readSettings() : m.readSubscriptionCache();
      fs.writeFileSync(file, 'SECOND-CORRUPT{{');
      ${JSON.stringify(kind)} === 'settings' ? m.readSettings() : m.readSubscriptionCache();
      process.stdout.write(fs.readFileSync(file + '.bak', 'utf8'));
    `;
    const r = runModule(code, dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return r.stdout;
  }

  it('settings.json：第二次损坏不覆盖第一份原件备份', () => {
    assert.equal(readBackupAfterTwoCorruptions('settings'), 'FIRST-CORRUPT{{');
  });

  it('cache.json：同族，已有 .bak 时保留更早的备份', () => {
    assert.equal(readBackupAfterTwoCorruptions('cache'), 'FIRST-CORRUPT{{');
  });

  // 回归：合法 JSON 但不是对象（`[1,2]`/`42`/`"str"`/`null`）此前直接返回空缓存，
  // 不备份也不出声，下一次写缓存全量覆盖、原件无声丢失——readSettings 对同族
  // 形态早已「备份+告警」，cache 侧漏修
  it('cache.json 合法 JSON 但非对象：同样备份原件再回退空缓存', () => {
    for (const bad of ['[1,2,3]', '42', '"str"', 'null']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-bak-'));
      const code = `
        const fs = await import('node:fs');
        const nodePath = await import('node:path');
        const m = await import(${JSON.stringify(settingsModuleUrl)});
        const { PATHS } = await import(${JSON.stringify(pathsModuleUrl)});
        const file = PATHS.subscriptionsCacheFile;
        fs.mkdirSync(nodePath.dirname(file), { recursive: true });
        fs.writeFileSync(file, ${JSON.stringify(bad)});
        m.readSubscriptionCache();
        process.stdout.write(fs.existsSync(file + '.bak') ? fs.readFileSync(file + '.bak', 'utf8') : 'NO-BAK');
      `;
      const r = runModule(code, dir);
      fs.rmSync(dir, { recursive: true, force: true });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.equal(r.stdout, bad, `非对象 JSON 应先备份原件再回退空缓存（输入 ${bad}）`);
    }
  });
});

describe('saveSubscriptionCache 跨进程并发', () => {
  it('多进程同时写入不丢条目（cache.json 的读-改-写持锁）', async () => {
    // 回归测试：此前 saveSubscriptionCache 是裸读-改-写，只在单进程内靠「无 await」安全。
    // 跨进程下后写者整块覆盖先写者，实测 4 进程各写 30 条丢 7 条。丢的是 updated_at →
    // needsAutoUpdate 恒 true → 该订阅每次 start 都重新下载，且流量/到期展示消失。
    //
    // 必须用 spawn 而非 spawnSync：后者逐个跑完，根本不产生并发，测不出这个 bug。
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-cache-race-'));
    const settingsPath = path.resolve('src/settings.ts');
    const WORKERS = ['A', 'B', 'C', 'D'];
    const PER_WORKER = 15;

    try {
      const codes = await Promise.all(
        WORKERS.map(
          who =>
            new Promise<number | null>(resolve => {
              const child = spawn(
                process.execPath,
                [
                  '--import',
                  'tsx',
                  '-e',
                  `import { saveSubscriptionCache } from ${JSON.stringify(settingsPath)};
                   for (let i = 0; i < ${PER_WORKER}; i++) {
                     saveSubscriptionCache(${JSON.stringify(who)} + '-' + i, { total: i });
                   }`,
                ],
                { stdio: 'ignore', env: { ...process.env, MIHOMO_CLI_DIR: tmpDir } },
              );
              child.on('close', code => resolve(code));
              child.on('error', () => resolve(-1));
            }),
        ),
      );
      for (const code of codes) {
        assert.equal(code, 0, '写入子进程应正常退出');
      }

      const cacheFile = path.join(tmpDir, 'subscriptions', 'cache.json');
      const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, unknown>;
      const keys = Object.keys(cache);
      const expected = WORKERS.length * PER_WORKER;
      assert.equal(keys.length, expected, `期望 ${expected} 条，实际 ${keys.length} 条（并发写丢失）`);
      for (const who of WORKERS) {
        assert.equal(keys.filter(k => k.startsWith(`${who}-`)).length, PER_WORKER, `worker ${who} 的条目应完整保留`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('updateSettings 跨进程并发', () => {
  it('多进程同时改订阅列表不丢条目（settings.json 的读-改-写持锁）', async () => {
    // CODE_REVIEW 曾声称此场景有测试、实际缺失（只有 cache.json 版）。
    // settings.json 的丢失形态：后写者整块覆盖先写者刚写入的 subscriptions，
    // 双方都拿到成功回执——与 cache.json 同一族，防线同为 withFileLock
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-settings-race-'));
    const settingsPath = path.resolve('src/settings.ts');
    const WORKERS = ['A', 'B', 'C', 'D'];
    const PER_WORKER = 15;

    try {
      const codes = await Promise.all(
        WORKERS.map(
          who =>
            new Promise<number | null>(resolve => {
              const child = spawn(
                process.execPath,
                [
                  '--import',
                  'tsx',
                  '-e',
                  `import { updateSettings } from ${JSON.stringify(settingsPath)};
                   for (let i = 0; i < ${PER_WORKER}; i++) {
                     const name = ${JSON.stringify(who)} + '-' + i;
                     updateSettings(s => ({ subscriptions: [...(s.subscriptions ?? []), { name, url: 'https://example.com/' + name }] }));
                   }`,
                ],
                { stdio: 'ignore', env: { ...process.env, MIHOMO_CLI_DIR: tmpDir } },
              );
              child.on('close', code => resolve(code));
              child.on('error', () => resolve(-1));
            }),
        ),
      );
      for (const code of codes) {
        assert.equal(code, 0, '写入子进程应正常退出');
      }

      const settingsFile = path.join(tmpDir, 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { subscriptions?: { name: string }[] };
      const names = (settings.subscriptions ?? []).map(s => s.name);
      const expected = WORKERS.length * PER_WORKER;
      assert.equal(names.length, expected, `期望 ${expected} 条，实际 ${names.length} 条（并发写丢失）`);
      for (const who of WORKERS) {
        assert.equal(names.filter(n => n.startsWith(`${who}-`)).length, PER_WORKER, `worker ${who} 的条目应完整保留`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getPorts：端口逃生口（settings.ports）', () => {
  it('缺省回默认、合法覆盖生效、非法值 fail-closed 抛错', async () => {
    // USER_DATA_DIR 在模块求值时读 MIHOMO_CLI_DIR（顶层常量），测试进程已定死——
    // 与并发测试同法：spawn 子进程带 env 跑全部场景，退出码 0 即全部断言通过
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ports-'));
    const settingsPath = path.resolve('src/settings.ts');
    const script = [
      `import fs from 'node:fs';`,
      `import assert from 'node:assert/strict';`,
      `import { getPorts } from ${JSON.stringify(settingsPath)};`,
      `const file = process.env.MIHOMO_CLI_DIR + '/settings.json';`,
      `const write = o => { fs.writeFileSync(file, JSON.stringify(o)); };`,
      `write({});`,
      `assert.deepEqual(getPorts(), { mixed: 7890, controller: 9090 });`,
      `write({ ports: { mixed: 17890, controller: 19090 } });`,
      `assert.deepEqual(getPorts(), { mixed: 17890, controller: 19090 });`,
      `write({ ports: { controller: 19090 } });`,
      `assert.deepEqual(getPorts(), { mixed: 7890, controller: 19090 });`,
      // 非法值必须抛错而非静默回退默认：端口突降会让热重载/UI 连错地址且无任何线索
      `for (const bad of [0, 65536, 1.5, '17890', null]) {`,
      `  write({ ports: { mixed: bad } });`,
      `  assert.throws(() => getPorts(), /1-65535/);`,
      `}`,
      `write({ ports: { mixed: 17890, controller: 17890 } });`,
      `assert.throws(() => getPorts(), /不能相同/);`,
      `write({ ports: [17890] });`,
      `assert.throws(() => getPorts(), /需为对象/);`,
    ].join('\n');

    try {
      const code = await new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
          stdio: 'ignore',
          env: { ...process.env, MIHOMO_CLI_DIR: tmpDir },
        });
        child.on('close', c => resolve(c));
        child.on('error', () => resolve(-1));
      });
      assert.equal(code, 0, 'getPorts 场景断言应全部通过（子进程退出码非 0）');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('getPorts：单侧配置撞另一侧默认端口', () => {
  it('mixed=9090 / controller=7890 报错，不撞默认的单侧覆盖仍可用', async () => {
    // 回归：相等校验曾在两侧都显式配置时才执行，{"ports":{"mixed":9090}} 解析成
    // {mixed:9090, controller:9090} 不报错——mixed-port 与 external-controller 同端口，
    // 内核 -t 只做解析照样通过，真正启动时第二个监听 bind 失败，doctor 还误报「9090 空闲」
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-ports-default-'));
    const settingsPath = path.resolve('src/settings.ts');
    const script = [
      `import fs from 'node:fs';`,
      `import assert from 'node:assert/strict';`,
      `import { getPorts } from ${JSON.stringify(settingsPath)};`,
      `const file = process.env.MIHOMO_CLI_DIR + '/settings.json';`,
      `const write = o => { fs.writeFileSync(file, JSON.stringify(o)); };`,
      `write({ ports: { mixed: 9090 } });`,
      `assert.throws(() => getPorts(), /不能相同/);`,
      `assert.throws(() => getPorts(), /ports.controller 未配置，取默认 9090/);`,
      `write({ ports: { controller: 7890 } });`,
      `assert.throws(() => getPorts(), /不能相同/);`,
      `assert.throws(() => getPorts(), /ports.mixed 未配置，取默认 7890/);`,
      `write({ ports: { mixed: 17890 } });`,
      `assert.deepEqual(getPorts(), { mixed: 17890, controller: 9090 });`,
    ].join('\n');

    try {
      const code = await new Promise<number | null>(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
          stdio: 'ignore',
          env: { ...process.env, MIHOMO_CLI_DIR: tmpDir },
        });
        child.on('close', c => resolve(c));
        child.on('error', () => resolve(-1));
      });
      assert.equal(code, 0, '单侧撞默认端口场景断言应全部通过（子进程退出码非 0）');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('设置读取与更新不依赖进程缓存', () => {
  it('文件被替换后读取新值，失败的 mutator 不写盘', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-settings-fresh-'));
    try {
      const script = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import { readSettings, updateSettings, writeSettings } from ${JSON.stringify(path.resolve('src/settings.ts'))};
        const file = path.join(process.env.MIHOMO_CLI_DIR, 'settings.json');
        writeSettings({ active_subscription: 'before' });
        assert.equal(readSettings().active_subscription, 'before');
        fs.writeFileSync(file, JSON.stringify({ active_subscription: 'after', ports: { mixed: 17890 } }));
        assert.equal(readSettings().active_subscription, 'after');
        const previous = fs.readFileSync(file, 'utf8');
        assert.throws(() => updateSettings(() => { throw new Error('cancel'); }));
        assert.equal(fs.readFileSync(file, 'utf8'), previous);
        writeSettings({ overwrite_enabled: false });
        assert.deepEqual(readSettings(), { active_subscription: 'after', ports: { mixed: 17890 }, overwrite_enabled: false });
      `;
      const result = runModule(script, tmpDir);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * JSON 合法但不是对象的 settings.json（`[1,2,3]` / `"str"` / `42` / `null`）。
 *
 * 此前这条路径直接 `return {}`：既不备份也不告警，而下一次 updateSettings 会把文件
 * 整个覆盖成默认内容——用户原件无声无息地没了。它与「JSON 解析失败」是同一类
 * 「文件不可用」，处置必须一致。
 */
describe('settings.json 为非对象时同样备份并告警', () => {
  const settingsModuleUrl = moduleUrl('src/settings.ts');
  const pathsModuleUrl = moduleUrl('src/paths.ts');

  function readNonObject(content: string): { warned: string; backup: string | null; result: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-nonobj-'));
    const code = `
      const fs = await import('node:fs');
      const nodePath = await import('node:path');
      const m = await import(${JSON.stringify(settingsModuleUrl)});
      const { PATHS } = await import(${JSON.stringify(pathsModuleUrl)});
      fs.mkdirSync(nodePath.dirname(PATHS.settingsFile), { recursive: true });
      fs.writeFileSync(PATHS.settingsFile, ${JSON.stringify(content)});
      const got = m.readSettings();
      const bak = PATHS.settingsFile + '.bak';
      process.stdout.write(JSON.stringify({
        result: JSON.stringify(got),
        backup: fs.existsSync(bak) ? fs.readFileSync(bak, 'utf8') : null,
      }));
    `;
    const r = runModule(code, dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const parsed = JSON.parse(r.stdout) as { result: string; backup: string | null };
    return { warned: r.stderr, backup: parsed.backup, result: parsed.result };
  }

  for (const [content, label] of [
    ['[1,2,3]', '数组'],
    ['"a string"', 'string'],
    ['42', 'number'],
    ['null', 'null'],
  ] as const) {
    it(`${content} → 回退默认设置、备份原件并告警（识别为${label}）`, () => {
      const { warned, backup, result } = readNonObject(content);
      assert.equal(result, '{}', '必须回退成默认设置');
      assert.equal(backup, content, '原件必须完整备份，否则下次写入就把它覆盖没了');
      assert.match(warned, /settings\.json 内容不是对象/);
      assert.match(warned, new RegExp(label.replace(/[[\]]/g, '\\$&')));
    });
  }

  it('合法对象不触发备份，也不告警', () => {
    const { warned, backup, result } = readNonObject('{"active_subscription":"home"}');
    assert.equal(result, '{"active_subscription":"home"}');
    assert.equal(backup, null, '正常文件不该产生 .bak');
    assert.equal(warned.trim(), '');
  });
});

describe('removeSubscription：数据最终状态（子进程真实模块）', () => {
  const settingsModuleUrl = moduleUrl('src/settings.ts');
  const pathsModuleUrl = moduleUrl('src/paths.ts');

  it('remove 后订阅条目删除、原始配置文件删除、活跃订阅切换到剩余条目', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-remove-'));
    try {
      const code = `
        const fs = await import('node:fs');
        const nodePath = await import('node:path');
        const m = await import(${JSON.stringify(settingsModuleUrl)});
        const paths = await import(${JSON.stringify(pathsModuleUrl)});
        fs.mkdirSync(nodePath.dirname(paths.PATHS.settingsFile), { recursive: true });
        fs.writeFileSync(paths.PATHS.settingsFile, JSON.stringify({
          active_subscription: 'a',
          subscriptions: [
            { name: 'a', url: 'https://example.com/a' },
            { name: 'b', url: 'https://example.com/b' },
          ],
        }));
        const rawA = nodePath.join(paths.DIRS.subscriptions, 'a.yaml');
        fs.mkdirSync(nodePath.dirname(rawA), { recursive: true });
        fs.writeFileSync(rawA, 'proxies: []');
        const switched = m.removeSubscription('a');
        const settings = JSON.parse(fs.readFileSync(paths.PATHS.settingsFile, 'utf8'));
        process.stdout.write('SWITCHED:' + JSON.stringify(switched) + '\\n');
        process.stdout.write('NAMES:' + settings.subscriptions.map(s => s.name).join(',') + '\\n');
        process.stdout.write('ACTIVE:' + String(settings.active_subscription) + '\\n');
        process.stdout.write('RAW_EXISTS:' + String(fs.existsSync(rawA)) + '\\n');
      `;
      const r = runModule(code, dir);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /SWITCHED:\{"found":true,"switchedTo":"b"\}/);
      assert.match(r.stdout, /NAMES:b/);
      assert.match(r.stdout, /ACTIVE:b/);
      assert.match(r.stdout, /RAW_EXISTS:false/, '原始配置文件应随 remove 删除（postCommit 副作用）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remove 不存在的订阅：不动设置、不执行删除副作用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-remove-'));
    try {
      const code = `
        const fs = await import('node:fs');
        const nodePath = await import('node:path');
        const m = await import(${JSON.stringify(settingsModuleUrl)});
        const paths = await import(${JSON.stringify(pathsModuleUrl)});
        fs.mkdirSync(nodePath.dirname(paths.PATHS.settingsFile), { recursive: true });
        fs.writeFileSync(paths.PATHS.settingsFile, JSON.stringify({
          active_subscription: 'a',
          subscriptions: [{ name: 'a', url: 'https://example.com/a' }],
        }));
        // 文件名与传给 remove 的名字一致——remove 内部删的就是 subscriptions/<name>.yaml
        const ghost = nodePath.join(paths.DIRS.subscriptions, 'missing.yaml');
        fs.mkdirSync(nodePath.dirname(ghost), { recursive: true });
        fs.writeFileSync(ghost, 'proxies: []');
        const result = m.removeSubscription('missing');
        process.stdout.write('GHOST_EXISTS:' + String(fs.existsSync(ghost)) + '\\n');
        const settings = JSON.parse(fs.readFileSync(paths.PATHS.settingsFile, 'utf8'));
        process.stdout.write('RESULT:' + JSON.stringify(result) + '\\n');
        process.stdout.write('NAMES:' + settings.subscriptions.map(s => s.name).join(',') + '\\n');
      `;
      const r = runModule(code, dir);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.match(r.stdout, /RESULT:\{"found":false[^}]*\}/);
      assert.match(r.stdout, /NAMES:a/);
      // 时序判别：未命中不产生补丁，删除副作用不得执行——rm 若在 mutator 里
      //（写盘之前）就会先删掉文件；postCommit 语义下它与提交绑定
      assert.match(r.stdout, /GHOST_EXISTS:true/, '空补丁不得执行删除副作用');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
