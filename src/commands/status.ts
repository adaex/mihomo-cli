import { colors } from '../colors.js';
import { getConfigInfo } from '../config.js';
import { isDaemonEnabled } from '../daemon.js';
import { isOverwriteEnabled, listOverwriteFile } from '../overwrite.js';
import * as processManager from '../process.js';
import { getRunningState } from '../runtime.js';
import { getSshTunnels, getSubscriptionsWithCache } from '../settings.js';
import { getAllSshStatus } from '../ssh.js';
import { formatProxySummary, getActiveSubscription } from '../subscription.js';
import { formatBytes, formatTimestamp } from '../utils.js';

export async function printStatus(): Promise<void> {
  const status = processManager.getStatus();
  const state = getRunningState();
  const info = getConfigInfo();
  const overwriteEnabled = isOverwriteEnabled();
  const overwriteFiles = listOverwriteFile().files;
  const activeSub = getActiveSubscription();

  // 运行状态/PID 由门面统一(保活看 launchd,普通看 pidFile);此处只负责展示。
  const { running, pid, daemon: daemonManaged } = state;

  console.log('');
  // 模式取自配置文件：未运行时也展示上次构建的模式（stop 会清配置，清了就不显示）
  let modeLabel = '';
  if (info) {
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
    if (cached && (cached.download !== undefined || cached.total !== undefined)) {
      const used = (cached.upload || 0) + (cached.download || 0);
      let trafficLine = `${colors.gray('流量: ')}${formatBytes(used)} / ${formatBytes(cached.total)}`;
      if (cached.total && cached.total > 0) {
        trafficLine += ` (${Math.min((used / cached.total) * 100, 100).toFixed(1)}%)`;
      }
      console.log(trafficLine);
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

  // 隧道段：无隧道配置时零开销（不进 getAllSshStatus，也就不做任何端口探测）——
  // printStatus 同时是裸 `mihomo` 的入口，不能因为这个功能变慢
  const tunnels = getSshTunnels();
  if (tunnels.length > 0) {
    const statuses = await getAllSshStatus();
    const parts = statuses.map(s => {
      const label = `${s.config.name}:${s.config.port}`;
      if (s.state === 'running') return colors.green(label);
      // 假活必须与未运行区分：进程在、端口不通，mihomo 仍在往死端口送流量
      if (s.state === 'dead-port') return colors.yellow(`${label} 假活`);
      return colors.gray(label);
    });
    console.log(`${colors.gray('隧道: ')}${parts.join(', ')}`);
  }

  console.log('');
}
