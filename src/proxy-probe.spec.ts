import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isProbeSuccessStatus } from './proxy-probe.js';

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
