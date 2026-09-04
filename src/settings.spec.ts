import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { maskUrl } from './settings.js';

describe('maskUrl', () => {
  it('遮蔽 query 中的 token 类参数', () => {
    const r = maskUrl('https://example.com/sub?token=secret123&foo=bar');
    assert.ok(r.includes('token=***'));
    assert.ok(r.includes('foo=bar'));
    assert.ok(!r.includes('secret123'));
  });

  it('遮蔽 userinfo（用户名/密码）', () => {
    const r = maskUrl('https://user:pass@example.com/sub');
    assert.ok(!r.includes('user'));
    assert.ok(!r.includes('pass'));
    assert.ok(r.includes('***'));
  });

  it('遮蔽长路径段（疑似路径型 token），保留首尾便于辨认', () => {
    const longSeg = 'abcd1234567890efgh';
    const r = maskUrl(`https://example.com/api/v1/client/subscribe/${longSeg}`);
    assert.ok(!r.includes(longSeg));
    assert.ok(r.includes('abcd***efgh'));
  });

  it('短路径段不遮蔽', () => {
    const r = maskUrl('https://example.com/api/v1/sub');
    assert.equal(r, 'https://example.com/api/v1/sub');
  });

  it('非法 URL 且较长时截断', () => {
    const r = maskUrl('not-a-url-but-a-very-long-string-here-xyz');
    assert.ok(r.includes('...'));
  });

  it('空字符串原样返回', () => {
    assert.equal(maskUrl(''), '');
  });
});

describe('maskUrl 逗号：URL 整体处理，不做任何切分', () => {
  it('query 含逗号时 token 正确遮蔽', () => {
    // 逗号在 query 中合法。按逗号切分会让 token= 落到第二段而识别不出 → 明文输出
    const masked = maskUrl('https://x.com/api?nodes=us,hk&token=SUPERSECRET1');
    assert.ok(!masked.includes('SUPERSECRET1'), `token 不应明文出现: ${masked}`);
    assert.ok(masked.includes('token=***'));
  });

  it('逗号后拼接的内容落进 token 值，随之一并遮蔽', () => {
    const masked = maskUrl('https://a.com/s?token=AAA111,https://b.com/s?key=BBB222');
    assert.ok(!masked.includes('AAA111'), `token 应遮蔽: ${masked}`);
    assert.ok(!masked.includes('BBB222'), `token 值内的尾随内容应一并遮蔽: ${masked}`);
  });

  it('逗号落在 path 时，其后的长路径段仍按路径型令牌遮蔽', () => {
    const masked = maskUrl('https://a.com/s,https://b.com/sub/abcd1234567890efgh');
    assert.ok(!masked.includes('abcd1234567890efgh'), `路径型令牌应遮蔽: ${masked}`);
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
