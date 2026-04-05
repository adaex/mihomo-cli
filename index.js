#!/usr/bin/env node

const { spawn } = require('child_process');

const config = require('./src/config');
const kernel = require('./src/kernel');
const subscription = require('./src/subscription');
const processMgr = require('./src/process');

const VERSION = '1.0.0-alpha.1';

const UI_URLS = {
  zash: 'https://board.zash.run.place',
  dash: 'https://metacubex.github.io/metacubexd',
  yacd: 'https://yacd.metacubex.one',
};

let exiting = false;

process.on('SIGINT', () => {
  if (exiting) {
    console.log('\n  强制退出');
    process.exit(1);
  }
  exiting = true;
  console.log('\n  正在退出...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('uncaughtException', (e) => {
  console.error('\n  未捕获的异常: ' + e.message);
  if (e.stack) {
    console.error('  ' + e.stack.split('\n').slice(1).join('\n  '));
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('\n  未处理的 Promise 拒绝: ' + msg);
  process.exit(1);
});

function printHelp() {
  console.log('\nmihomo-cli v' + VERSION + '\n' +
    '\n' +
    '用法:\n' +
    '  mihomo-cli <命令> [选项]\n' +
    '\n' +
    '命令:\n' +
    '  start [tun|mixed]  启动代理 (默认 mixed)\n' +
    '  stop               停止代理\n' +
    '  restart [tun|mixed]  重启代理\n' +
    '  status             查看状态\n' +
    '  log                实时日志\n' +
    '  ui [zash|dash|yacd]  打开 Web UI (默认 zash)\n' +
    '  clean              清理残留进程\n' +
    '  kernel             更新内核\n' +
    '  sub add <url> [name]   添加订阅\n' +
    '  sub update [name]      更新订阅\n' +
    '  sub list              列出订阅\n' +
    '  reset [--full]        重置用户数据 (--full 同时删除内核)\n' +
    '  dirs                 显示数据目录位置\n' +
    '  help, -h           显示帮助\n' +
    '  version, -v        显示版本\n' +
    '\n' +
    '示例:\n' +
    '  mihomo-cli start           # 启动 Mixed 模式\n' +
    '  mihomo-cli start tun       # 启动 TUN 模式 (透明代理)\n' +
    '  mihomo-cli ui              # 打开默认 UI (zash)\n' +
    '  mihomo-cli ui dash         # 打开 metacubexd\n' +
    '  mihomo-cli ui yacd         # 打开 YACD\n' +
    '\n' +
    '模式说明:\n' +
    '  mixed  HTTP + SOCKS5 混合端口 (默认)\n' +
    '  tun    透明代理，全局自动路由，需要 sudo\n' +
    '\n' +
    '数据目录:\n' +
    '  环境变量 MIHOMO_CLI_DIR 可自定义位置\n' +
    '  默认: ' + config.USER_DATA_DIR + '\n');
}

function printVersion() {
  const kv = config.getKernelVersion() || '未安装';
  console.log('mihomo-cli v' + VERSION);
  console.log('内核: ' + kv);
  console.log('数据目录: ' + config.USER_DATA_DIR);
}

function printStatus() {
  const status = processMgr.getStatus();
  const info = subscription.getConfigInfo();

  console.log('');
  console.log('  状态: ' + (status.running ? '运行中' : '已停止'));
  if (status.pid) {
    console.log('  PID:  ' + status.pid);
    if (status.processInfo) {
      console.log('  内存: ' + status.processInfo.memory);
      if (status.processInfo.cpu) {
        console.log('  CPU:  ' + status.processInfo.cpu);
      }
    }
  }
  if (info) {
    console.log('  节点: ' + info.proxies);
    console.log('  端口: ' + info.port);
    console.log('  TUN:  ' + (info.tun ? '启用' : '未启用'));
  }
  console.log('  内核: ' + (status.kernelVersion || '未安装'));
  console.log('');
}

function getActiveSubscription() {
  const subs = config.getSubscriptions();
  if (subs.length === 0) {
    return null;
  }
  return subs[0];
}

async function cmdStart(args) {
  if (!config.hasKernel()) {
    console.error('  错误: 未找到内核，请运行 \'mihomo-cli kernel\'');
    process.exit(1);
  }

  const targetMode = args[1] === 'tun' ? 'tun' : 'mixed';

  const sub = getActiveSubscription();
  if (!sub) {
    console.error('  错误: 没有订阅，请先添加订阅');
    process.exit(1);
  }

  const pids = processMgr.getAllMihomoPids();
  if (pids.length > 0) {
    console.log('  检测到 ' + pids.length + ' 个运行中的进程，正在停止...');
    processMgr.stop(targetMode === 'tun');
    for (let i = 0; i < 50; i++) {
      if (processMgr.getAllMihomoPids().length === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  let cfgInfo;
  try {
    cfgInfo = subscription.prepareConfigForStart(targetMode, sub.name);
  } catch (e) {
    console.error('  配置错误: ' + e.message);
    process.exit(1);
  }

  const modeLabel = targetMode === 'tun' ? 'TUN' : 'Mixed';
  const groupsLabel = cfgInfo.proxyGroups ? cfgInfo.proxyGroups + ' 组' : '';
  const countLabel = groupsLabel ? (groupsLabel + ' ' + cfgInfo.proxies + ' 节点') : (cfgInfo.proxies + ' 节点');
  console.log('  ' + [modeLabel, sub.name, countLabel].join(' · '));

  try {
    const result = await processMgr.start(targetMode);
    console.log('  已启动 (PID ' + result.pid + ')');
  } catch (e) {
    console.error('  启动失败: ' + e.message.split('\n')[0]);
    process.exit(1);
  }
}

function doStop() {
  const pids = processMgr.getAllMihomoPids();
  if (pids.length === 0) {
    console.log('  未在运行');
    return { hasRunning: false, success: true };
  }

  console.log('  停止 ' + pids.length + ' 个进程...');
  const result = processMgr.stop(true);

  if (result.remaining && result.remaining.length > 0) {
    console.warn('  部分进程未终止: ' + result.remaining.join(', '));
    console.warn('    手动清理: sudo pkill -9 mihomo');
    return { hasRunning: true, success: false, remaining: result.remaining };
  }
  console.log('  已停止');
  return { hasRunning: true, success: true };
}

async function cmdStop() {
  const result = doStop();
  if (!result.success) {
    process.exit(1);
  }
}

async function cmdRestart(args) {
  const stopResult = doStop();
  console.log('');
  await cmdStart(args);
}

function cmdUi(args) {
  const uiName = args[1] || 'zash';
  const url = UI_URLS[uiName];

  if (!url) {
    console.error('  错误: 未知的 UI "' + uiName + '"');
    console.error('  可用 UI: zash (默认), dash, yacd');
    process.exit(1);
  }

  console.log('  打开 Web UI: ' + uiName);
  console.log('  地址: ' + url);

  const success = processMgr.openUrl(url);
  if (!success) {
    console.log('  请手动访问上面的地址');
  }
}

function cmdClean() {
  console.log('  清理残留进程...');
  const result = processMgr.cleanupAll();

  if (result.killed > 0) {
    console.log('  已清理 ' + result.killed + ' 个进程');
  }
  if (result.remaining && result.remaining.length > 0) {
    console.warn('  仍有 ' + result.remaining.length + ' 个进程需要手动清理');
    console.warn('    手动命令: sudo pkill -9 mihomo');
    process.exit(1);
  }
  if (result.killed === 0 && (!result.remaining || result.remaining.length === 0)) {
    console.log('  没有发现残留进程');
  }
}

function cmdLog() {
  const logPath = processMgr.getLogPath();
  console.log('  日志: ' + logPath);
  console.log('  按 Ctrl+C 退出\n');

  const tail = spawn('tail', ['-f', '-n', '50', logPath], {
    stdio: 'inherit',
  });

  tail.on('close', () => process.exit(0));
  tail.on('error', (e) => {
    console.error('  无法启动日志查看: ' + e.message);
    process.exit(1);
  });
}

async function cmdKernel() {
  console.log('  检查内核更新...');

  try {
    const info = await kernel.checkUpdate();
    console.log('  当前: ' + info.current);
    console.log('  最新: ' + info.latest);

    if (!info.needsUpdate) {
      console.log('  已是最新版本');
      return;
    }

    console.log('\n  正在下载...');
    const result = await kernel.downloadKernel((msg) => {
      console.log('  ' + msg);
    });
    console.log('  已更新到 ' + result.version);
  } catch (e) {
    console.error('  更新失败: ' + e.message);
    process.exit(1);
  }
}

async function cmdSub(args) {
  const action = args[1];

  if (!action || action === 'list') {
    const subs = config.getSubscriptions();
    if (subs.length === 0) {
      console.log('  没有订阅');
      console.log('\n  添加订阅:');
      console.log('    mihomo-cli sub add <url> [name]');
      return;
    }
    console.log('  订阅列表:');
    subs.forEach((s, i) => {
      const time = s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN') : '未更新';
      console.log('    ' + (i + 1) + '. ' + s.name + ' (' + time + ')');
    });
    console.log('\n  更新订阅:');
    console.log('    mihomo-cli sub update [name]');
    return;
  }

  if (action === 'add') {
    const url = args[2];
    const name = args[3] || 'default';

    if (!url || !url.startsWith('http')) {
      console.error('  错误: 请提供有效的订阅 URL');
      process.exit(1);
    }

    console.log('  添加订阅: ' + name);
    try {
      config.addSubscription(url, name);
      const info = await subscription.downloadSubscription(url, name);
      console.log('  已添加 (节点: ' + info.proxies + ')');
    } catch (e) {
      console.error('  添加失败: ' + e.message);
      process.exit(1);
    }
    return;
  }

  if (action === 'update') {
    const name = args[2];
    const subs = config.getSubscriptions();

    if (subs.length === 0) {
      console.error('  错误: 没有订阅');
      process.exit(1);
    }

    let target = name ? subs.find(s => s.name === name) : subs[0];
    if (!target) {
      console.error('  错误: 未找到订阅 "' + name + '"');
      process.exit(1);
    }

    console.log('  更新订阅: ' + target.name);
    try {
      const info = await subscription.downloadSubscription(target.url, target.name);
      console.log('  已更新 (节点: ' + info.proxies + ')');
    } catch (e) {
      console.error('  更新失败: ' + e.message);
      process.exit(1);
    }
    return;
  }

  console.error('  错误: 未知的订阅命令');
  console.log('  用法: mihomo-cli sub [list|add|update]');
  process.exit(1);
}

async function cmdReset(args) {
  const fullReset = args && (args.includes('--full') || args.includes('-f'));
  const skipConfirm = args && (args.includes('--yes') || args.includes('-y'));

  const pids = processMgr.getAllMihomoPids();
  if (pids.length > 0) {
    console.log('  停止 ' + pids.length + ' 个进程...');
    processMgr.cleanupAll(true);
    for (let i = 0; i < 50; i++) {
      if (processMgr.getAllMihomoPids().length === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const mode = fullReset ? '完整重置 (含内核)' : '重置配置';
  console.log('  ' + mode);

  if (!skipConfirm) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise(resolve => {
      rl.question('  确认? (y/N) ', (a) => {
        rl.close();
        resolve(a);
      });
    });

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('  已取消');
      return;
    }
  }

  const count = config.resetUserData({ keepKernel: !fullReset });
  console.log('  已重置 ' + count + ' 项');
}

function cmdDirs() {
  console.log('');
  console.log('  数据目录位置:');
  console.log('    根目录:      ' + config.USER_DATA_DIR);
  console.log('    全局设置:    ' + config.PATHS.settingsFile);
  console.log('    内核文件:    ' + config.PATHS.mihomoBinary);
  console.log('    订阅目录:    ' + config.DIRS.subs);
  console.log('      - xxx.yaml (订阅原始配置，不修改)');
  console.log('    运行时目录:  ' + config.DIRS.runtime);
  console.log('      - config.yaml (启动时生成，stop 自动清除)');
  console.log('      - pid (PID 文件，stop 自动清除)');
  console.log('    日志文件:    ' + config.PATHS.logFile);
  console.log('    mihomo 数据: ' + config.DIRS.data);
  console.log('      - cache.db, Geo*.dat 等 (mihomo 自行管理)');
  console.log('');
  console.log('  环境变量:');
  console.log('    MIHOMO_CLI_DIR: 自定义根目录位置');
  console.log('');
}

async function main() {
  config.ensureDirs();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    return;
  }

  const cmd = args[0].toLowerCase();

  if (['help', '-h', '--help'].includes(cmd)) {
    printHelp();
    return;
  }
  if (['version', '-v', '--version'].includes(cmd)) {
    printVersion();
    return;
  }

  switch (cmd) {
    case 'start':
      await cmdStart(args);
      break;
    case 'stop':
      await cmdStop();
      break;
    case 'restart':
      await cmdRestart(args);
      break;
    case 'status':
      printStatus();
      break;
    case 'log':
      cmdLog();
      break;
    case 'ui':
      cmdUi(args);
      break;
    case 'clean':
      cmdClean();
      break;
    case 'kernel':
      await cmdKernel();
      break;
    case 'sub':
    case 'subscription':
      await cmdSub(args);
      break;
    case 'dirs':
      cmdDirs();
      break;
    case 'reset':
      await cmdReset(args);
      break;
    default:
      console.error('  未知命令: ' + cmd);
      console.error('  使用 "mihomo-cli help" 查看帮助');
      process.exit(1);
  }
}

main().catch(e => {
  console.error('  错误:', e.message);
  process.exit(1);
});
