import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 端到端跑真实 CLI 的测试夹具，所有 commands/*.spec.ts 共用这一份。
 *
 * 隔离契约（CLAUDE.md 进程类测试纪律）：每次跑都给
 * - 临时 MIHOMO_CLI_DIR（数据目录互不干扰、finally 删除）
 * - 一次性 MIHOMO_CLI_DAEMON_LABEL（服务/reset 用例必须隔离 label——plist 在数据目录
 *   之外，真实 launchctl 写操作按 label 注册）
 * - NO_COLOR=1（断言不被颜色码干扰）
 *
 * 文件名不带 .spec 后缀：测试只收 .spec.ts 结尾的文件，本支撑模块不会被当套件执行。
 */

/** CLI 入口（src/index.ts），各 spec 不再各自推导路径 */
export const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.ts');

/** 端到端子进程默认超时：各 spec 曾漂移出 15/20/30/60s 四种，统一 20s（真网络用例自管） */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface CliFixture {
  dataDir: string;
  /** 与 dataDir 配套的一次性 launchd label */
  label: string;
  /** 删除临时数据目录（幂等） */
  cleanup: () => void;
}

/** 建一套隔离的 dataDir + label */
export function makeFixture(prefix = 'mihomo-cli-test'): CliFixture {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return {
    dataDir,
    label: `com.mihomo-cli.test.${path.basename(dataDir)}`,
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

export interface RunCliOptions {
  /** 额外 env，在标准隔离三件套之上展开（如 PATH 桩）；可覆盖任意继承键 */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  cwd?: string;
  input?: string;
}

/** 在 fixture 的隔离环境里跑一次真实 CLI，返回 spawnSync 结果（encoding 固定 utf8） */
export function runCli(args: string[], fixture: CliFixture, options: RunCliOptions = {}): SpawnSyncReturns<string> {
  const spawnOptions: SpawnSyncOptions = {
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    env: {
      ...process.env,
      MIHOMO_CLI_DIR: fixture.dataDir,
      MIHOMO_CLI_DAEMON_LABEL: fixture.label,
      NO_COLOR: '1',
      ...options.env,
    },
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (options.input !== undefined) spawnOptions.input = options.input;
  // encoding 固定 utf8，stdio 结果必为 string；spawnSync 的字符串重载只对字面量 options
  // 生效，动态构造的 SpawnSyncOptions 推断成 string|Buffer，这里收窄回事实类型
  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY, ...args], spawnOptions) as SpawnSyncReturns<string>;
}

/**
 * 在隔离子进程里读停止计数（PATHS 在模块加载时固化 MIHOMO_CLI_DIR，必须起子进程；
 * 用 service.ts 的真实 readStopEpoch，不在测试里另抄一份解析）。
 * stop.spec 与 reset.spec 的 epoch 断言共用。
 */
export function readEpochIn(dataDir: string): number {
  const code = `const { readStopEpoch } = await import(${JSON.stringify(moduleUrl('src/service.ts'))}); process.stdout.write(String(readStopEpoch()));`;
  const r = runModule(code, dataDir, { env: { MIHOMO_CLI_ALLOW_ANY_PLATFORM: '1' } });
  if (r.status !== 0) throw new Error(`读取 epoch 子进程失败: ${r.stderr}`);
  return Number.parseInt(r.stdout.trim(), 10);
}

/** 源码模块的 file URL，供 runModule 的 code 里 `await import(...)` 拼进模板字符串 */
export function moduleUrl(rel: string): string {
  return pathToFileURL(path.resolve(rel)).href;
}

export interface RunModuleOptions {
  /** 额外 env，在 MIHOMO_CLI_DIR 之上展开（如 MIHOMO_CLI_ALLOW_ANY_PLATFORM、PATH 桩） */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

/**
 * 在隔离子进程里跑一段「import 真实源码模块」的脚本：PATHS 等在模块加载期就固化
 * MIHOMO_CLI_DIR 的模块（settings/paths/service…）必须这样测，同进程内改环境变量无效。
 * 与 runCli 的三件套不同：不经 CLI 入口，label/NO_COLOR 无意义，env 只继承 + 覆盖
 * MIHOMO_CLI_DIR。失败不代为断言——调用方对子进程失败的预期各异（有的断 status、
 * 有的要读 stdout），统一抛错会拦掉「子进程里预期失败」的用例。
 */
export function runModule(code: string, dataDir: string, options: RunModuleOptions = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ['--import', 'tsx', '-e', code], {
    encoding: 'utf8',
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    env: { ...process.env, MIHOMO_CLI_DIR: dataDir, ...options.env },
  }) as SpawnSyncReturns<string>;
}
