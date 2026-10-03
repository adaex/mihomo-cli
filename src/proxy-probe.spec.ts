import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isProbeSuccessStatus } from './proxy-probe.js';
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
});
