import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseUserInfo } from './subscription.js';

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
