import path from 'node:path';

import { isOverwriteEnabled, listOverwriteFile, setOverwriteEnabled } from '../overwrite.js';
import * as runtime from '../runtime.js';
import { colors } from '../utils.js';
import { cmdStart } from './start.js';

function printOverwriteList(): void {
  const info = listOverwriteFile();
  const statusText = info.enabled ? colors.green('已启用') : colors.yellow('已禁用');
  console.log(`${colors.gray('状态: ')}${statusText}`);
  console.log(`${colors.gray('位置: ')}${info.dir}`);
  console.log('');
  if (info.files.length === 0) {
    console.log('暂无覆写文件');
    console.log('');
    console.log(`用法示例: 创建文件 ${path.join(info.dir, 'overwrite.yaml')}`);
    console.log(`         或        ${path.join(info.dir, 'overwrite.dns.yaml')}`);
    console.log('');
  } else {
    console.log(`${colors.cyan('覆写文件')} (${info.files.length} 个，按顺序加载):`);
    console.log('');
    info.files.forEach((f, i) => {
      const num = i < 10 ? ` ${i}` : `${i}`;
      console.log(`  ${num}. ${f.name}`);
      if (f.keys.length > 0) {
        console.log(`    ${colors.gray('字段: ')}${f.keys.join(', ')}`);
      }
    });
    console.log('');
  }
  console.log('启用覆写: mihomo ow on');
  console.log('禁用覆写: mihomo ow off');
  console.log('');
}

export async function cmdOverwrite(args: string[]): Promise<void> {
  const action = args?.[1];

  // 保活恒为 Mixed;否则保留当前模式(避免残留 tun 字段误判);运行中(含保活)才需重启使覆写生效。
  const currentMode = runtime.getRuntimeMode();
  const restartNeeded = runtime.isRestartNeededOnChange();

  if (action === 'on' || action === 'enable') {
    if (isOverwriteEnabled()) {
      console.log('覆写配置已是启用状态');
      console.log('');
      printOverwriteList();
      return;
    }

    setOverwriteEnabled(true);
    console.log('已启用覆写配置');

    if (restartNeeded) {
      console.log('');
      await cmdStart(['start', currentMode]);
      return;
    }

    console.log('');
    printOverwriteList();
    return;
  }

  if (action === 'off' || action === 'disable') {
    if (!isOverwriteEnabled()) {
      console.log('覆写配置已是禁用状态');
      console.log('');
      printOverwriteList();
      return;
    }

    setOverwriteEnabled(false);
    console.log('已禁用覆写配置');

    if (restartNeeded) {
      console.log('');
      await cmdStart(['start', currentMode]);
      return;
    }

    console.log('');
    printOverwriteList();
    return;
  }

  console.log('');
  printOverwriteList();
}
