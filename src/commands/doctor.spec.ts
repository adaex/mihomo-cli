import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `mihomo doctor`：端到端跑完整体检，锁「配置构建的 warnings 透传进体检输出」。
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
    // 分组名拼错的 ~? 补丁会被跳过——正是 buildResult.warnings 要暴露、而 doctor 此前丢弃的信号
    fs.writeFileSync(path.join(dataDir, 'overwrite.yaml'), '~?proxy-groups:\n  - { name: TYPO-GROUP, type: select, proxies: [HK-1] }\n');

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
