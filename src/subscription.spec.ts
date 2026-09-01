import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isMultiUrl, normalizeProxyNamesBeforeSave, parseUserInfo, splitUrls } from './subscription.js';
import type { ParsedSubscription } from './types.js';

describe('normalizeProxyNamesBeforeSave', () => {
  it('裁剪 _github.com/<repo> 尾缀并同步分组引用', () => {
    const parsed: ParsedSubscription = {
      raw: {},
      proxies: [{ name: 'HK_github.com/foo', server: 's', port: 1 }],
      proxyGroups: [{ name: 'G', proxies: ['HK_github.com/foo'] }],
    };
    const renamed = normalizeProxyNamesBeforeSave(parsed);
    assert.equal(renamed, 1);
    assert.equal(parsed.proxies[0].name, 'HK');
    assert.deepEqual(parsed.proxyGroups[0].proxies, ['HK']);
  });

  it('无可裁剪尾缀时返回 0、名称不变', () => {
    const parsed: ParsedSubscription = {
      raw: {},
      proxies: [{ name: 'HK', server: 's', port: 1 }],
      proxyGroups: [],
    };
    assert.equal(normalizeProxyNamesBeforeSave(parsed), 0);
    assert.equal(parsed.proxies[0].name, 'HK');
  });

  it('同步 rules 中直接引用旧节点名的目标', () => {
    const parsed: ParsedSubscription = {
      raw: { rules: ['DOMAIN,x.com,HK_github.com/foo', 'MATCH,DIRECT'] },
      proxies: [{ name: 'HK_github.com/foo', server: 's', port: 1 }],
      proxyGroups: [],
    };
    normalizeProxyNamesBeforeSave(parsed);
    assert.deepEqual(parsed.raw.rules, ['DOMAIN,x.com,HK', 'MATCH,DIRECT']);
  });

  it('同步 rules 中带 no-resolve 尾缀的目标位', () => {
    const parsed: ParsedSubscription = {
      raw: { rules: ['IP-CIDR,1.1.1.1/32,HK_github.com/foo,no-resolve'] },
      proxies: [{ name: 'HK_github.com/foo', server: 's', port: 1 }],
      proxyGroups: [],
    };
    normalizeProxyNamesBeforeSave(parsed);
    assert.deepEqual(parsed.raw.rules, ['IP-CIDR,1.1.1.1/32,HK,no-resolve']);
  });

  it('裁剪后名称冲突时保留原名（不重命名到已占用名）', () => {
    const parsed: ParsedSubscription = {
      raw: {},
      proxies: [
        { name: 'HK', server: 's', port: 1 },
        { name: 'HK_github.com/foo', server: 's', port: 2 },
      ],
      proxyGroups: [],
    };
    normalizeProxyNamesBeforeSave(parsed);
    // 'HK' 已被首个占用，第二个裁剪后会撞名，保留原名
    assert.equal(parsed.proxies[0].name, 'HK');
    assert.equal(parsed.proxies[1].name, 'HK_github.com/foo');
  });
});

describe('isMultiUrl / splitUrls 逗号判据', () => {
  it('query 含逗号的单条 URL 视为单源（否则 sub add 报「无效的 URL」无法添加）', () => {
    const url = 'https://x.com/api?flag=clash,meta&token=T';
    assert.equal(isMultiUrl(url), false);
    assert.deepEqual(splitUrls(url), [url]);
  });

  it('真多源正确识别与拆分', () => {
    const url = 'https://a.com/s,https://b.com/s';
    assert.equal(isMultiUrl(url), true);
    assert.deepEqual(splitUrls(url), ['https://a.com/s', 'https://b.com/s']);
  });

  it('多源带空格', () => {
    assert.deepEqual(splitUrls('https://a.com/s, https://b.com/s'), ['https://a.com/s', 'https://b.com/s']);
  });

  it('无逗号即单源', () => {
    assert.equal(isMultiUrl('https://a.com/s'), false);
  });

  it('部分片段非法时不视为多源（整体当单条处理）', () => {
    assert.equal(isMultiUrl('https://a.com/s,notaurl'), false);
  });
});

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
