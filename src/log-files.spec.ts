import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isArchiveLogFilename } from './log-files.js';

describe('归档日志文件名判据（清理与列表的单一真相源）', () => {
  // 此前 cleanupOldLogs 与 listLogs 各写一份正则，只有前者认序号后缀：
  // `mihomo.<ts>.1.log` 会被按时清理却永远不出现在 `logs` 列表里，
  // 于是 `logs <编号>` 拿不到它——而序号后缀恰恰产生于「同一秒内二次轮转」，
  // 也就是 start 失败后立即重试这个最需要翻日志的场景。
  it('认标准时间戳归档', () => {
    assert.ok(isArchiveLogFilename('mihomo.2026-09-06_10-00-00.log'));
  });

  it('认带序号后缀的归档（同秒二次轮转产生，此前列表漏了它）', () => {
    assert.ok(isArchiveLogFilename('mihomo.2026-09-06_10-00-00.1.log'), '带序号的归档必须能被列出，否则 logs <编号> 永远访问不到');
    assert.ok(isArchiveLogFilename('mihomo.2026-09-06_10-00-00.12.log'));
  });

  it('不认当前日志本身（它由 listLogs 单独作为编号 0 处理）', () => {
    assert.equal(isArchiveLogFilename('mihomo.log'), false);
  });

  it('不认时间戳残缺或异形的名字', () => {
    for (const bad of [
      'mihomo.2026-09-06.log', // 缺时间部分
      'mihomo.2026-9-6_10-00-00.log', // 月日未补零
      'mihomo.2026-09-06_10-00-00.log.bak', // 尾部多后缀
      'mihomo.2026-09-06_10-00-00.a.log', // 序号非数字
      'other.2026-09-06_10-00-00.log', // 前缀不符
    ]) {
      assert.equal(isArchiveLogFilename(bad), false, `不该认: ${bad}`);
    }
  });

  it('不认借前缀混入的路径成分（判据锚定整个文件名）', () => {
    assert.equal(isArchiveLogFilename('../mihomo.2026-09-06_10-00-00.log'), false);
    assert.equal(isArchiveLogFilename('sub/mihomo.2026-09-06_10-00-00.log'), false);
  });
});
