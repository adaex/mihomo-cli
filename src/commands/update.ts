import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVersions } from 'compare-versions';
import { assertKnownFlags, assertPositionalCount } from '../argv.js';
import { colors } from '../colors.js';
import { PKG_NAME, VERSION } from '../constants.js';
import { CliError } from '../errors.js';
import { withSpinner } from '../spinner.js';

const execFileAsync = promisify(execFile);
/** npm view 查询最新版的超时：网络不佳时降级为直接安装，不让用户干等 */
const NPM_VIEW_TIMEOUT_MS = 15_000;

/**
 * 查询 npm registry 上的最新版本；失败/超时返回 null（调用方降级为直接安装）。
 * doctor 复用时传更短的超时，体检不该被 registry 拖慢
 */
export async function getLatestNpmVersion(timeoutMs: number = NPM_VIEW_TIMEOUT_MS): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('npm', ['view', PKG_NAME, 'version'], { timeout: timeoutMs });
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

  await new Promise<void>((resolve, reject) => {
    const npm = spawn('npm', ['install', '-g', PKG_NAME], { stdio: 'inherit' });

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
