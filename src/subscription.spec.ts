import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isSubscriptionStale, isValidHttpUrl, needsAutoUpdate, parseUserInfo } from './subscription.js';

describe('parseUserInfo：只收有限非负数，其余按缺失处理', () => {
  it('正常头全字段解析', () => {
    assert.deepEqual(parseUserInfo('upload=100; download=200; total=1000; expire=1800000000'), {
      upload: 100,
      download: 200,
      total: 1000,
      expire: 1800000000,
    });
  });

  it('无有效 kv 的垃圾头返回 null', () => {
    // 此前返回 {}（truthy），调用方据此用四个 undefined 覆盖缓存，
    // 把已有的 upload/download/total/expire 全部抹掉
    assert.equal(parseUserInfo('garbage'), null);
    assert.equal(parseUserInfo(';;;'), null);
    assert.equal(parseUserInfo('=1'), null);
  });

  it('expire=abc 按缺失丢弃，不塞 0', () => {
    // 塞 0 会被 formatTimestamp 特判成「永久」——垃圾值显示成「永久有效」，最误导的方向
    const r = parseUserInfo('upload=1; download=2; total=3; expire=abc');
    assert.equal(r?.expire, undefined);
    assert.equal(r?.upload, 1);
  });

  it('total=1e999（Infinity）丢弃，避免 JSON.stringify 写成 null', () => {
    assert.equal(parseUserInfo('total=1e999'), null);
  });

  it('负数丢弃（会让用量百分比失真）', () => {
    const r = parseUserInfo('upload=-5; download=10');
    assert.equal(r?.upload, undefined);
    assert.equal(r?.download, 10);
  });

  it('空值丢弃（Number("") 是 0，不能当有效值收下）', () => {
    assert.equal(parseUserInfo('upload=; download='), null);
  });

  it('空头返回 null', () => {
    assert.equal(parseUserInfo(null), null);
    assert.equal(parseUserInfo(''), null);
  });

  it('0 是合法值（用量为零、不限量场景）', () => {
    assert.equal(parseUserInfo('upload=0')?.upload, 0);
  });
});

describe('isSubscriptionStale：新鲜度判断（status 与 doctor 共用口径）', () => {
  const NOW = Date.parse('2026-09-05T12:00:00Z');
  const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();

  it('超过默认 12h 间隔判超龄', () => {
    assert.equal(isSubscriptionStale({ updated_at: hoursAgo(13) }, NOW), true);
  });

  it('间隔内不超龄；缓存里的自定义间隔生效', () => {
    assert.equal(isSubscriptionStale({ updated_at: hoursAgo(11) }, NOW), false);
    assert.equal(isSubscriptionStale({ updated_at: hoursAgo(13), update_interval: 24 }, NOW), false);
    assert.equal(isSubscriptionStale({ updated_at: hoursAgo(25), update_interval: 24 }, NOW), true);
  });

  it('恰好等于间隔不算超龄（严格大于才判）', () => {
    assert.equal(isSubscriptionStale({ updated_at: hoursAgo(12) }, NOW), false);
  });

  it('缺失/非法/未来时间不算超龄（与 formatRelativeTime 同口径，时钟偏移不误报）', () => {
    assert.equal(isSubscriptionStale({}, NOW), false);
    assert.equal(isSubscriptionStale({ updated_at: 'garbage' }, NOW), false);
    assert.equal(isSubscriptionStale({ updated_at: new Date(NOW + 3_600_000).toISOString() }, NOW), false);
  });
});

describe('isValidHttpUrl：URL 解析 + 协议白名单（scheme 大小写不绕过）', () => {
  it('http/https 均合法，scheme 大小写不敏感（URL 解析会规范化为小写）', () => {
    assert.equal(isValidHttpUrl('https://example.com/sub'), true);
    assert.equal(isValidHttpUrl('HTTPS://example.com/sub'), true);
    assert.equal(isValidHttpUrl('http://example.com/sub'), true);
    assert.equal(isValidHttpUrl('HTTP://example.com/sub'), true);
  });

  it('非 http(s) scheme 拒绝', () => {
    assert.equal(isValidHttpUrl('httpfoo://example.com'), false);
    assert.equal(isValidHttpUrl('ftp://example.com'), false);
  });

  it('非法 URL 拒绝（含首尾空白的容忍由 trim 保证）', () => {
    assert.equal(isValidHttpUrl('not a url'), false);
    assert.equal(isValidHttpUrl(''), false);
    assert.equal(isValidHttpUrl('  https://example.com/sub  '), true);
  });
});

describe('needsAutoUpdate 与 isSubscriptionStale 的口径（异常时间戳方向相反，刻意如此）', () => {
  // 两个函数对缺失/NaN/未来时间戳的处理**刻意相反**：needsAutoUpdate 答 true
  // （立即更新、顺带纠正缓存），isSubscriptionStale 答 false（展示上不算超龄）。
  // 各自注释都有依据；这组用例防止重构「合并去重」时悄悄统一掉一个
  it('缺失 / NaN / 未来时间戳：needsAutoUpdate 全部要求立即更新', () => {
    for (const sub of [
      { name: 'a', url: 'https://example.com/a' },
      { name: 'a', url: 'https://example.com/a', updated_at: 'not-a-date' },
      { name: 'a', url: 'https://example.com/a', updated_at: new Date(Date.now() + 86_400_000).toISOString() },
    ]) {
      assert.equal(needsAutoUpdate(sub as never), true);
    }
  });

  it('同形态输入：isSubscriptionStale 全部判「不算超龄」', () => {
    for (const cached of [{}, { updated_at: 'not-a-date' }, { updated_at: new Date(Date.now() + 86_400_000).toISOString() }]) {
      assert.equal(isSubscriptionStale(cached as never), false);
    }
  });

  it('正常超龄两者一致为真、未超龄一致为假（口径仅在异常输入上分叉）', () => {
    const staleSub = { name: 'a', url: 'https://example.com/a', updated_at: new Date(Date.now() - 48 * 3_600_000).toISOString() };
    const freshSub = { ...staleSub, updated_at: new Date(Date.now() - 3_600_000).toISOString() };
    assert.equal(needsAutoUpdate(staleSub), true);
    assert.equal(isSubscriptionStale(staleSub), true);
    assert.equal(needsAutoUpdate(freshSub), false);
    assert.equal(isSubscriptionStale(freshSub), false);
  });
});

describe('downloadSubscription：缓存写失败的回滚与错误包装', () => {
  it('cache.json 不可写时抛 CliError、回滚已写的订阅文件（子进程端到端）', () => {
    // 端到端回归：订阅文件与缓存是两个写操作，缓存写失败（典型：cache.json 被手改
    // 成目录 → EISDIR）时旧实现留着刚写的新 yaml 报「更新失败」——回执与终态矛盾，
    // 下次 start 实际会用这次失败的配置；且错误是裸 Node errno 无标签无指引。
    // 子进程隔离数据目录：父进程静态 import 的模块已绑定默认 MIHOMO_CLI_DIR
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-dl-rollback-'));
    const subscriptionPath = path.resolve('src/subscription.ts');
    const script = [
      "import http from 'node:http';",
      "import fs from 'node:fs';",
      'const server = http.createServer((req, res) => {',
      "  res.setHeader('Content-Type', 'text/yaml');",
      "  res.end('proxies:\\n  - {name: n1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-256-gcm, password: x}\\n');",
      '});',
      "await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));",
      'const port = server.address().port;',
      'const dir = process.env.MIHOMO_CLI_DIR;',
      "fs.mkdirSync(dir + '/subscriptions/cache.json', { recursive: true });",
      `const { downloadSubscription } = await import(${JSON.stringify(subscriptionPath)});`,
      'try {',
      "  await downloadSubscription(`http://127.0.0.1:${port}/sub`, 'probe');",
      "  console.log('RESULT:NO-THROW');",
      '} catch (e) {',
      "  console.log('RESULT:' + JSON.stringify({ name: e.name, message: e.message }));",
      '} finally { server.close(); }',
      "console.log('YAML_EXISTS:' + fs.existsSync(dir + '/subscriptions/probe.yaml'));",
    ].join('\n');
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, MIHOMO_CLI_DIR: dataDir },
      });
      assert.equal(r.status, 0, r.stderr);
      const resultLine = r.stdout.split('\n').find(l => l.startsWith('RESULT:'));
      assert.ok(resultLine, `应有 RESULT 行，stdout: ${r.stdout}`);
      assert.ok(!resultLine.includes('NO-THROW'), '缓存写失败必须抛错，不能静默成功');
      assert.match(resultLine, /"name":"CliError"/, '错误须包装成 CliError（旧实现裸 Node errno）');
      assert.match(resultLine, /订阅缓存写入失败/);
      assert.match(r.stdout, /YAML_EXISTS:false/, '刚写的订阅文件必须随失败回滚');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
