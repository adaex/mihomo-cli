import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { describeSudoFailure, SudoAuthError, sudoExitToError } from './sudo.js';

/**
 * sudo 退出码映射的纯函数回归。真实 sudo 路径（密码提示、脚本执行）不自动测试
 * （见 CODE_REVIEW「自动化测试边界」），能锁住的是这份「退出码 → 错误」的分工协议：
 * 1 恒归 sudo 鉴权（用户主动取消的判据），脚本内部失败用 ≥2 并经 codeMessages 登记。
 */
describe('sudoExitToError：退出码到错误的分工协议', () => {
  it('退出码 1 → SudoAuthError（鉴权取消/密码错误），供包装层识别用户主动取消', () => {
    const e = sudoExitToError('清理遗留的系统级服务', 1);
    assert.ok(e instanceof SudoAuthError, '退出码 1 必须是 SudoAuthError，包装层按 instanceof 区分取消与失败');
    assert.equal(e.message, '已取消或密码错误');
  });

  it('codeMessages 即便登记了 1 也不生效：退出码 1 不归脚本', () => {
    // legacy-cleanup 脚本曾用 exit 1 报 bootout 真实失败，被映射成「已取消或密码错误」——
    // 用户密码明明输对了。此用例锁死「1 恒归鉴权」的优先级
    const e = sudoExitToError('清理遗留的系统级服务', 1, { 1: '脚本失败' });
    assert.ok(e instanceof SudoAuthError, 'codeMessages 不得抢走退出码 1 的鉴权语义');
  });

  it('登记过的脚本退出码（legacy-cleanup 的 3）映射到专属文案', () => {
    const e = sudoExitToError('清理遗留的系统级服务', 3, { 3: 'launchctl bootout 未能卸载旧 daemon（详见上方输出）' });
    assert.ok(!(e instanceof SudoAuthError), '脚本内部失败不得被误判成用户取消');
    assert.equal(e.message, 'launchctl bootout 未能卸载旧 daemon（详见上方输出）');
  });

  it('登记过的另一形态（TUN 的 2）同样生效', () => {
    const e = sudoExitToError('TUN 启动', 2, { 2: 'TUN 启动失败（详见上方日志）' });
    assert.equal(e.message, 'TUN 启动失败（详见上方日志）');
  });

  it('未登记的退出码落到「动作失败（退出码 N）」', () => {
    assert.equal(sudoExitToError('TUN 启动', 7).message, 'TUN 启动失败（退出码 7）');
  });

  it('status 为 null（sudo 被信号终止）单独描述，不与退出码混淆', () => {
    assert.equal(sudoExitToError('清理残留进程', null).message, '清理残留进程被中断（sudo 进程被信号终止）');
  });
});

describe('describeSudoFailure：警告文案的统一口径', () => {
  it('鉴权取消/密码错误归一为固定短语', () => {
    assert.equal(describeSudoFailure(new SudoAuthError()), 'sudo 已取消或密码错误');
  });

  it('其余失败保留原始 message——笼统的「sudo 执行失败」会把修复方式藏掉', () => {
    // 非 TTY 的真实错误自带「换交互终端」的指引，丢弃它用户就只剩瞎猜
    const e = new Error('当前环境无法输入管理员密码（需要在交互式终端运行 sudo）');
    assert.equal(describeSudoFailure(e), e.message);
  });
});

describe('runSudoScript 的脚本目录约定', () => {
  // 真实 sudo 不进自动化测试，脚本写入位置只能以源码结构断言锁定（与
  // process-stop.spec 对 SUDO_TIMEOUT_MS 的常量断言同款先例）：脚本必须写在
  // 数据根目录而非 runtime/——runtime 会被 stop/reset 整体 rmrf，密码窗口内
  // 被删会让 sudo 执行不存在的文件，错误被误诊成「密码错误」
  it('脚本写在数据根目录（USER_DATA_DIR），不落在会被整体删除的 runtime/', () => {
    const source = fs.readFileSync(new URL('./sudo.ts', import.meta.url), 'utf8');
    assert.ok(!source.includes('DIRS.runtime'), 'sudo 脚本不得写入 DIRS.runtime（stop/reset 会 rmrf 该目录，密码窗口内脚本会被连带删除）');
    assert.ok(source.includes('USER_DATA_DIR'), '脚本路径应派生自 USER_DATA_DIR（数据根目录）');
  });
});
