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

function printShortHelp() {
  console.log('\nmihomo-cli v' + VERSION);
  console.log('别名: mihomo, mmc, mh\n');
  console.log('命令:\n' +
    '  start [tun|mixed]  启动/切换代理（重复执行可切换模式）\n' +
    '  stop               停止代理\n' +
    '  status             查看状态\n' +
    '  log                实时日志\n' +
    '  logs               历史日志\n' +
    '  ui [zash|dash|yacd]  Web 界面\n' +
    '  kernel             更新内核\n' +
    '  sub add <url> [name]   添加订阅\n' +
    '  sub update [name]      更新订阅（无参更新所有）\n' +
    '  sub use <name>         切换默认订阅\n' +
    '  sub web [name]         打开订阅页面\n' +
    '  sub list               列出订阅\n' +
    '  reset              重置配置\n' +
    '  dirs               数据目录\n' +
    '  version            版本信息\n');
}

function printHelp() {
  console.log('\nmihomo-cli v' + VERSION + '\n' +
    '\n' +
    '命令别名: mihomo, mmc, mh\n' +
    '\n' +
    '用法:\n' +
    '  mihomo-cli <命令> [选项]\n' +
    '\n' +
    '命令:\n' +
    '  start [tun|mixed]  启动/切换代理 (默认 mixed, 重复执行可重启/切换模式)\n' +
    '  stop               停止代理\n' +
    '  status             查看状态\n' +
    '  log                实时日志\n' +
    '  logs [name] [-n N]  列出/查看历史日志 (默认 100 行)\n' +
    '  ui [zash|dash|yacd]  打开 Web UI (默认 zash)\n' +
    '  kernel [镜像]       更新内核 (可指定镜像: hk.gh-proxy.org 或 --no-mirror)\n' +
    '  sub add <url> [name]   添加订阅\n' +
    '  sub update [name]      更新订阅 (无参更新所有)\n' +
    '  sub use <name>         设置默认订阅 (支持模糊匹配)\n' +
    '  sub web [name]         打开订阅页面\n' +
    '  sub list              列出订阅\n' +
    '  reset [--full]        重置用户数据 (--full 同时删除内核)\n' +
    '  dirs                 显示数据目录位置\n' +
    '  help, -h           显示帮助\n' +
    '  version, -v        显示版本\n' +
    '\n' +
    '示例:\n' +
    '  mihomo-cli start           # 启动/重启 Mixed 模式\n' +
    '  mihomo-cli start tun       # 启动/切换到 TUN 模式 (透明代理)\n' +
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

function findSubsFuzzy(subs, pattern) {
  const lowerPattern = pattern.toLowerCase();
  let exact = [];
  let prefix = [];
  let includes = [];

  for (const s of subs) {
    const name = s.name.toLowerCase();
    if (name === lowerPattern) {
      exact.push(s);
    } else if (name.startsWith(lowerPattern)) {
      prefix.push(s);
    } else if (name.includes(lowerPattern)) {
      includes.push(s);
    }
  }

  if (exact.length > 0) return exact;
  if (prefix.length > 0) return prefix;
  return includes;
}

function pickSingleSub(subs, pattern, actionName) {
  if (subs.length === 0) {
    console.error('  错误: 未找到匹配 "' + pattern + '" 的订阅');
    process.exit(1);
  }
  if (subs.length === 1) {
    return subs[0];
  }
  console.error('  错误: 匹配到多个订阅，请更精确指定');
  console.log('\n  匹配的订阅:');
  subs.forEach(s => console.log('    ' + s.name));
  process.exit(1);
}

function hasFlag(args, short, long) {
  return args && (args.includes(short) || args.includes(long));
}

function parseIntArg(args, short, long, defaultValue) {
  if (!args) return defaultValue;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === short || args[i] === long) {
      if (i + 1 < args.length) {
        const val = parseInt(args[i + 1]);
        return isNaN(val) ? defaultValue : val;
      }
    }
  }
  return defaultValue;
}

function getNonFlagArg(args, startIdx) {
  if (!args) return null;
  for (let i = startIdx; i < args.length; i++) {
    if (!args[i].startsWith('-')) {
      return args[i];
    }
  }
  return null;
}

function openLogFile(logPath, label) {
  const displayLabel = label || logPath;
  console.log('  用系统默认程序打开: ' + displayLabel);
  const success = processMgr.openUrl(logPath);
  if (!success) {
    console.log('  请手动打开: ' + logPath);
  }
}

function viewLogWithTail(logPath, options) {
  const follow = options && options.follow;
  const lines = (options && options.lines) || 100;

  console.log('  日志: ' + logPath);
  if (follow) {
    console.log('  按 Ctrl+C 退出\n');
  } else {
    console.log('  显示最后 ' + lines + ' 行\n');
  }

  const tailArgs = [];
  if (follow) tailArgs.push('-f');
  tailArgs.push('-n', lines.toString());
  tailArgs.push(logPath);

  const tail = spawn('tail', tailArgs, { stdio: 'inherit' });

  tail.on('close', () => process.exit(0));
  tail.on('error', (e) => {
    console.error('  无法读取日志: ' + e.message);
    process.exit(1);
  });
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

  await subscription.autoUpdateStaleSubscriptions();

  // 每次 start 都先确保完全干净的状态（停止进程 + 清理运行时文件）
  const status = processMgr.getStatus();
  const hasProcess = status.running || status.allProcesses.length > 0;

  if (hasProcess) {
    const count = status.allProcesses.length > 0 ? status.allProcesses.length : 1;
    console.log('  停止 ' + count + ' 个进程...');
  }

  // 总是调用 stop（即使没进程也会清理 PID 文件和运行时目录）
  const stopResult = processMgr.stop(true);

  if (stopResult.remaining && stopResult.remaining.length > 0) {
    console.error('  部分进程无法终止: ' + stopResult.remaining.join(', '));
    console.error('  请手动运行: sudo pkill -9 mihomo');
    process.exit(1);
  }

  if (hasProcess) {
    console.log('  已停止\n');
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

async function cmdStop() {
  const pids = processMgr.getAllMihomoPids();
  if (pids.length === 0) {
    console.log('  未在运行');
    return;
  }

  console.log('  停止 ' + pids.length + ' 个进程...');
  const result = processMgr.stop(true);

  if (result.remaining && result.remaining.length > 0) {
    console.error('  部分进程未终止: ' + result.remaining.join(', '));
    console.error('  请手动运行: sudo pkill -9 mihomo');
    process.exit(1);
  }
  console.log('  已停止');
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


function cmdLog(args) {
  const logPath = processMgr.getLogPath();

  if (hasFlag(args, '-o', '--open')) {
    openLogFile(logPath);
    return;
  }

  viewLogWithTail(logPath, { follow: true, lines: 50 });
}

function cmdLogs(args) {
  const targetName = getNonFlagArg(args, 1);
  const lines = parseIntArg(args, '-n', '--lines', 100);
  const openInViewer = hasFlag(args, '-o', '--open');

  if (targetName) {
    let logPath;

    if (targetName === 'current' || targetName === '0') {
      logPath = processMgr.getLogPath();
    } else {
      logPath = processMgr.getLogPathByName(targetName);
    }

    if (!logPath) {
      console.error('  错误: 未找到日志 "' + targetName + '"');
      console.log('  使用 "mihomo-cli logs" 查看可用日志列表');
      process.exit(1);
    }

    if (openInViewer) {
      openLogFile(logPath);
      return;
    }

    viewLogWithTail(logPath, { follow: false, lines });
    return;
  }

  const logs = processMgr.listLogs();
  const all = [];

  if (logs.current) {
    all.push(logs.current);
  }
  all.push(...logs.archives);

  if (all.length === 0) {
    console.log('  暂无日志');
    return;
  }

  console.log('');
  console.log('  日志列表:');
  console.log('');

  all.forEach((log, idx) => {
    const num = log.isCurrent ? ' 0' : (idx < 10 ? ' ' + idx : '' + idx);
    const time = subscription.formatDate(log.mtime);
    const size = subscription.formatBytes(log.size);
    const name = log.isCurrent ? 'mihomo.log (当前运行中)' : log.name;

    console.log('  ' + num + '. ' + name);
    console.log('      时间: ' + time + '  大小: ' + size);
    if (!log.isCurrent) {
      console.log('      查看: mihomo-cli logs ' + idx + '  或  mihomo-cli logs -o ' + idx);
    }
    console.log('');
  });

  console.log('  用法:');
  console.log('    mihomo-cli logs 0          # 查看当前日志 (最后 100 行)');
  console.log('    mihomo-cli logs 1          # 查看第 1 个归档日志');
  console.log('    mihomo-cli logs 1 -n 200   # 查看 200 行');
  console.log('    mihomo-cli logs 1 -o        # 用系统默认程序打开');
  console.log('');
}

// 解析镜像参数
function parseMirrorArg(args) {
  // 返回: { mirror: 镜像URL|null, isOverride: boolean }
  // mirror = null 表示禁用镜像
  // mirror = undefined 表示使用默认/配置

  if (!args || args.length < 2) {
    return { mirror: undefined, isOverride: false };
  }

  // 检查 --no-mirror
  if (args.includes('--no-mirror') || args.includes('--direct')) {
    return { mirror: null, isOverride: true };
  }

  // 检查 --mirror <值>
  const mirrorIdx = args.indexOf('--mirror');
  if (mirrorIdx >= 0 && mirrorIdx + 1 < args.length) {
    let mirrorVal = args[mirrorIdx + 1];
    return { mirror: normalizeMirrorUrl(mirrorVal), isOverride: true };
  }

  // 第一个非 flag 参数作为镜像
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      return { mirror: normalizeMirrorUrl(arg), isOverride: true };
    }
  }

  return { mirror: undefined, isOverride: false };
}

function normalizeMirrorUrl(val) {
  if (!val) return null;
  if (val === 'direct' || val === 'no' || val === 'none') return null;

  let url = val;
  if (!url.startsWith('http')) {
    url = 'https://' + url;
  }
  if (!url.endsWith('/')) {
    url += '/';
  }
  return url;
}

async function cmdKernel(args) {
  const mirrorInfo = parseMirrorArg(args);
  const effectiveMirror = mirrorInfo.isOverride ? mirrorInfo.mirror : config.getGitHubMirror();
  const isDefault = !mirrorInfo.isOverride && effectiveMirror === config.DEFAULT_GITHUB_MIRROR;

  console.log('  检查内核更新...');

  if (mirrorInfo.isOverride) {
    if (effectiveMirror === null) {
      console.log('  镜像: 直连（命令行指定 --no-mirror）');
    } else {
      console.log('  镜像: ' + effectiveMirror + ' (命令行指定)');
    }
  } else {
    console.log('  镜像: ' + (effectiveMirror || '直连（无镜像）') + (isDefault && effectiveMirror ? ' (默认)' : ''));
  }

  console.log('\n  可用镜像:');
  config.AVAILABLE_MIRRORS.forEach(m => {
    const isCurrent = effectiveMirror && (
      effectiveMirror.includes('//' + m + '/') ||
      effectiveMirror.includes('//' + m + ':') ||
      effectiveMirror.endsWith('//' + m)
    );
    console.log('    ' + m + (isCurrent ? ' (当前)' : ''));
  });

  console.log('\n  用法:');
  console.log('    mihomo-cli kernel                    # 使用默认镜像');
  console.log('    mihomo-cli kernel hk.gh-proxy.org    # 使用指定镜像');
  console.log('    mihomo-cli kernel --mirror hk.gh-proxy.org');
  console.log('    mihomo-cli kernel --no-mirror         # 直连，不使用镜像');
  console.log('');

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
    }, mirrorInfo.mirror);  // 传递镜像参数（undefined = 用配置，null = 禁用）
    console.log('  已更新到 ' + result.version);
  } catch (e) {
    console.error('  更新失败: ' + e.message);
    process.exit(1);
  }
}

async function cmdSub(args) {
  const action = args[1];

  if (!action || action === 'list') {
    const updateResult = await subscription.autoUpdateStaleSubscriptions();
    if (updateResult.total > 0) {
      console.log('');
    }

    const subs = config.getSubscriptionsWithCache();
    if (subs.length === 0) {
      console.log('  没有订阅');
      console.log('\n  添加订阅:');
      console.log('    mihomo-cli sub add <url> [name]');
      return;
    }
    console.log('  订阅列表:');
    subs.forEach((s, i) => {
      const time = subscription.formatDate(s.updatedAt);
      const defaultMark = i === 0 ? ' [默认]' : '';
      const interval = s.updateInterval || subscription.DEFAULT_UPDATE_INTERVAL_HOURS;
      console.log('    ' + (i + 1) + '. ' + s.name + defaultMark);
      console.log('       更新: ' + time + ' (间隔: ' + interval + 'h)');

      if (s.username) {
        console.log('       用户: ' + s.username);
      }
      if (s.download !== undefined || s.total !== undefined) {
        const used = (s.upload || 0) + (s.download || 0);
        const usedStr = subscription.formatBytes(used);
        const totalStr = subscription.formatBytes(s.total);
        let percentStr = '';
        if (s.total && s.total > 0) {
          const percent = Math.min((used / s.total) * 100, 100);
          percentStr = ' (' + percent.toFixed(1) + '%)';
        }
        console.log('       流量: ' + usedStr + ' / ' + totalStr + percentStr);
      }
      if (s.expire !== undefined) {
        console.log('       到期: ' + subscription.formatTimestamp(s.expire));
      }
      if (s.webPageUrl) {
        console.log('       页面: ' + s.webPageUrl);
      }
    });
    console.log('\n  切换默认订阅:');
    console.log('    mihomo-cli sub use <name>');
    console.log('  更新订阅:');
    console.log('    mihomo-cli sub update [name]');
    console.log('  打开订阅页面:');
    console.log('    mihomo-cli sub web [name]');
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

    if (!name) {
      console.log('  更新所有 ' + subs.length + ' 个订阅...');
      const results = await Promise.all(subs.map(subscription.tryUpdateOne));
      let ok = 0;
      results.forEach(r => {
        if (r.success) {
          ok++;
          console.log('  ✓ ' + r.name + ': ' + r.proxies + ' 节点');
        } else {
          console.log('  ✗ ' + r.name + ': 失败 (' + r.error.split('\n')[0] + ')');
        }
      });
      if (ok === 0) process.exit(1);
      return;
    }

    const matches = findSubsFuzzy(subs, name);
    const target = pickSingleSub(matches, name, '更新');

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

  if (action === 'use') {
    const name = args[2];
    const subs = config.getSubscriptions();

    if (!name) {
      console.error('  错误: 请指定订阅名称');
      if (subs.length > 0) {
        console.log('\n  可用订阅:');
        subs.forEach(s => console.log('    ' + s.name));
      }
      process.exit(1);
    }

    const matches = findSubsFuzzy(subs, name);
    const target = pickSingleSub(matches, name, '切换');

    const success = config.setDefaultSubscription(target.name);
    if (success) {
      console.log('  已设置 "' + target.name + '" 为默认订阅');
    } else {
      console.error('  错误: 未找到订阅 "' + name + '"');
      process.exit(1);
    }
    return;
  }

  if (action === 'web' || action === 'open') {
    const name = args[2];
    const subs = config.getSubscriptionsWithCache();

    if (subs.length === 0) {
      console.error('  错误: 没有订阅');
      process.exit(1);
    }

    let target;
    if (name) {
      const matches = findSubsFuzzy(subs, name);
      target = pickSingleSub(matches, name, '打开');
    } else {
      target = subs[0];
    }

    let webPageUrl = target.webPageUrl;
    if (!webPageUrl) {
      console.log('  订阅信息中缺少页面地址，正在更新订阅...');
      try {
        const info = await subscription.downloadSubscription(target.url, target.name);
        if (info.webPageUrl) {
          webPageUrl = info.webPageUrl;
        } else {
          console.error('  错误: 该订阅没有提供页面地址');
          process.exit(1);
        }
      } catch (e) {
        console.error('  更新失败: ' + e.message);
        process.exit(1);
      }
    }

    console.log('  打开订阅页面: ' + webPageUrl);
    const opened = processMgr.openUrl(webPageUrl);
    if (!opened) {
      console.log('  请手动访问上面的地址');
    }
    return;
  }

  console.error('  错误: 未知的订阅命令');
  console.log('  用法: mihomo-cli sub [list|add|update|use|web]');
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
    printStatus();
    printShortHelp();
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
    case 'status':
      printStatus();
      break;
    case 'log':
      cmdLog(args);
      break;
    case 'logs':
      cmdLogs(args);
      break;
    case 'ui':
      cmdUi(args);
      break;
    case 'kernel':
      await cmdKernel(args);
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
