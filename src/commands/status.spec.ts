import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shortOverwriteName } from './status.js';

/**
 * 覆写短名的展示口径：主文件（YAML 与 JS 脚本三扩展）显示「主文件」，
 * 扩展文件显示功能段。26.9.93 引入 JS 脚本后此处一度只剥 yaml 扩展名，
 * overwrite.js 显示成 js、overwrite.dns.js 带 .js 尾巴，且无测试挡住——
 * 用例锁全所有受支持文件名形态。
 */
describe('shortOverwriteName', () => {
  const cases: Array<[string, string]> = [
    // YAML 主文件与扩展文件
    ['overwrite.yaml', '主文件'],
    ['overwrite.dns.yaml', 'dns'],
    ['overwrite.dns.yml', 'dns'],
    // JS 主脚本三扩展都是主文件
    ['overwrite.js', '主文件'],
    ['overwrite.mjs', '主文件'],
    ['overwrite.cjs', '主文件'],
    // JS 扩展脚本显示功能段，不带扩展名尾巴
    ['overwrite.custom.js', 'custom'],
    ['overwrite.globals.mjs', 'globals'],
    ['overwrite.x.cjs', 'x'],
  ];
  for (const [filename, expected] of cases) {
    it(`${filename} → ${expected}`, () => {
      assert.equal(shortOverwriteName(filename), expected);
    });
  }
});
