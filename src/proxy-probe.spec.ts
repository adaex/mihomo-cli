import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isProbeSuccessStatus, probeProxyConnectivity } from './proxy-probe.js';
import { makeFixture, moduleUrl, runModule } from './test-support/cli.js';
import { runWithEnvRecordingStubCurl } from './test-support/stub-curl-env.js';

describe('isProbeSuccessStatus', () => {
  it('2xx 算通（204 是标准形态，200 是部分节点的中间响应）', () => {
    assert.equal(isProbeSuccessStatus(204), true);
    assert.equal(isProbeSuccessStatus(200), true);
  });

  it('3xx/4xx/5xx 与 null 不算通', () => {
    assert.equal(isProbeSuccessStatus(301), false);
    assert.equal(isProbeSuccessStatus(403), false);
    assert.equal(isProbeSuccessStatus(500), false);
    assert.equal(isProbeSuccessStatus(null), false);
  });
});

describe('probeProxyConnectivity（curl spawn env 出口端到端）', () => {
  it("shell 注入 no_proxy='*' 时桩 curl 实见空串（探测不得考成直连）", () => {
    // 反向验证锚点：spawn 若不走 buildCurlSpawnEnv 出口，本用例转红。
    // 例表命中 gstatic 即绕过 -x 直连——内核已死也亮绿灯，本函数存在意义作废
    const script = [
      `const { probeProxyConnectivity } = await import(${JSON.stringify(path.resolve('src/proxy-probe.ts'))});`,
      'const r = await probeProxyConnectivity(7897);',
      "console.log('OK:' + r.ok);",
      "console.log('CODE:' + r.statusCode);",
    ].join('\n');
    const r = runWithEnvRecordingStubCurl({ driverScript: script, curlPrintfFormat: '204' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK:true/);
    assert.match(r.stdout, /CODE:204/);
    assert.equal(r.env.noProxy, '');
    assert.equal(r.env.noProxyUpper, '');
  });

  it('连接拒绝时保留 curl 的具体 stderr，而不是只报 Command failed', async () => {
    // 代理地址固定为本机未监听端口，连接在本地即被拒绝，不访问探测目标或外网
    const r = await probeProxyConnectivity(1);
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /Failed to connect|Connection refused/);
    assert.doesNotMatch(r.error ?? '', /Command failed/);
  });

  it('实际探测记录结构化 curl 错误码，不持久化 stderr 正文', () => {
    const fixture = makeFixture('mihomo-probe-diagnostic');
    try {
      const script = `
        import { beginDiagnosticOperation } from ${JSON.stringify(moduleUrl('src/diagnostic-events.ts'))};
        import { probeProxyConnectivity } from ${JSON.stringify(moduleUrl('src/proxy-probe.ts'))};
        beginDiagnosticOperation('test');
        const result = await probeProxyConnectivity(1);
        console.log('OK:' + result.ok);
      `;
      const result = runModule(script, fixture.dataDir);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /OK:false/);
      const rows = fs
        .readFileSync(path.join(fixture.dataDir, 'logs', 'diagnostic.jsonl'), 'utf8')
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line));
      const probe = rows.find(row => row.event === 'proxy.probe');
      assert.equal(probe.result, 'failure');
      assert.equal(probe.port, 1);
      assert.equal(probe.httpStatus, null);
      assert.equal(typeof probe.errorCode, 'number');
      assert.ok(!('message' in probe));
      assert.ok(!('stack' in probe));
    } finally {
      fixture.cleanup();
    }
  });
});
