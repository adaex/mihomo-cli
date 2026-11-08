import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { compareVersions } from 'compare-versions';
import { assertKnownFlags, assertPositionalCount } from '../argv.js';
import { colors } from '../colors.js';
import { PKG_NAME, VERSION } from '../constants.js';
import { CliError } from '../errors.js';
import { parseProxyEndpoint, stripSelfProxyEnv } from '../proxy-env.js';
import { withSpinner } from '../spinner.js';

const execFileAsync = promisify(execFile);

/** 探活超时：只探本机回环端口，正常毫秒级；500ms 封顶且失败按「不可用」（不拖慢 doctor） */
const PROXY_PROBE_TIMEOUT_MS = 500;

/**
 * TCP 探测本机代理端口是否在监听。0.0.0.0/:: 是 env 自指的合法写法（见 isLoopbackHost），
 * connect 语义在各平台不一，探测时归一到确定的回环地址。
 */
export function isProxyPortListening(host: string, port: number): Promise<boolean> {
  const targetHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return new Promise(resolve => {
    const socket = net.connect({ host: targetHost, port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(PROXY_PROBE_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 构造 npm 子进程 env（D9）：env 里指向本机 Mixed 的自指代理，端口在监听（内核在跑）就
 * 原样保留——update/doctor 的 npm 全程不碰内核，无下载死锁，国内靠自己代理出网的用户
 * 不该被剥掉；端口不通（env 残留/内核已停）则去掉，npm 直连。不凭空注入：没配 env
 * 代理的用户路径不变；.npmrc 显式 proxy 优先级高于 env，不受影响。每次调用独立探活：
 * view 与 install 之间可能隔着用户确认，代理状态允许变化。
 */
async function buildNpmSpawnEnv(): Promise<NodeJS.ProcessEnv> {
  const { env, removed } = stripSelfProxyEnv();
  // 被去掉的键同一时刻指向同一本机端口，取任一值探活即可
  const sample = Object.values(removed)[0];
  const endpoint = sample ? parseProxyEndpoint(sample) : null;
  if (endpoint && (await isProxyPortListening(endpoint.host, endpoint.port))) return { ...process.env };
  return env;
}

/** npm view 查询最新版的超时：网络不佳时降级为直接安装，不让用户干等 */
const NPM_VIEW_TIMEOUT_MS = 15_000;

/**
 * 查询 npm registry 上的最新版本；失败/超时返回 null（调用方降级为直接安装）。
 * doctor 复用时传更短的超时，体检不该被 registry 拖慢
 */
export async function getLatestNpmVersion(timeoutMs: number = NPM_VIEW_TIMEOUT_MS): Promise<string | null> {
  try {
    const env = await buildNpmSpawnEnv();
    const { stdout } = await execFileAsync('npm', ['view', PKG_NAME, 'version'], { timeout: timeoutMs, env });
    const version = stdout.trim().split('\n').pop()?.trim();
    return version || null;
  } catch {
    return null;
  }
}

/**
 * update 的版本决策内核（纯函数，cmdUpdate 与测试共用）：
 * - 'ahead'：当前领先 registry（预发/源码安装）——npm install 会静默降级，必须拦住
 * - 'current'：已是最新，跳过
 * - 'proceed'：落后、或版本号无法比较（非 semver）、或查询失败（null）——继续安装
 */
export function resolveUpdateAction(current: string, latest: string | null): 'ahead' | 'current' | 'proceed' {
  if (latest === null) return 'proceed';
  try {
    const cmp = compareVersions(current, latest);
    if (cmp > 0) return 'ahead';
    if (cmp === 0) return 'current';
  } catch {
    /* 版本号无法比较（非 semver），按「继续更新」处理 */
  }
  return 'proceed';
}

export async function cmdUpdate(args: string[] = []): Promise<void> {
  assertKnownFlags(args.slice(1), [], 'update');
  // 不接受位置参数：校验先于 npm 查询/安装等网络副作用
  assertPositionalCount(args, 0, 1, 'mihomo-cli update');
  console.log(`当前版本: ${colors.cyan(VERSION)}`);
  console.log('');
  const latest = await withSpinner('查询 npm 最新版本', getLatestNpmVersion);
  const action = resolveUpdateAction(VERSION, latest);

  if (action === 'ahead') {
    // latest 非空是 resolveUpdateAction 返回 'ahead' 的前提（TS 无法跨函数关联缩小，?? 防御）
    console.log(colors.yellow(`当前版本 (${VERSION}) 领先于 npm 最新版 (${latest ?? '未知'})，跳过更新（避免降级）`));
    console.log(colors.gray('如需强制重装: npm install -g mihomo-cli'));
    return;
  }
  if (action === 'current') {
    console.log(`已是最新版本 (${colors.green(VERSION)})，无需更新`);
    return;
  }
  if (latest) {
    console.log(`最新版本: ${colors.cyan(latest)}`);
  } else {
    console.log(colors.yellow('无法查询最新版本（网络问题？），将直接尝试重新安装'));
  }
  console.log('');

  console.log('正在更新 mihomo-cli...');
  console.log('');

  const installEnv = await buildNpmSpawnEnv();
  await new Promise<void>((resolve, reject) => {
    const npm = spawn('npm', ['install', '-g', PKG_NAME], { stdio: 'inherit', env: installEnv });

    npm.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new CliError('更新失败。若为权限问题（EACCES），请检查 npm 全局目录权限或使用 nvm 管理 Node', { exitCode: code || 1 }));
      }
    });

    npm.on('error', e => {
      const perm = e.message.includes('EACCES') || e.message.includes('permission');
      reject(perm ? new CliError('权限不足（EACCES），请检查 npm 全局目录权限或使用 nvm 管理 Node') : new CliError(`执行失败: ${e.message}`));
    });
  });

  try {
    const { stdout } = await execFileAsync('npm', ['list', '-g', PKG_NAME, '--json', '--depth=0']);
    const result = JSON.parse(stdout) as { dependencies?: { [k: string]: { version?: string } } };
    const newVersion = result.dependencies?.[PKG_NAME]?.version;

    console.log('');
    if (newVersion) {
      console.log(`更新完成，最新版本: ${colors.green(newVersion)}`);
    } else {
      console.log('更新完成');
    }
  } catch {
    console.log('');
    console.log('更新完成');
  }
}
