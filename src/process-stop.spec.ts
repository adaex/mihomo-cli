import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type FakeKernelLayout, isDead, killLeftovers, spawnFakeKernel, waitForPids, writeFakeKernelFiles } from './test-support/fake-kernel.js';

// paths.ts 在 import 期求值 MIHOMO_CLI_DIR，故必须先设环境变量再动态 import。
//
// **隔离靠的不是约定，是物理事实**：MAIN_INSTANCE_PATTERN 内嵌 kernel/runtime 的
// 绝对路径（见 process-probe.ts），指向 tmpdir 后 pgrep/pkill 匹配的字符串里就是
// `/var/folders/.../kernel/mihomo`——真实数据目录 `~/.mihomo-cli` 下的内核不可能命中。
// 故这些测试杀的只会是自己起的桩进程，不会碰用户正在跑的代理。全程免 sudo。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-kill-'));
process.env.MIHOMO_CLI_DIR = tmpDir;

const { PATHS, DIRS } = await import('./paths.js');
const { getMihomoPids, isRunning, MAIN_INSTANCE_PATTERN } = await import('./process-probe.js');
// 服务路径的收口函数（薄封装 cleanupAll + 三档处置）；此处只锁它的返回值契约
const { buildKernelCleanupScript, cleanupAll, cleanupKernelsOrThrow, stop, clearPid } = await import('./process-stop.js');
const { SUDO_TIMEOUT_MS } = await import('./sudo.js');

/** 桩内核布局：fake-kernel.ts 不静态 import paths（env 固化顺序），由这里传入 */
const fakeKernel: FakeKernelLayout = { binary: PATHS.mihomoBinary, dataDir: DIRS.data, configFile: PATHS.configFile };

before(() => {
  writeFakeKernelFiles({ binaries: [PATHS.mihomoBinary, PATHS.serviceBinary], configFile: PATHS.configFile, dirs: [DIRS.data] });
});

beforeEach(() => {
  killLeftovers(MAIN_INSTANCE_PATTERN);
});

after(() => {
  killLeftovers(MAIN_INSTANCE_PATTERN);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 隔离前提本身也要断言——它是这组测试「无侵入」的唯一依据。
 * 若哪天 pattern 改成不含绝对路径（如只匹配进程名 `mihomo-cli`），
 * 这些用例就会开始杀用户的真实内核，必须当场失败而不是静默扩大杀伤范围。
 */
describe('测试隔离前提', () => {
  it('pattern 内嵌隔离目录的绝对路径，不可能匹配到真实数据目录的内核', () => {
    assert.ok(MAIN_INSTANCE_PATTERN.includes(tmpDir), `pattern 必须锚定隔离目录，否则会误杀用户的真实内核: ${MAIN_INSTANCE_PATTERN}`);
    assert.equal(MAIN_INSTANCE_PATTERN.includes(path.join(os.homedir(), '.mihomo-cli')), false);
  });

  it('未起桩进程时探测为空（确认没串到别的进程）', () => {
    assert.deepEqual(getMihomoPids(), []);
  });
});

/**
 * cleanupAll 的副作用路径。此前只有纯函数被覆盖，「真的杀掉进程」这一段
 * 全靠手工验证——而 v4.2.1 的 pattern 编译失效正是从这里漏过去的。
 */
describe('cleanupAll 真实杀进程', () => {
  it('杀掉单个桩进程并如实计数', async () => {
    const pid = spawnFakeKernel(fakeKernel);
    waitForPids(1, getMihomoPids);

    const result = await cleanupAll();

    assert.equal(result.killed, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.remaining, []);
    assert.equal(result.scriptError, null, '用户态清理不应产生 sudo 脚本错误');
    assert.equal(result.pidError, null, '用户态 pid 文件无需提权');
    assert.equal(getMihomoPids().length, 0, '进程必须真的没了，不是「调用没报错」');
    assert.ok(isDead(pid), '桩进程应已不存在（僵尸也算死，kill -0 在这里会骗人）');
  });

  it('走批量 pkill 分支（>3 个）时同样全部杀掉', async () => {
    for (let i = 0; i < 4; i++) spawnFakeKernel(fakeKernel);
    const before = waitForPids(4, getMihomoPids);
    assert.equal(before.length, 4, `应有 4 个桩进程，实际 ${before.length}`);

    const result = await cleanupAll();

    assert.equal(result.killed, 4);
    assert.equal(result.failed, 0);
    assert.equal(getMihomoPids().length, 0);
  });

  it('符号链形态的命令行也被匹配到并杀掉（服务路径的进程形态）', async () => {
    spawnFakeKernel(fakeKernel, PATHS.serviceBinary);
    waitForPids(1, getMihomoPids);

    const result = await cleanupAll();

    assert.equal(result.killed, 1);
    assert.equal(getMihomoPids().length, 0);
  });

  it('无进程时不报错，killed 为 0', async () => {
    const result = await cleanupAll();
    assert.equal(result.killed, 0);
    assert.equal(result.failed, 0);
  });

  it('清掉 pid 文件（有进程路径的末尾收口；残留会让后续 start 撞上死胡同）', async () => {
    spawnFakeKernel(fakeKernel);
    waitForPids(1, getMihomoPids);
    fs.writeFileSync(PATHS.pidFile, '99999');
    const result = await cleanupAll();
    assert.equal(fs.existsSync(PATHS.pidFile), false);
    assert.equal(result.pidError, null, '用户态 pid 文件无需提权');
  });

  it('零进程时同样清掉 pid 文件（免提权清理、不弹密码）', async () => {
    // pid 文件在 runtime/（用户属主目录、无 sticky bit），unlink 不看文件属主——
    // 零进程清它没有任何提权代价，删不掉才要警告（root 属主 + sudo 的旧路径已删）。
    // 本用例造不出 root 属主文件，「文件自身权限无关」的同构验证见下方 clearPid 组
    fs.writeFileSync(PATHS.pidFile, '99999');
    const result = await cleanupAll();
    assert.equal(result.killed, 0);
    assert.equal(fs.existsSync(PATHS.pidFile), false, '零进程分支也要清 pid 文件');
    assert.equal(result.scriptError, null);
    assert.equal(result.pidError, null);
  });
});

/**
 * cleanupKernelsOrThrow 的返回值契约：stop/uninstall/reset 消费它透传的 remaining
 * 做外层残留判定，不再重新 pgrep 或重跑 cleanupAll（曾导致 reset 每轮清理两遍、
 * warn 打印两份）。零进程 ok 档在此可免 sudo 直跑；throw/warn 判据本身是纯函数，
 * 已在 service.spec 经 classifyResidueCleanup 锁定
 */
describe('cleanupKernelsOrThrow：返回 cleanupAll 结果供外层消费', () => {
  it('零残留时返回空结果且不抛错', async () => {
    const result = await cleanupKernelsOrThrow({ mainOutcome: '测试主体动作', retryCommand: 'mihomo-cli stop' });
    assert.deepEqual(result.remaining, []);
    assert.equal(result.scriptError, null);
    assert.equal(result.pidError, null);
  });
});

/**
 * clearPid 免提权的 POSIX 判据：unlink 一个目录项只查**父目录**的写权限，与文件
 * 自身的写位、属主都无关。root 属主文件无法在非特权测试里 chown 制造，可自动化的
 * 同构事实是把文件置为只读（0444，自身不可写）——父目录 runtime/ 可写时照样删掉。
 * 文件「写位」与「属主」对删除都不构成条件，root 属主的 TUN 残留与此同构。
 */
describe('clearPid 免提权：删除只看父目录，不看文件自身', () => {
  it('文件自身只读（0444）仍删除成功', () => {
    fs.writeFileSync(PATHS.pidFile, '99999', { mode: 0o444 });
    assert.equal(fs.existsSync(PATHS.pidFile), true);
    assert.equal(clearPid(), null, '只读文件不应产生删除错误（unlink 查父目录而非文件写位）');
    assert.equal(fs.existsSync(PATHS.pidFile), false, '文件必须真的没了，不是「调用没报错」');
  });

  it('文件本就不存在按干净状态处理（返回 null，不报错）', () => {
    fs.rmSync(PATHS.pidFile, { force: true });
    assert.equal(clearPid(), null);
  });
});

/**
 * root 残留清理脚本的退出码协议：脚本内部失败用 2，
 * 1 留给 sudo 鉴权取消/密码错误（runSudoScript 的映射依赖这个分工）。
 * 脚本**只 pkill、不碰 pid 文件**：pid 收口唯一在 cleanupAll 末尾（复核 remaining
 * 为空才免提权删），提权脚本里任何 rm 都会绕过「活进程不删真相源」的防线。
 */
describe('buildKernelCleanupScript：root 残留清理脚本协议', () => {
  const script = buildKernelCleanupScript();

  it('脚本只 pkill，不含任何 rm（pid 收口唯一在 cleanupAll 末尾）', () => {
    assert.match(script, /pkill -9 -f/);
    assert.doesNotMatch(script, /\brm\b/, '提权脚本删 pid = 绕过「活进程不删 isRunning 真相源」的唯一防线');
  });

  it('pkill 异常退出（2/3）报 exit 2，脚本内不出现裸 exit 1', () => {
    assert.match(script, /exit 2/);
    assert.doesNotMatch(script, /\bexit 1\b/);
  });

  it('pkill 无匹配（退出码 1）按成功处理', () => {
    assert.match(script, /\[\s*\$rc -le 1\s*\]/);
  });
});

describe('stop 真实停止', () => {
  it('有进程时杀干净并清理 runtime', async () => {
    spawnFakeKernel(fakeKernel);
    waitForPids(1, getMihomoPids);
    fs.writeFileSync(PATHS.pidFile, '1');

    const result = await stop();

    assert.equal(result.remaining, undefined, '杀干净时结果不带残留集合');
    assert.equal(getMihomoPids().length, 0);
    assert.equal(fs.existsSync(PATHS.pidFile), false);
  });

  it('无进程时不谎报杀掉了什么（无 remaining）；用户态 pid 文件顺手清掉', async () => {
    fs.writeFileSync(PATHS.pidFile, '99999');
    const result = await stop();
    assert.equal(result.remaining, undefined, '零进程分支没有残留集合可报告');
    assert.equal(fs.existsSync(PATHS.pidFile), false, '游离 stop 的零进程分支要清用户态 pid 文件');
  });

  // stop 会 rmrf runtime/，后续用例依赖 configFile 存在
  after(() => {
    writeFakeKernelFiles({ binaries: [], configFile: PATHS.configFile });
  });
});

/**
 * isRunning 不裸信 pid 文件——系统重启后 PID 会被无关进程复用，
 * 只看存活会把别的进程误判成运行中的 mihomo。
 */
describe('isRunning 的 PID 复用防线', () => {
  it('pid 文件指向无关进程（本测试进程自己）时判为未运行', () => {
    fs.writeFileSync(PATHS.pidFile, String(process.pid));
    assert.equal(isRunning(), false, 'node 进程的命令行不含内核路径，不该被认成内核');
    clearPid();
  });

  it('pid 文件指向真实桩内核时判为运行中', async () => {
    const pid = spawnFakeKernel(fakeKernel);
    waitForPids(1, getMihomoPids);
    fs.writeFileSync(PATHS.pidFile, String(pid));

    assert.equal(isRunning(), true);

    await cleanupAll();
  });

  it('pid 文件指向已死进程时判为未运行', () => {
    fs.writeFileSync(PATHS.pidFile, '999999');
    assert.equal(isRunning(), false);
    clearPid();
  });
});

/**
 * 交互式（会弹密码的 stdio:'inherit' spawnSync）超时必须引用 SUDO_TIMEOUT_MS（与
 * runSudoScript 同一常量）。spawnSync 的 options 在模块私有函数内部构造，测试进程无法
 * 拦截参数本身；缺陷形态是「抄数字」——早于密码输完就把 sudo 连密码提示一起杀掉，
 * 用户被误判成「操作失败」。本文件现在只剩 killAllMihomo 一处免密 spawnSync（10s 合理），
 * 此断言作为回归哨兵保留：将来任何人再加交互式 spawnSync 都不得自抄超时。
 */
describe('sudo 分支超时统一', () => {
  it('交互式（stdio: inherit）调用的超时不得是字面数字，必须引用 SUDO_TIMEOUT_MS', () => {
    const source = fs.readFileSync(new URL('./process-stop.ts', import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /stdio:[^}]*timeout:\s*[\d_]/,
      '会弹密码的 spawnSync 自抄数字超时 = 密码输得慢的用户被杀掉提示、动作从未执行（引用 SUDO_TIMEOUT_MS）',
    );
    assert.ok(SUDO_TIMEOUT_MS > 15_000, '超时必须覆盖交互输密码的时长（回归值是 15s）');
  });
});
