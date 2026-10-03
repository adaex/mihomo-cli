import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { isProbeSuccessStatus } from './proxy-probe.js';
import { runModule } from './test-support/cli.js';

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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-probe-env-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-probe-env-bin-'));
    const script = [
      `const { probeProxyConnectivity } = await import(${JSON.stringify(path.resolve('src/proxy-probe.ts'))});`,
      'const r = await probeProxyConnectivity(7897);',
      "console.log('OK:' + r.ok);",
      "console.log('CODE:' + r.statusCode);",
    ].join('\n');
    try {
      fs.writeFileSync(
        path.join(fakeBin, 'curl'),
        `#!/bin/bash
printf '%s' "\${no_proxy-__UNSET__}" > "$MIHOMO_TEST_CURL_ENV_MARKER.no_proxy"
printf '%s' "\${NO_PROXY-__UNSET__}" > "$MIHOMO_TEST_CURL_ENV_MARKER.NO_PROXY"
printf '204'
exit 0
`,
      );
      fs.chmodSync(path.join(fakeBin, 'curl'), 0o755);
      const r = runModule(script, dataDir, {
        env: {
          PATH: `${fakeBin}:${process.env.PATH}`,
          MIHOMO_TEST_CURL_ENV_MARKER: path.join(dataDir, 'curl-env'),
          no_proxy: '*',
          NO_PROXY: '*',
        },
        timeout: 30_000,
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /OK:true/);
      assert.match(r.stdout, /CODE:204/);
      assert.equal(fs.readFileSync(path.join(dataDir, 'curl-env.no_proxy'), 'utf8'), '');
      assert.equal(fs.readFileSync(path.join(dataDir, 'curl-env.NO_PROXY'), 'utf8'), '');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
