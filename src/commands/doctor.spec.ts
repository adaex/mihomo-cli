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
 * 串在末尾就是让用户白等近一秒。这条用例锁的是**并发结构**而非某次耗时：
 * 桩 npm 与桩内核各睡 SLEEP_MS，串行需 2×，重叠只需 1×，判据取两者中间。
 *
 * 桩 npm 经 PATH 前置注入（同 service-concurrency.spec 的手法，不碰真实 npm）；
 * 内核 `-t` 的 sleep 让「本地慢检查」有确定时长，否则本地部分太快、重叠省下的
 * 时间淹没在进程启动噪音里，断言就失去区分力。
 *
 * SLEEP_MS 取 2s 而非 1s：两条路径并非同时起跑（npm 先发，内核校验排在若干本地
 * 检查之后，实测错开约 0.4s），加上 tsx 转译与 Node 启动约 0.3s，1s 时实测落在
 * 1.46–1.49s、离 1.6s 阈值只剩 7% 余量，CI 上必然偶发误红。2s 时固定开销占比减半，
 * 实测约 2.5s vs 串行下界 4s，余量足够。代价是这条用例本身要跑 2.5s
 */
describe('doctor：npm 查询与本地检查并行', () => {
  const SLEEP_MS = 2_000;

  it('npm 查询与内核校验重叠，总耗时接近单个而非两者之和', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihomo-doctor-bin-'));
    try {
      // 桩 npm：只认 `view`，睡够时长后吐一个版本号；其余子命令不该被 doctor 调用
      fs.writeFileSync(path.join(binDir, 'npm'), ['#!/bin/sh', `[ "$1" = "view" ] || exit 9`, `sleep ${SLEEP_MS / 1000}`, 'echo 0.0.1', ''].join('\n'), {
        mode: 0o755,
      });
      // 桩内核的 -t 也睡同样时长，制造一个时长确定的本地慢检查
      fs.writeFileSync(
        path.join(dataDir, 'kernel', 'mihomo'),
        [
          '#!/bin/sh',
          '[ "$1" = "-v" ] && { echo "Mihomo Meta v1.19.13 darwin arm64"; exit 0; }',
          `[ "$1" = "-t" ] && { sleep ${SLEEP_MS / 1000}; [ -s "$5" ] && exit 0; exit 7; }`,
          'exit 7',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

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

      // 先确认两个桩都真的被调用了——否则「跑得快」只是因为压根没执行，是假阳性
      assert.match(r.stdout || '', /配置构建: 当前订阅通过内核校验/, `内核校验未执行: ${output}`);
      assert.match(r.stdout || '', /CLI 版本/, `版本检查未执行: ${output}`);
      assert.ok(output.includes('体检完成'), `体检未跑完: ${output}`);

      // 串行为 2×SLEEP_MS + 固定开销（实测约 450ms：Node/tsx 启动、两条路径错开起跑、
      // 其余本地检查），即下界约 4.45s；并行实测 2.44–2.47s 单独跑、2.93s 与其他 suite
      // 并行跑（node --test 会并发执行 describe）。取 1.75×（3.5s）卡在两者中间：
      // 距并行上沿 19%、距串行下界 21%，两侧余量对称。别再往下压——2.4s 的实测值配
      // 1.5×（3s）阈值只剩 2% 余量，CI 负载稍高就会误红，而误红的表现是「并发结构坏了」
      // 这种指向完全错误的失败
      assert.ok(elapsed < SLEEP_MS * 1.75, `npm 查询未与本地检查重叠：耗时 ${elapsed}ms，串行下界约 ${SLEEP_MS * 2}ms`);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
