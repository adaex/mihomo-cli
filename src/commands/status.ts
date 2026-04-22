import { getConfigInfo } from '../config.js';
import { isOverwriteEnabled, listOverwriteFile } from '../overwrite.js';
import * as processManager from '../process.js';
import { formatProxySummary, getActiveSubscription } from '../subscription.js';
import { colors } from '../utils.js';

export function printStatus(): void {
  const status = processManager.getStatus();
  const info = getConfigInfo();
  const overwriteEnabled = isOverwriteEnabled();
  const overwriteFiles = listOverwriteFile().files;
  const activeSub = getActiveSubscription();

  console.log('');
  let modeLabel = '';
  if (info && status.running) {
    modeLabel = colors.cyan(info.tun ? ' (TUN)' : ' (Mixed)') as string;
  }
  const statusText = status.running ? colors.green('● 运行中') : colors.yellow('不在运行');
  console.log(`${colors.gray('状态: ')}${statusText}${modeLabel}`);
  console.log(`${colors.gray('内核: ')}${status.kernelVersion || '未安装'}`);

  if (status.pid) {
    console.log(`${colors.gray('PID:  ')}${status.pid}`);
    if (status.processInfo) {
      console.log(`${colors.gray('内存: ')}${status.processInfo.memory}`);
    }
  }

  if (info) {
    if (info.mixedPort) {
      console.log(`${colors.gray('端口: ')}${info.mixedPort}`);
    } else {
      const ports: string[] = [];
      if (info.httpPort) ports.push(`HTTP:${info.httpPort}`);
      if (info.socksPort) ports.push(`SOCKS:${info.socksPort}`);
      console.log(`${colors.gray('端口: ')}${ports.length > 0 ? ports.join(', ') : '未知'}`);
    }
  }

  if (activeSub) {
    let subLine = `${colors.gray('订阅: ')}${activeSub.name}`;
    if (info) {
      subLine += ` (${formatProxySummary(info)})`;
    }
    console.log(subLine);
  } else {
    console.log(`${colors.gray('订阅: ')}未配置`);
  }

  if (overwriteEnabled && overwriteFiles.length > 0) {
    const names = overwriteFiles.map(f => f.name.replace(/^overwrite\.?/, '').replace(/\.ya?ml$/, '') || '主文件').join(', ');
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (${names})`);
  } else if (overwriteEnabled) {
    console.log(`${colors.gray('覆写: ')}${colors.green('已启用')} (无文件)`);
  } else {
    console.log(`${colors.gray('覆写: ')}${colors.yellow('已禁用')}`);
  }
  console.log('');
}
