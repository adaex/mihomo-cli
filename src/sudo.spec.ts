import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { describeSudoFailure, SudoAuthError, sudoResultToError } from './sudo.js';

/** 真实 sudo 不自动执行；子进程结果可直接构造，错误分类仍按行为验证。 */
describe('sudoResultToError：子进程结果到错误的分工协议', () => {
  it('退出码 0 不报错', () => {
    assert.equal(sudoResultToError('TUN 启动', { status: 0 }), null);
  });

  it('退出码 1 → SudoAuthError，供包装层识别用户主动取消', () => {
    const e = sudoResultToError('清理残留进程', { status: 1 });
    assert.ok(e instanceof SudoAuthError);
    assert.equal(e.message, '已取消或密码错误');
  });

  it('codeMessages 即便登记了 1 也不生效：退出码 1 不归脚本', () => {
    const e = sudoResultToError('清理残留进程', { status: 1 }, { 1: '脚本失败' });
    assert.ok(e instanceof SudoAuthError);
  });

  it('登记过的脚本退出码映射到专属文案', () => {
    const e = sudoResultToError('清理残留进程', { status: 3 }, { 3: '终止残留内核失败（pkill 退出码异常）' });
    assert.ok(!(e instanceof SudoAuthError));
    assert.equal(e?.message, '终止残留内核失败（pkill 退出码异常）');
    const tun = sudoResultToError('TUN 启动', { status: 2 }, { 2: 'TUN 启动失败（详见上方日志）' });
    assert.equal(tun?.message, 'TUN 启动失败（详见上方日志）');
  });

  it('未登记的退出码落到通用失败', () => {
    assert.equal(sudoResultToError('TUN 启动', { status: 7 })?.message, 'TUN 启动失败（退出码 7）');
  });

  it('status null 描述外部信号终止', () => {
    assert.equal(sudoResultToError('清理残留进程', { status: null })?.message, '清理残留进程被中断（sudo 进程被信号终止）');
  });

  it('ETIMEDOUT 改抛本工具超时，不漏原始 spawnSync 错误', () => {
    const error = Object.assign(new Error('spawnSync sudo ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const e = sudoResultToError('清理残留进程', { status: null, error });
    assert.ok(!(e instanceof SudoAuthError));
    assert.match(e?.message ?? '', /^清理残留进程超时/);
    assert.ok(e?.message.includes('可能只完成了一部分'));
    assert.ok(!e?.message.includes('ETIMEDOUT'));
  });

  it('其他 spawn 错误原样透传', () => {
    const error = new Error('spawnSync sudo ENOENT');
    assert.equal(sudoResultToError('TUN 启动', { status: null, error }), error);
  });
});

describe('describeSudoFailure：警告文案的统一口径', () => {
  it('鉴权取消/密码错误归一为固定短语', () => {
    assert.equal(describeSudoFailure(new SudoAuthError()), 'sudo 已取消或密码错误');
  });

  it('其余失败保留原始 message', () => {
    const e = new Error('当前环境无法输入管理员密码（需要在交互式终端运行 sudo）');
    assert.equal(describeSudoFailure(e), e.message);
  });
});

describe('runSudoScript 的脚本目录约定', () => {
  // 脚本位置需要真实 sudo 才能端到端观察；这里只锁安全边界，不用源码匹配代替行为分类测试
  it('脚本写在数据根目录（USER_DATA_DIR），不落在会被整体删除的 runtime/', () => {
    const source = fs.readFileSync(new URL('./sudo.ts', import.meta.url), 'utf8');
    assert.ok(!source.includes('DIRS.runtime'), 'sudo 脚本不得写入 DIRS.runtime（stop/reset 会 rmrf 该目录）');
    assert.ok(source.includes('USER_DATA_DIR'), '脚本路径应派生自 USER_DATA_DIR（数据根目录）');
  });
});
