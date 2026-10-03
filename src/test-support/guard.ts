import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach } from 'node:test';

import { ENTRY } from './cli.js';

/**
 * guard 类 spec（root/platform/node 守卫）的共享夹具，抽自三个 spec 原各自互抄的骨架：
 * 每用例一套临时目录（mkdtemp + rmSync）+「写预加载脚本 → 以 --import 它跑真实 CLI 入口」。
 *
 * 仓规「端到端夹具统一走 cli.ts」对 guard 类有豁免（CLAUDE.md）：守卫要在 CLI 逻辑运行前
 * 伪造进程身份/平台/Node 版本，只能靠 --import 预加载脚本；且豁免类用例要刻意不设
 * MIHOMO_CLI_DIR 或钉住 HOME——env 是整个替换而非叠加标准三件套。故单列本模块，不塞进 cli.ts。
 *
 * env 策略（root/platform 的 DIR+HOME、node 的三件套、platform 清逃生阀）三家各不同，
 * 留在各 spec 的 runAsXxx 包装里；preload 伪造语句同样是各守卫的私事，由调用点传入。
 *
 * 文件名不带 .spec 后缀：测试只收 .spec.ts 结尾的文件，本支撑模块不会被当套件执行。
 */

export interface GuardPreload {
  /** 预加载脚本文件名（写在 tmpDir 内，如 as-root.mjs） */
  name: string;
  /** 脚本全文（覆盖 getuid、defineProperty platform/versions 等伪造语句） */
  body: string;
}

export interface GuardRunOptions {
  /** 预加载脚本；省略则不伪造任何环境（root-guard「非豁免命令照常建目录」用例刻意如此） */
  preload?: GuardPreload;
  /** 完整替换的子进程 env（缺省继承当前 process.env，不叠加） */
  env?: NodeJS.ProcessEnv;
}

export interface GuardRunResult {
  status: number | null;
  output: string;
}

export interface GuardHarness {
  /** 本用例的临时目录：预加载脚本与 MIHOMO_CLI_DIR 的 data 子目录都住这里 */
  readonly tmpDir: string;
  /** 跑真实 CLI 入口（--import tsx [+ --import preload] ENTRY ...args），返回 status 与合并后的输出 */
  run: (args: string[], options?: GuardRunOptions) => GuardRunResult;
}

/** 守卫子进程超时：原三个 spec 统一 30s（tsx 冷启动 + 真实 CLI） */
const DEFAULT_GUARD_TIMEOUT_MS = 30_000;

/** 建一套 guard 夹具并挂 beforeEach/afterEach（在 spec 顶层调用一次） */
export function setupGuardFixture(prefix: string): GuardHarness {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  return {
    get tmpDir() {
      return tmpDir;
    },
    run(args, options = {}) {
      const imports = ['--import', 'tsx'];
      if (options.preload !== undefined) {
        const preloadPath = path.join(tmpDir, options.preload.name);
        fs.writeFileSync(preloadPath, options.preload.body);
        imports.push('--import', preloadPath);
      }
      const spawnOptions: SpawnSyncOptions = {
        encoding: 'utf8',
        timeout: DEFAULT_GUARD_TIMEOUT_MS,
        env: options.env,
      };
      // encoding 固定 utf8，stdio 结果必为 string；收窄理由同 cli.ts 的 runCli
      const r = spawnSync(process.execPath, [...imports, ENTRY, ...args], spawnOptions) as SpawnSyncReturns<string>;
      return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
    },
  };
}
