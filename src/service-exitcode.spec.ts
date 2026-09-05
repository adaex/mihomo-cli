import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { waitUntilUnloaded } from './service.js';

/**
 * launchctl 退出码的语义回归。
 *
 * 只有 113（目标未找到）才等于「服务未装载」这个**正常状态**；112（域不存在）与
 * 125（请求非法）是「查询本身没成立」。把后者当成「未装载」是 v4.2.2 修掉的缺陷：
 * sudo 下 uid=0 → 域拼成 `gui/0` → launchctl 恒 125 → 服务被判为未装载 →
 * `stop` 静默跳过全部 launchctl 操作却报「已停止」，而 KeepAlive 把内核拉了回来。
 *
 * 断言直接调真实 launchctl，不写死数字对照表：这些码是 launchd 的实际行为，
 * 硬编码期望值而不验证等于把猜测写进测试。
 */
describe('launchctl 退出码语义', () => {
  const uid = process.getuid?.() ?? 0;

  it('不存在的 label → 113（未装载，属正常状态）', () => {
    const r = spawnSync('launchctl', ['print', `gui/${uid}/com.mihomo-cli.definitely-not-loaded`], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 113, '「服务未装载」的退出码应为 113');
  });

  it('gui/0 域（root 下会拼出的域）→ 非 113，必须与「未装载」区分开', () => {
    const r = spawnSync('launchctl', ['print-disabled', 'gui/0'], { encoding: 'utf8', timeout: 10_000 });

    assert.notEqual(r.status, 0, 'gui/0 不应查询成功');
    assert.notEqual(r.status, 113, 'gui/0 的失败码若等于 113，就无法与「未装载」区分，root 守卫的前提不成立');
  });

  it('当前用户域可正常查询（print-disabled 免 sudo）', () => {
    const r = spawnSync('launchctl', ['print-disabled', `gui/${uid}`], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, '用户域的 print-disabled 应免 sudo 且成功');
  });

  it('waitUntilUnloaded 对未装载目标立即通过（113 = 已卸载）', async () => {
    // 只读验证：该 label 保证未装载，print 首轮即 113，函数应立即返回而非轮询满 5s。
    // （此前该逻辑是 bash 脚本里的 while 循环，完全不可测；去 bash 化后可直接断言）
    const start = Date.now();
    await waitUntilUnloaded(`gui/${uid}/com.mihomo-cli.definitely-not-loaded`);
    assert.ok(Date.now() - start < 1000, '未装载目标应在首轮判定后立即返回');
  });
});
