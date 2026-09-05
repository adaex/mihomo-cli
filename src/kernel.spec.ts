import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findMatchingAsset } from './kernel.js';
import type { GitHubAsset } from './types.js';

/** GitHub API 的 assets 按名称排序返回——fixture 顺序即 find() 的命中顺序，勿重排 */
const asset = (name: string): GitHubAsset => ({
  name,
  browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.30/${name}`,
  size: 1,
});

// MetaCubeX/mihomo v1.19.30 的 darwin 资产名（实测）。amd64 侧同时存在 GOAMD64
// 微架构变体（-v1/-v3）与 -compatible 变体；按名称排序 `-`(0x2D) < `.`(0x2E)，
// `mihomo-darwin-amd64-v1-v1.19.30.gz` 排在标准版 `mihomo-darwin-amd64-v1.19.30.gz` 之前
const DARWIN_ASSETS = [
  'mihomo-darwin-amd64-compatible-v1.19.30.gz',
  'mihomo-darwin-amd64-v1-v1.19.30.gz',
  'mihomo-darwin-amd64-v1.19.30.gz',
  'mihomo-darwin-amd64-v3-v1.19.30.gz',
  'mihomo-darwin-arm64-compatible-v1.19.30.gz',
  'mihomo-darwin-arm64-v1.19.30.gz',
  'mihomo-darwin-arm64-v1.19.30.zip',
].map(asset);

describe('findMatchingAsset（标准版形态精确匹配）', () => {
  it('Intel Mac 不选按名称排序靠前的 -v1 微架构变体（baseline 构建，性能最低档）', () => {
    // 回归：旧判据只黑名单 -go/-compatible，-v1 变体同样以版本号结尾、能通过全部检查，
    // 而它排在标准版之前被 find() 优先命中——下载/大小校验/自检全过，静默装错变体
    const picked = findMatchingAsset(DARWIN_ASSETS, 'darwin', 'amd64');
    assert.equal(picked?.name, 'mihomo-darwin-amd64-v1.19.30.gz');
  });

  it('不选 -compatible 变体（Intel 上性能低于标准版）', () => {
    const picked = findMatchingAsset(DARWIN_ASSETS, 'darwin', 'amd64');
    assert.notEqual(picked?.name, 'mihomo-darwin-amd64-compatible-v1.19.30.gz');
  });

  it('Apple Silicon 选标准版', () => {
    const picked = findMatchingAsset(DARWIN_ASSETS, 'darwin', 'arm64');
    assert.equal(picked?.name, 'mihomo-darwin-arm64-v1.19.30.gz');
  });

  it('非 .gz 资产（如 .zip）不参与匹配', () => {
    const picked = findMatchingAsset([asset('mihomo-darwin-arm64-v1.19.30.zip')], 'darwin', 'arm64');
    assert.equal(picked, null);
  });

  it('只有变体、无标准版时回退首个匹配（仍能装上可用内核）', () => {
    const picked = findMatchingAsset([asset('mihomo-darwin-amd64-v1-v1.19.30.gz'), asset('mihomo-darwin-amd64-v3-v1.19.30.gz')], 'darwin', 'amd64');
    assert.equal(picked?.name, 'mihomo-darwin-amd64-v1-v1.19.30.gz');
  });

  it('无匹配返回 null', () => {
    assert.equal(findMatchingAsset(DARWIN_ASSETS, 'linux', 'amd64'), null);
  });
});
