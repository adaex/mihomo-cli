import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { type CliFixture, makeFixture, runCli } from '../test-support/cli.js';
import { writeStubExecutable } from '../test-support/stub-bin.js';

/** 每例使用独立的数据目录、服务标签和命令桩，内核校验及版本查询均不访问真实内核或公网 */

let fixture: CliFixture;
let dataDir: string;
let binDir: string;

beforeEach(() => {
  fixture = makeFixture('mihomo-doctor');
  dataDir = fixture.dataDir;
  fs.mkdirSync(path.join(dataDir, 'subscriptions'));
  fs.mkdirSync(path.join(dataDir, 'kernel'));
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({
      subscriptions: [{ name: 'demo', url: 'https://example.com/sub?token=secret123' }],
      active_subscription: 'demo',
    }),
  );
  fs.writeFileSync(
    path.join(dataDir, 'subscriptions', 'demo.yaml'),
    [
      'proxies:',
      '  - { name: HK-1, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: pw }',
      'proxy-groups:',
      '  - { name: PROXY, type: select, proxies: [HK-1] }',
      'rules:',
      '  - MATCH,PROXY',
      '',
    ].join('\n'),
  );
  writeStubExecutable(
    path.join(dataDir, 'kernel', 'mihomo'),
    [
      '[ "$1" = "-v" ] && { echo "Mihomo Meta v1.19.13 darwin arm64"; exit 0; }',
      '[ "$1" = "-t" ] && [ "$2" = "-d" ] && [ "$4" = "-f" ] && [ -s "$5" ] || exit 7',
    ].join('\n'),
    '/bin/sh',
  );
  binDir = path.join(dataDir, 'bin');
  fs.mkdirSync(binDir);
  writeStubExecutable(path.join(binDir, 'npm'), '[ "$1" = view ] || exit 9\necho 0.0.1', '/bin/sh');
  writeStubExecutable(
    path.join(binDir, 'gh'),
    ['[ "$1" = --version ] && exit 0', '[ "$1" = api ] || exit 9', `echo '[{"tag_name":"v1.19.13","assets":[]}]'`].join('\n'),
    '/bin/sh',
  );
  writeStubExecutable(path.join(binDir, 'curl'), 'exit 9', '/bin/sh');
});

afterEach(() => {
  fixture.cleanup();
});

function runDoctor() {
  const { status, stdout, stderr } = runCli(['doctor'], fixture, { timeout: 60_000, env: { PATH: `${binDir}:${process.env.PATH}` } });
  return { status, stdout, stderr, output: `${stdout || ''}${stderr || ''}` };
}

describe('doctor：体检透传配置构建的 warnings', () => {
  it('校验通过但有合并提示时，warnings 逐条挂到配置构建项下', () => {
    fs.writeFileSync(
      path.join(dataDir, 'overwrite.js'),
      'export default function (config, ctx) { ctx.warn("分组 TYPO-GROUP 未匹配到当前订阅中的同名元素，已跳过"); }\n',
    );

    const { stdout, output } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    // 检查项本身仍算通过（措辞带「通过内核校验」），提示不升级成失败
    assert.match(stdout, /配置构建: 当前订阅通过内核校验（mixed），另有 1 条配置提示/);
    assert.match(stdout, /TYPO-GROUP/);
    assert.match(stdout, /未匹配到当前订阅中的同名元素/);
  });

  it('无提示时配置构建仍是一项干净的正常项', () => {
    const { stdout, output } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /✓ 配置构建: 当前订阅通过内核校验（mixed）/);
    assert.ok(!stdout.includes('未匹配到当前订阅中的同名元素'), '无警告时不应出现跳过提示');
  });

  it('未安装内核时不为版本检查启动 gh', () => {
    fs.unlinkSync(path.join(dataDir, 'kernel', 'mihomo'));
    const called = path.join(dataDir, 'gh.called');
    writeStubExecutable(path.join(binDir, 'gh'), 'touch "$MIHOMO_CLI_DIR/gh.called"; exit 9', '/bin/sh');
    assert.match(runDoctor().stdout, /体检完成/);
    assert.equal(fs.existsSync(called), false);
  });

  it('内核版本检查始终执行并渲染', () => {
    // 这里只检查报告包含版本项，不固定体检对各查询结果的措辞
    const { stdout, output } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /内核版本/);
  });
});

describe('doctor：内核面板自升级残留', () => {
  it('meta-update 存在时 warn 真残留，修复命令只删暂存目录', () => {
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-update'));

    const { stdout, output } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /内核自升级残留/);
    assert.match(stdout, /rm -rf .*meta-update/);
  });

  it('meta-backup 是上游设计保留的旧内核副本：不告警，按信息项给出独立删除口径', () => {
    // 回归：曾与中断暂存合并成一条「残留」warn——面板成功自升级一次后它就常在，
    // doctor 从此永久误报，且修复命令会把回滚备份一并 rm -rf（上游 update_core.go
    // 成功路径从不清理 meta-backup，已核对）
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-backup'));

    const { stdout, output } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.ok(!stdout.includes('内核自升级残留'), '备份不应按残留告警');
    assert.match(stdout, /内核自升级备份/);
    assert.match(stdout, /回滚/);
    assert.match(stdout, /rm -rf .*meta-backup/);
  });

  it('两者并存时各自成项，修复命令不含 meta-backup', () => {
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-backup'));
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-update'));

    const { stdout, output } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /内核自升级残留/);
    // 其他检查项（如服务未安装）也有「修复:」行，只认残留项之后紧跟的那条
    const lines = stdout.split('\n');
    const idx = lines.findIndex(l => l.includes('内核自升级残留'));
    const fixLine = lines.slice(idx + 1).find(l => l.includes('修复:'));
    assert.ok(fixLine, '残留项应带修复命令');
    assert.match(fixLine, /meta-update/);
    assert.ok(!fixLine?.includes('meta-backup'), '修复命令不得连带删除回滚备份');
  });

  it('无自升级目录时不出现这两项', () => {
    const { stdout } = runDoctor();
    assert.ok(!stdout.includes('内核自升级残留'));
    assert.ok(!stdout.includes('内核自升级备份'));
  });
});

/** 用两个桩各自的执行区间判断是否并行，不用整条命令的耗时代替 */
describe('doctor：npm 查询与本地检查并行', () => {
  /** 桩的睡眠时长：只需长到让两段区间的交叠可辨，不参与任何阈值判断 */
  const SLEEP_MS = 1_000;

  it('npm 查询与内核校验的执行区间真的交叠', () => {
    const timeline = path.join(dataDir, 'timeline.log');
    const stamp = (who: string, phase: string) =>
      `${JSON.stringify(process.execPath)} -e "console.log('${who} ${phase} ' + Date.now())" >> ${JSON.stringify(timeline)}`;

    writeStubExecutable(
      path.join(binDir, 'npm'),
      ['[ "$1" = "view" ] || exit 9', stamp('npm', 'start'), `sleep ${SLEEP_MS / 1000}`, stamp('npm', 'end'), 'echo 0.0.1'].join('\n'),
      '/bin/sh',
    );
    writeStubExecutable(
      path.join(dataDir, 'kernel', 'mihomo'),
      [
        '[ "$1" = "-v" ] && { echo "Mihomo Meta v1.19.13 darwin arm64"; exit 0; }',
        `[ "$1" = "-t" ] && { ${stamp('kernel', 'start')}; sleep ${SLEEP_MS / 1000}; ${stamp('kernel', 'end')}; [ -s "$5" ] && exit 0; exit 7; }`,
        'exit 7',
      ].join('\n'),
      '/bin/sh',
    );

    const { stdout, output } = runDoctor();

    // 先确认两个桩都真的被调用了——否则「区间为空」也可能只是因为压根没执行，是假阳性
    assert.match(stdout, /配置构建: 当前订阅通过内核校验/, `内核校验未执行: ${output}`);
    assert.match(stdout, /CLI 版本/, `版本检查未执行: ${output}`);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);

    const marks = new Map<string, number>();
    for (const line of fs.readFileSync(timeline, 'utf8').split('\n').filter(Boolean)) {
      const [who, phase, ms] = line.trim().split(/\s+/);
      marks.set(`${who}.${phase}`, Number(ms));
    }
    // 取值兼校验：缺任何一个都说明桩没被调到，此时报「时间线缺失」比报交集为 0 准确
    const at = (key: string): number => {
      const v = marks.get(key);
      assert.ok(typeof v === 'number' && Number.isFinite(v), `时间线缺少 ${key}：${fs.readFileSync(timeline, 'utf8')}`);
      return v;
    };

    // 交集 = min(两个 end) - max(两个 start)，> 0 即两段同时在跑
    const overlapMs = Math.min(at('npm.end'), at('kernel.end')) - Math.max(at('npm.start'), at('kernel.start'));
    assert.ok(overlapMs > 0, `npm 查询与内核校验未同时运行（交集 ${overlapMs}ms）：串行实现下两段首尾相接，交集必然 <= 0`);
  });
});

describe('doctor：内核版本查询超时不拖住进程退出', () => {
  // 回归：此前 withTimeout 只弃掉 promise，子进程的 stdio 管道仍占住事件循环——
  // gh 挂住时 doctor 报告打完后还要等满子进程自身超时（GH_API_TIMEOUT 10s）才退，
  // CI 里表现为「体检结论已打印却拿不到退出码」。修复后 abort 信号把子进程一并杀掉
  it('gh 查询挂住 → 4s 预算内中止子进程，体检照常完成且进程及时退出', () => {
    const timeline = path.join(dataDir, 'timeline.log');
    // 桩 gh：--version 正常应答（hasGh 探测要过），api 查询挂 30s 不响应
    writeStubExecutable(
      path.join(binDir, 'gh'),
      [
        '[ "$1" = "--version" ] && { echo "gh version 2.0.0"; exit 0; }',
        `echo "gh start $(date +%s)" > ${JSON.stringify(timeline)}`,
        'sleep 30',
        `echo "gh end $(date +%s)" >> ${JSON.stringify(timeline)}`,
        'exit 0',
      ].join('\n'),
      '/bin/sh',
    );

    const started = Date.now();
    const { output } = runDoctor();
    const elapsed = Date.now() - started;

    // doctor 本身必须跑完（abort 只影响版本查询这一项，降级为 skip）
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(output, /内核版本|可更新/, `内核版本检查应在场: ${output}`);

    // 子进程被中途杀掉：桩的 end 时间戳不该出现（sleep 未跑完）
    const marks = fs.existsSync(timeline) ? fs.readFileSync(timeline, 'utf8') : '';
    assert.ok(marks.includes('gh start'), `桩 gh 应被调用: ${marks}`);
    assert.ok(!marks.includes('gh end'), `挂住的 gh 子进程应被 abort 杀掉而非跑满 sleep: ${marks}`);

    // 进程及时退出：修复前要等满弃置子进程的 10s 自身超时；4s abort + 检查余量给 9s
    assert.ok(elapsed < 9_000, `doctor 应在 abort 后及时退出（实际 ${elapsed}ms）`);
  });
});

describe('doctor：CLI 版本比较的脏数据守卫', () => {
  /**
   * latest 非 semver（私有 registry、异常 npm 输出）时裸 compareVersions 会抛错、
   * 体检崩在任何输出打印之前——update.ts 的 resolveUpdateAction 有同款守卫，
   * 两侧口径应对齐。桩 npm 固定返回非法版本串。
   */
  it('latest 非 semver：按 skip 渲染，体检跑完不被击穿', () => {
    writeStubExecutable(path.join(binDir, 'npm'), '[ "$1" = "view" ] || exit 9\necho "26.10.99.!!not-semver"', '/bin/sh');
    const { stdout, stderr, status, output } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /无法比较/, `应有 skip 提示: ${output}`);
    assert.equal(status, 0, stderr);
  });
});

describe('doctor：坏订阅名不击穿体检', () => {
  /**
   * 手改 settings.json 写入路径形态的订阅名时，getSubscriptionRawConfigPath 抛
   * CliError——体检是诊断面（同列表面板的姿态），必须包成 fail 检查项继续跑完，
   * 不能在「订阅配置」项整体退出、后面的端口/连通性检查全不跑。
   */
  it('非法订阅名：订阅配置项报 fail，体检完成', () => {
    fs.unlinkSync(path.join(dataDir, 'kernel', 'mihomo'));
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ subscriptions: [{ name: '../evil', url: 'https://example.com' }], active_subscription: '../evil' }),
    );
    const { stdout, output, status } = runDoctor();
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /订阅名称无效|订阅配置/, output);
    assert.notEqual(status, null);
  });
});
