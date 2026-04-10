import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { colors, VERSION } from '../utils.js';

const execAsync = promisify(exec);

export async function cmdUpdate(): Promise<void> {
  console.log(`当前版本: ${colors.cyan(VERSION)}`);
  console.log('');
  console.log('正在更新 mihomo-cli...');
  console.log('');

  await new Promise<void>(resolve => {
    const npm = spawn('npm', ['install', '-g', 'mihomo-cli'], { stdio: 'inherit' });

    npm.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        process.exit(code || 1);
      }
    });

    npm.on('error', e => {
      console.error(`执行失败: ${e.message}`);
      process.exit(1);
    });
  });

  try {
    const { stdout } = await execAsync('npm list -g mihomo-cli --json --depth=0');
    const result = JSON.parse(stdout) as { dependencies?: { 'mihomo-cli'?: { version?: string } } };
    const newVersion = result.dependencies?.['mihomo-cli']?.version;

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
