import { getConfigInfo } from '../config.js';
import { isDaemonEnabled } from '../daemon.js';
import { isOverwriteEnabled, listOverwriteFile } from '../overwrite.js';
import * as processManager from '../process.js';
import { getRunningState } from '../runtime.js';
import { formatProxySummary, getActiveSubscription } from '../subscription.js';
import { colors } from '../utils.js';

export function printStatus(): void {
  const status = processManager.getStatus();
  const state = getRunningState();
  const info = getConfigInfo();
  const overwriteEnabled = isOverwriteEnabled();
  const overwriteFiles = listOverwriteFile().files;
  const activeSub = getActiveSubscription();

  // 运行状态/PID 由门面统一(保活看 launchd,普通看 pidFile);此处只负责展示。
  const { running, pid, daemon: daemonManaged } = state;

  console.log('');
  let modeLabel = '';
  if (info && running) {
    modeLabel = colors.cyan(info.tun ? ' (TUN)' : ' (Mixed)') as string;
  }
  const statusText = running ? colors.green('● 运行中') : colors.yellow('不在运行');
  console.log(`${colors.gray('状态: ')}${statusText}${modeLabel}`);
  console.log(`${colors.gray('内核: ')}${status.kernelVersion || '未安装'}`);

  if (pid) {
    console.log(`${colors.gray('PID:  ')}${pid}`);
    if (!daemonManaged && status.processInfo) {
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

  if (isDaemonEnabled()) {
    console.log(`${colors.gray('保活: ')}${colors.green('已启用')} ${colors.gray('(开机自启 + 崩溃重启)')}`);
  }
  console.log('');
}
