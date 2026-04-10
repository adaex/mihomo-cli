import { DIRECTORY_TARGETS, DIRS, PATHS, USER_DATA_DIR } from '../paths.js';
import * as processManager from '../process.js';

export function cmdDirectory(args: string[]): void {
  const action = args?.[1];

  if (action === 'open') {
    const target = args[2];

    if (!target || target === 'root') {
      console.log('正在打开: 根目录');
      const success = processManager.openUrl(USER_DATA_DIR);
      if (!success) {
        console.log(`请手动打开: ${USER_DATA_DIR}`);
      }
      return;
    }

    const targetInfo = DIRECTORY_TARGETS[target.toLowerCase()];
    if (targetInfo) {
      const targetPath = targetInfo.path || USER_DATA_DIR;
      console.log(`正在打开: ${targetInfo.label}`);
      const success = processManager.openUrl(targetPath);
      if (!success) {
        console.log(`请手动打开: ${targetPath}`);
      }
      return;
    }

    console.error(`错误: 未知的目录目标 "${target}"`);
    console.log('');
    console.log('可用目标:');
    console.log('  root (默认)   根目录');
    for (const [key, val] of Object.entries(DIRECTORY_TARGETS)) {
      if (key !== 'root') {
        console.log(`  ${key.padEnd(14)}${val.label}`);
      }
    }
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log('数据目录位置:');
  console.log(`  根目录: ${USER_DATA_DIR}`);
  console.log(`  全局设置: ${PATHS.settingsFile}`);
  console.log(`  内核目录: ${DIRS.kernel}`);
  console.log(`  内核文件: ${PATHS.mihomoBinary}`);
  console.log(`  订阅目录: ${DIRS.subscriptions}`);
  console.log('    - cache.json (订阅缓存：更新时间、流量等)');
  console.log('    - xxx.yaml (订阅原始配置)');
  console.log(`  运行时目录: ${DIRS.runtime}`);
  console.log('    - config.yaml (启动时生成，stop 自动清除)');
  console.log('    - pid (PID 文件，stop 自动清除)');
  console.log(`  日志文件: ${PATHS.logFile}`);
  console.log(`  mihomo 数据: ${DIRS.data}`);
  console.log('    - cache.db, Geo*.dat 等 (mihomo 自行管理)');
  console.log('');
  console.log('打开目录:');
  console.log('  mihomo dir open                打开根目录');
  console.log('  mihomo dir open subs           打开订阅目录');
  console.log('  mihomo dir open logs           打开日志目录');
  console.log('  mihomo dir open runtime        打开运行时目录');
  console.log('  mihomo dir open kernel         打开内核目录');
  console.log('');
  console.log('环境变量:');
  console.log('  MIHOMO_CLI_DIR: 自定义根目录位置');
  console.log('');
}
