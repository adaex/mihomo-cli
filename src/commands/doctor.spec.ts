import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `mihomo-cli doctor`：端到端跑完整体检，锁「配置构建的 warnings 透传进体检输出」。
 *
 * 桩内核沿用 subscription-prepare.spec 的手法，只模拟 `-v`（取版本）与
 * `-t -d <dir> -f <file>`（原生校验协议），不调真实内核。MIHOMO_CLI_DIR 与
 * MIHOMO_CLI_DAEMON_LABEL 全部隔离：launchd 查询落在临时标签上自然「未安装」，
 * 端口与版本检查是环境相关的，不纳入断言。断言只看 stdout 内容与体检走完
 * （「体检完成」在抛错之前打印，它在场即证明全部检查项都跑到了）。
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(SRC_DIR, '..', 'index.ts');

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-doctor-'));
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
  fs.writeFileSync(
    path.join(dataDir, 'kernel', 'mihomo'),
    [
      '#!/bin/sh',
      '[ "$1" = "-v" ] && { echo "Mihomo Meta v1.19.13 darwin arm64"; exit 0; }',
      '[ "$1" = "-t" ] && [ "$2" = "-d" ] && [ "$4" = "-f" ] && [ -s "$5" ] || exit 7',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; stdout: string; output: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MIHOMO_CLI_DIR: dataDir,
      MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
      NO_COLOR: '1',
    },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout || '', output: `${r.stdout || ''}${r.stderr || ''}` };
}

describe('doctor：体检透传配置构建的 warnings', () => {
  it('校验通过但有合并提示时，warnings 逐条挂到配置构建项下', () => {
    // 覆写脚本 ctx.warn 的提示正是 buildResult.warnings 要暴露、而 doctor 此前丢弃的信号
    fs.writeFileSync(
      path.join(dataDir, 'overwrite.js'),
      'export default function (config, ctx) { ctx.warn("分组 TYPO-GROUP 未匹配到当前订阅中的同名元素，已跳过"); return true; }\n',
    );

    const { stdout, output } = run(['doctor']);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    // 检查项本身仍算通过（措辞带「通过内核校验」），提示不升级成失败
    assert.match(stdout, /配置构建: 当前订阅通过内核校验（mixed），另有 1 条配置提示/);
    // 多条 warnings 逐条进 notes：跳过详情带着补丁名与分组键，用户才能定位拼错的分组
    assert.match(stdout, /TYPO-GROUP/);
    assert.match(stdout, /未匹配到当前订阅中的同名元素/);
  });

  it('无提示时配置构建仍是一项干净的正常项', () => {
    const { stdout, output } = run(['doctor']);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /✓ 配置构建: 当前订阅通过内核校验（mixed）/);
    assert.ok(!stdout.includes('未匹配到当前订阅中的同名元素'), '无警告时不应出现跳过提示');
  });

  it('内核版本检查始终执行并渲染（ok/warn/skip 取决于 GitHub 可达性）', () => {
    // 桩内核报 v1.19.13：有网且上游更新时为 warn（当前 x，最新 y），不可达/超时为 skip，
    // 最新时为 ok——三态都合法，只锁「该项存在且在体检完成前跑到」，具体取值不写死
    const { stdout, output } = run(['doctor']);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /内核版本/);
  });
});

describe('doctor：内核面板自升级残留', () => {
  it('meta-update 存在时 warn 真残留，修复命令只删暂存目录', () => {
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-update'));

    const { stdout, output } = run(['doctor']);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.match(stdout, /内核自升级残留/);
    assert.match(stdout, /rm -rf .*meta-update/);
  });

  it('meta-backup 是上游设计保留的旧内核副本：不告警，按信息项给出独立删除口径', () => {
    // 回归：曾与中断暂存合并成一条「残留」warn——面板成功自升级一次后它就常在，
    // doctor 从此永久误报，且修复命令会把回滚备份一并 rm -rf（上游 update_core.go
    // 成功路径从不清理 meta-backup，已核对）
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-backup'));

    const { stdout, output } = run(['doctor']);
    assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
    assert.ok(!stdout.includes('内核自升级残留'), '备份不应按残留告警');
    assert.match(stdout, /内核自升级备份/);
    assert.match(stdout, /回滚/);
    assert.match(stdout, /rm -rf .*meta-backup/);
  });

  it('两者并存时各自成项，修复命令不含 meta-backup', () => {
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-backup'));
    fs.mkdirSync(path.join(dataDir, 'kernel', 'meta-update'));

    const { stdout, output } = run(['doctor']);
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
    const { stdout } = run(['doctor']);
    assert.ok(!stdout.includes('内核自升级残留'));
    assert.ok(!stdout.includes('内核自升级备份'));
  });
});

/**
 * npm registry 查询与本地检查重叠执行。
 *
 * 该查询是纯网络往返（真机实测约 780ms），而 doctor 其余全部检查加起来约 75ms——
 * 串在末尾就是让用户白等近一秒。
 *
 * **判据是两段区间真的交叠，不是总耗时低于某个阈值。** 先写的是墙钟版
 * （桩各睡 N 秒、断言总耗时 < 1.75N），连调两次阈值仍在整套并行跑时误红：
 * 实测单独跑 2.44s、与其他 suite 并行 2.93s、套件变大后又涨到 3.27–3.94s——
 * 墙钟同时受机器负载、`node --test` 的 suite 并发和 tsx 转译影响，阈值再怎么放宽
 * 都只是把误红概率往后推，而误红的表现是「并发结构坏了」这种指向完全错误的失败。
 *
 * 现在让两个桩各自把进入/退出时刻写进日志，直接断言 `npm` 的区间与内核 `-t` 的区间
 * 有交集。这与被测性质（两件事同时在跑）一一对应，且对机器快慢完全免疫：
 * 串行实现下两段必然首尾相接、交集为空，无论机器多慢都红。
 */
describe('doctor：npm 查询与本地检查并行', () => {
  /** 桩的睡眠时长：只需长到让两段区间的交叠可辨，不参与任何阈值判断 */
  const SLEEP_MS = 1_000;

  it('npm 查询与内核校验的执行区间真的交叠', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-doctor-bin-'));
    const timeline = path.join(binDir, 'timeline.log');
    try {
      // 两个桩用同一份记录格式：`<who> <start|end> <epoch 毫秒>`。
      // 取毫秒用 **node 自己**（`process.execPath`，跑测试的那个解释器）：
      // macOS 的 `date` 不支持 `%3N`（只到秒），而引入 python3 就是给测试加一个
      // 本仓其余用例都不需要的外部依赖——它们只用 macOS 自带的
      // bash/launchctl/pgrep 等。node 一定在，且路径确定
      const stamp = (who: string, phase: string) =>
        `${JSON.stringify(process.execPath)} -e "console.log('${who} ${phase} ' + Date.now())" >> ${JSON.stringify(timeline)}`;

      fs.writeFileSync(
        path.join(binDir, 'npm'),
        ['#!/bin/sh', '[ "$1" = "view" ] || exit 9', stamp('npm', 'start'), `sleep ${SLEEP_MS / 1000}`, stamp('npm', 'end'), 'echo 0.0.1', ''].join('\n'),
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(dataDir, 'kernel', 'mihomo'),
        [
          '#!/bin/sh',
          '[ "$1" = "-v" ] && { echo "Mihomo Meta v1.19.13 darwin arm64"; exit 0; }',
          `[ "$1" = "-t" ] && { ${stamp('kernel', 'start')}; sleep ${SLEEP_MS / 1000}; ${stamp('kernel', 'end')}; [ -s "$5" ] && exit 0; exit 7; }`,
          'exit 7',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'doctor'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          MIHOMO_CLI_DIR: dataDir,
          MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
          NO_COLOR: '1',
        },
        timeout: 60_000,
      });
      const output = `${r.stdout || ''}${r.stderr || ''}`;

      // 先确认两个桩都真的被调用了——否则「区间为空」也可能只是因为压根没执行，是假阳性
      assert.match(r.stdout || '', /配置构建: 当前订阅通过内核校验/, `内核校验未执行: ${output}`);
      assert.match(r.stdout || '', /CLI 版本/, `版本检查未执行: ${output}`);
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
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('doctor：内核版本查询超时不拖住进程退出', () => {
  // 回归：此前 withTimeout 只弃掉 promise，子进程的 stdio 管道仍占住事件循环——
  // gh 挂住时 doctor 报告打完后还要等满子进程自身超时（GH_API_TIMEOUT 10s）才退，
  // CI 里表现为「体检结论已打印却拿不到退出码」。修复后 abort 信号把子进程一并杀掉
  it('gh 查询挂住 → 4s 预算内中止子进程，体检照常完成且进程及时退出', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-doctor-ghbin-'));
    const timeline = path.join(binDir, 'timeline.log');
    try {
      // 桩 gh：--version 正常应答（hasGh 探测要过），api 查询挂 30s 不响应
      fs.writeFileSync(
        path.join(binDir, 'gh'),
        [
          '#!/bin/sh',
          '[ "$1" = "--version" ] && { echo "gh version 2.0.0"; exit 0; }',
          `echo "gh start $(date +%s)" > ${JSON.stringify(timeline)}`,
          'sleep 30',
          `echo "gh end $(date +%s)" >> ${JSON.stringify(timeline)}`,
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      // 桩 npm：CLI 更新检查的 npm view 也走真实网络（自身超时 15s），registry 慢时
      // 会与 9s 上界无关地拖长总时长——桩成即时应答，时长断言只反映 gh 查询路径
      fs.writeFileSync(path.join(binDir, 'npm'), ['#!/bin/sh', '[ "$1" = "view" ] && { echo "26.9.90"; exit 0; }', 'exit 9', ''].join('\n'), { mode: 0o755 });

      const started = Date.now();
      const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'doctor'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          MIHOMO_CLI_DIR: dataDir,
          MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
          NO_COLOR: '1',
        },
        timeout: 60_000,
      });
      const elapsed = Date.now() - started;
      const output = `${r.stdout || ''}${r.stderr || ''}`;

      // doctor 本身必须跑完（abort 只影响版本查询这一项，降级为 skip）
      assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
      assert.match(output, /内核版本|可更新/, `内核版本检查应在场: ${output}`);

      // 子进程被中途杀掉：桩的 end 时间戳不该出现（sleep 未跑完）
      const marks = fs.existsSync(timeline) ? fs.readFileSync(timeline, 'utf8') : '';
      assert.ok(marks.includes('gh start'), `桩 gh 应被调用: ${marks}`);
      assert.ok(!marks.includes('gh end'), `挂住的 gh 子进程应被 abort 杀掉而非跑满 sleep: ${marks}`);

      // 进程及时退出：修复前要等满弃置子进程的 10s 自身超时；4s abort + 检查余量给 9s
      assert.ok(elapsed < 9_000, `doctor 应在 abort 后及时退出（实际 ${elapsed}ms）`);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('doctor：CLI 版本比较的脏数据守卫', () => {
  /**
   * latest 非 semver（私有 registry、异常 npm 输出）时裸 compareVersions 会抛错、
   * 体检崩在任何输出打印之前——update.ts 的 resolveUpdateAction 有同款守卫，
   * 两侧口径应对齐。桩 npm 固定返回非法版本串。
   */
  it('latest 非 semver：按 skip 渲染，体检跑完不被击穿', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-doctor-dirtyver-bin-'));
    try {
      fs.writeFileSync(path.join(binDir, 'npm'), ['#!/bin/sh', '[ "$1" = "view" ] || exit 9', 'echo "26.10.99.!!not-semver"', ''].join('\n'), { mode: 0o755 });
      const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'doctor'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          MIHOMO_CLI_DIR: dataDir,
          MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dataDir)}`,
          NO_COLOR: '1',
        },
        timeout: 60_000,
      });
      const output = `${r.stdout || ''}${r.stderr || ''}`;
      assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
      assert.match(r.stdout || '', /无法比较/, `应有 skip 提示: ${output}`);
      assert.equal(r.status, 0, r.stderr);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe('doctor：坏订阅名不击穿体检', () => {
  /**
   * 手改 settings.json 写入路径形态的订阅名时，getSubscriptionRawConfigPath 抛
   * CliError——体检是诊断面（同列表面板的姿态），必须包成 fail 检查项继续跑完，
   * 不能在「订阅配置」项整体退出、后面的端口/连通性检查全不跑。
   */
  it('非法订阅名：订阅配置项报 fail，体检完成', () => {
    const dirty = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-doctor-badname-'));
    try {
      fs.mkdirSync(path.join(dirty, 'subscriptions'), { recursive: true });
      fs.mkdirSync(path.join(dirty, 'kernel'), { recursive: true });
      fs.writeFileSync(
        path.join(dirty, 'settings.json'),
        JSON.stringify({ subscriptions: [{ name: '../evil', url: 'https://example.com' }], active_subscription: '../evil' }),
      );
      const r = spawnSync(process.execPath, ['--import', 'tsx', ENTRY, 'doctor'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          MIHOMO_CLI_DIR: dirty,
          MIHOMO_CLI_DAEMON_LABEL: `com.mihomo-cli.test.${path.basename(dirty)}`,
          NO_COLOR: '1',
        },
        timeout: 60_000,
      });
      const output = `${r.stdout || ''}${r.stderr || ''}`;
      assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);
      assert.match(r.stdout || '', /订阅名称无效|订阅配置/, output);
      assert.notEqual(r.status, null);
    } finally {
      fs.rmSync(dirty, { recursive: true, force: true });
    }
  });
});
