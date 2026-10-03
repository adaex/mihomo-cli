import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { createHttpClient, createHttpError, isHttpsUrl } from './http.js';

describe('isHttpsUrl：降级守卫的 scheme 判据（URL 解析，非 startsWith）', () => {
  it('小写 https 判定为 https', () => {
    assert.equal(isHttpsUrl('https://example.com/sub?token=x'), true);
  });

  it('大写/混合大小写 scheme 也是 https（startsWith 判定会漏掉，守卫被跳过）', () => {
    assert.equal(isHttpsUrl('HTTPS://example.com/sub'), true);
    assert.equal(isHttpsUrl('Https://Example.com/sub'), true);
  });

  it('http 明文与其他 scheme 不是 https', () => {
    assert.equal(isHttpsUrl('http://example.com'), false);
    assert.equal(isHttpsUrl('ftp://example.com'), false);
    assert.equal(isHttpsUrl('httpfoo://example.com'), false);
  });

  it('非法 URL 返回 false 而非抛错（fetch 自会报错，守卫只管重定向）', () => {
    assert.equal(isHttpsUrl(''), false);
    assert.equal(isHttpsUrl('not a url'), false);
    assert.equal(isHttpsUrl('example.com/sub'), false);
  });
});

describe('createHttpError：HTTP 错误的统一形态（直连 fetch 与代理 curl 共用）', () => {
  it('message 为 HTTP <status>，JSON 错误体解析进 response.data（命令层据此渲染 原因/文档）', () => {
    const body = JSON.stringify({
      message: 'API rate limit exceeded for 203.0.113.7.',
      documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
    });
    const error = createHttpError(403, body);
    assert.equal(error.message, 'HTTP 403');
    assert.equal(error.response.status, 403);
    assert.equal(error.response.data?.message, 'API rate limit exceeded for 203.0.113.7.');
    assert.equal(error.response.data?.documentation_url, 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting');
  });

  it('错误体非 JSON 时 response.data 缺失，status 仍可定位问题', () => {
    const error = createHttpError(502, '<html>Bad Gateway</html>');
    assert.equal(error.message, 'HTTP 502');
    assert.equal(error.response.status, 502);
    assert.equal(error.response.data, undefined);
  });

  it('超大错误体只取限量前缀做摘录（截断后解析失败即无 data，不整体解析）', () => {
    // fixture 必须是「整体是合法 JSON、截断后不再是」的判别形态——纯垃圾字节
    // （'x'×100KB）在任何前缀长度下都解析失败，无截断的实现同样给 undefined，
    // 用例恒真（终审抓出）。合法 JSON 拆在 64KB 边界内才咬得住截断行为
    const bigJson = `{"msg":"${'y'.repeat(200 * 1024)}"}`;
    const error = createHttpError(500, bigJson);
    assert.equal(error.message, 'HTTP 500');
    assert.equal(error.response.status, 500);
    assert.equal(error.response.data, undefined, '截断后的前缀不是合法 JSON，不得给出 data');
  });
});

describe('createHttpClient：4xx 诊断与降级守卫行为', () => {
  const servers: http.Server[] = [];

  const startServer = (handler: http.RequestListener): Promise<string> =>
    new Promise(resolve => {
      const server = http.createServer(handler);
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });

  afterEach(() => Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))));

  it('4xx 抛 HTTP <status> 并带 response.data——代理 curl 路径对齐的目标形态', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'API rate limit exceeded for 203.0.113.7.', documentation_url: 'https://docs.github.com/rest/rate-limit' }));
    });
    const client = createHttpClient({ timeout: 10_000 });
    await assert.rejects(client.get(`${base}/repos/MetaCubeX/mihomo/releases`, { responseType: 'json' }), e => {
      const err = e as Error & { response?: { status?: number; data?: { message?: string; documentation_url?: string } } };
      assert.equal(err.message, 'HTTP 403');
      assert.equal(err.response?.status, 403);
      assert.equal(err.response?.data?.message, 'API rate limit exceeded for 203.0.113.7.');
      assert.equal(err.response?.data?.documentation_url, 'https://docs.github.com/rest/rate-limit');
      return true;
    });
  });

  it('http 明文请求不受 https 降级守卫影响（守卫只针对 https 请求的重定向）', async () => {
    const base = await startServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const client = createHttpClient({ timeout: 10_000 });
    const response = await client.get<{ ok: boolean }>(`${base}/redirect`, { responseType: 'json' });
    assert.deepEqual(response.data, { ok: true });
  });

  // 本地无证书无法端到端构造 https→http 重定向，用桩 fetch 固定守卫分支的输入。
  // 桩成 302 跳 http：逐跳守卫在**第一段明文 hop** 即拒绝——「先降 http 再跳回 https」
  // 的链条（最终地址是 https、只查最终 URL 的旧守卫放行）同样在这里被拦下
  it('https→http 降级守卫逐跳拦截且错误消息脱敏（token 常被服务器保留在重定向查询串里）', async () => {
    const originalFetch = globalThis.fetch;
    const fakeResponse = {
      url: 'https://airport.example.com/sub?token=SECRETTOKEN1234567890',
      ok: false,
      status: 302,
      headers: new Headers({ location: 'http://mirror.example.com/dl?token=SECRETTOKEN1234567890' }),
    };
    globalThis.fetch = (async () => fakeResponse) as unknown as typeof fetch;
    try {
      const client = createHttpClient({ timeout: 1_000 });
      await assert.rejects(client.get('https://airport.example.com/sub?token=SECRETTOKEN1234567890'), e => {
        const message = (e as Error).message;
        assert.match(message, /非 https/);
        // 错误消息若原样带降级地址，恰在本守卫要防的攻击形态（降级重定向）下泄漏 token
        assert.doesNotMatch(message, /SECRETTOKEN1234567890/);
        assert.match(message, /token=\*\*\*/);
        return true;
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('重定向环在超过上限时中止，不会顶满超时预算干等', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    // 每一跳都回到同一段 https 地址（合法且不降级），永不终止
    globalThis.fetch = (async () => {
      calls++;
      return { url: 'https://loop.example.com/hop', ok: false, status: 302, headers: new Headers({ location: 'https://loop.example.com/hop' }) };
    }) as unknown as typeof fetch;
    try {
      const client = createHttpClient({ timeout: 60_000 });
      await assert.rejects(client.get('https://loop.example.com/start'), e => {
        assert.match((e as Error).message, /重定向次数超过 20/);
        return true;
      });
      assert.ok(calls <= 21, `跟随次数应被上限截断（实际 fetch 调用 ${calls} 次）`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('声明 Content-Length 超上限：读 body 前预拒，不把 GB 级 body 拉进内存', async () => {
    const base = await startServer((_req, res) => {
      // 谎报 Content-Length 后只发一小段：预拒必须发生在读取之前，不看真实 body 大小
      res.writeHead(200, { 'content-length': String(51 * 1024 * 1024) });
      res.end('tiny');
    });
    const client = createHttpClient({ timeout: 10_000 });
    await assert.rejects(client.get(`${base}/big`), e => {
      assert.match((e as Error).message, /响应体过大/);
      return true;
    });
  });

  it('不声明 Content-Length 的分块传输：流式计数超限即中止（声明预拒拦不住的形态）', async () => {
    const base = await startServer((_req, res) => {
      res.writeHead(200);
      // 52MB 超过 50MB 上限；回环传输秒级
      res.end(Buffer.alloc(52 * 1024 * 1024, 0x61));
    });
    const client = createHttpClient({ timeout: 30_000 });
    await assert.rejects(client.get(`${base}/chunked`), e => {
      assert.match((e as Error).message, /响应体超过大小上限/);
      return true;
    });
  });

  it('错误体超过 64KB：读被限量中止并吞掉（不升级为整体失败），status 仍可定位', async () => {
    // 该形态实际锁的是：错误路径超限读取被 readBodyWithLimit 中止后**吞掉**，
    // 不升级成「响应体超过大小上限」——err.message 必须仍是 HTTP 502。
    // （前缀截断行为由上面 createHttpError 的单元用例锁，错误路径的 text
    // 在中止后为空串，e2e 层观测不到前缀内容）
    const base = await startServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(Buffer.alloc(200 * 1024, 0x62));
    });
    const client = createHttpClient({ timeout: 10_000 });
    await assert.rejects(client.get(`${base}/err`), e => {
      const err = e as Error & { response?: { status?: number; data?: unknown } };
      assert.equal(err.message, 'HTTP 502', '错误体的限量读取不得升级为整体大小失败');
      assert.equal(err.response?.status, 502);
      assert.equal(err.response?.data, undefined);
      return true;
    });
  });

  it('超时（定时器到点的 abort）翻译成超时语义，不再是裸 AbortError', async () => {
    // 直连被墙干等 60s 后收到「This operation was aborted」无从排查——
    // 诊断要与 curl 路径的退出码翻译对齐。server 收到请求后挂起不响应
    const base = await startServer(() => {
      /* 永不响应 */
    });
    const client = createHttpClient({ timeout: 200 });
    await assert.rejects(client.get(`${base}/hang`), e => {
      assert.match((e as Error).message, /请求超时（0s）/);
      assert.doesNotMatch((e as Error).message, /aborted/);
      return true;
    });
  });

  it('外部 signal 的中止不翻译成超时（调用方按 aborted 分档，消息另有归属）', async () => {
    const base = await startServer(() => {
      /* 永不响应 */
    });
    const client = createHttpClient({ timeout: 60_000 });
    const external = new AbortController();
    external.abort(); // 只中止外部 signal，客户端自己的定时器不动
    await assert.rejects(client.get(`${base}/sub`, { signal: external.signal }), e => {
      assert.equal((e as Error).name, 'AbortError', '外部中止保持原始 AbortError 上抛');
      return true;
    });
  });
});
