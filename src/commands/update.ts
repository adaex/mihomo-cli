import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { compareVersions } from 'compare-versions';
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

export async function cmdUpdate(): Promise<void> {
  console.log(`当前版本: ${colors.cyan(VERSION)}`);
  console.log('');
  const latest = await withSpinner('查询 npm 最新版本', getLatestNpmVersion);

  if (latest) {
    try {
      const cmp = compareVersions(VERSION, latest);
      if (cmp > 0) {
        // 当前版本领先 registry（预发/源码安装）：npm install 会静默降级，必须拦住
        console.log(colors.yellow(`当前版本 (${VERSION}) 领先于 npm 最新版 (${latest})，跳过更新（避免降级）`));
        console.log(colors.gray('如需强制重装: npm install -g mihomo-cli'));
        return;
      }
      if (cmp === 0) {
        console.log(`已是最新版本 (${colors.green(VERSION)})，无需更新`);
        return;
      }
    } catch {
      // 版本号无法比较（非 semver），按「不等于 latest」继续更新
    }
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
