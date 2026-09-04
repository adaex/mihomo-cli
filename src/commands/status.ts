import { colors } from '../colors.js';
import { getConfigInfo, getKernelVersion } from '../config.js';
import { isDaemonEnabled } from '../daemon.js';
import { isOverwriteEnabled, listOverwriteFile } from '../overwrite.js';
import { getRunningState } from '../runtime.js';
import { getSubscriptionsWithCache } from '../settings.js';
import { formatProxySummary, getActiveSubscription } from '../subscription.js';
import { formatTimestamp, formatTraffic } from '../utils.js';

export async function printStatus(): Promise<void> {
  const state = getRunningState();
  const info = getConfigInfo();
  const overwriteEnabled = isOverwriteEnabled();
  const overwriteFiles = listOverwriteFile().files;
  const activeSub = getActiveSubscription();

  // 运行状态/PID/内存由门面统一(保活看 launchd,普通看 pidFile);此处只负责展示。
  // 内核版本走 getKernelVersion()(带缓存、与运行模式无关),不再为它单独发一次 getStatus——
  // 此前同时调 getStatus() 与 getRunningState(),非保活模式下后者内部又调一遍,同一份查询跑两次
  const { running, pid, daemon: daemonManaged, processInfo } = state;

  console.log('');
  // 模式取自配置文件：未运行时也展示上次构建的模式（stop 会清配置，清了就不显示）
  let modeLabel = '';
  if (info) {
    modeLabel = colors.cyan(info.tun ? ' (TUN)' : ' (Mixed)') as string;
  }
  const statusText = running ? colors.green('● 运行中') : colors.yellow('不在运行');
  console.log(`${colors.gray('状态: ')}${statusText}${modeLabel}`);
  console.log(`${colors.gray('内核: ')}${getKernelVersion() || '未安装'}`);

  if (pid) {
    console.log(`${colors.gray('PID:  ')}${pid}`);
    if (!daemonManaged && processInfo) {
      console.log(`${colors.gray('内存: ')}${processInfo.memory}`);
    }
  }

  if (info) {
    if (info.tun) {
      // TUN 模式由虚拟网卡接管全局流量；mixed-port 仍在监听可作备用入口，一并标注
      const extra = info.mixedPort ? `，另监听 ${info.mixedPort}` : '';
      console.log(`${colors.gray('端口: ')}TUN 接管${extra}`);
    } else if (info.mixedPort) {
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
    // 订阅流量/到期来自缓存（上次下载响应头），仅缓存里有才展示
    const cached = getSubscriptionsWithCache().find(s => s.name === activeSub.name);
    const traffic = cached ? formatTraffic(cached.upload, cached.download, cached.total) : null;
    if (traffic) {
      console.log(`${colors.gray('流量: ')}${traffic}`);
    }
    if (cached?.expire !== undefined) {
      console.log(`${colors.gray('到期: ')}${formatTimestamp(cached.expire)}`);
    }
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
