import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCurlSpawnEnv } from './curl-spawn.js';

describe('buildCurlSpawnEnv（curl 子进程代理策略唯一出口）', () => {
  const priorNoProxy = process.env.no_proxy;
  const priorNoProxyUpper = process.env.NO_PROXY;
  const priorUnrelated = process.env.HOME;

  function restore() {
    if (priorNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = priorNoProxy;
    if (priorNoProxyUpper === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = priorNoProxyUpper;
  }

  it('no_proxy/NO_PROXY 一律置空：shell 里的 * 或目标域条目不得绕过显式 -x', () => {
    process.env.no_proxy = '*';
    process.env.NO_PROXY = 'gstatic.com, github.com';
    try {
      const env = buildCurlSpawnEnv();
      assert.equal(env.no_proxy, '');
      assert.equal(env.NO_PROXY, '');
      assert.equal(env.HOME, priorUnrelated, '继承的其他 env 必须保留');
    } finally {
      restore();
    }
  });

  it('预先不存在时也显式置空（存在但为空按 curl 语义 = 无例外，与 delete 同效更可读）', () => {
    delete process.env.no_proxy;
    delete process.env.NO_PROXY;
    try {
      const env = buildCurlSpawnEnv();
      assert.equal(env.no_proxy, '');
      assert.equal(env.NO_PROXY, '');
    } finally {
      restore();
    }
  });

  it('只返回新对象，不写回 process.env（不污染同进程后续子进程）', () => {
    process.env.no_proxy = '*';
    try {
      buildCurlSpawnEnv();
      assert.equal(process.env.no_proxy, '*', 'process.env 不应被改写');
    } finally {
      restore();
    }
  });
});
