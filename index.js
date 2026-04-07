#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

const config = require('./src/config');
const kernel = require('./src/kernel');
const subscription = require('./src/subscription');
const processMgr = require('./src/process');
const overwrite = require('./src/overwrite');

const VERSION = require('./package.json').version;

const UI_URLS = {
  zash: 'https://board.zash.run.place',
  dash: 'https://metacubex.github.io/metacubexd',
  yacd: 'https://yacd.metacubex.one',
};

let exiting = false;

process.on('SIGINT', () => {
  if (exiting) {
    console.log('\n强制退出');
    process.exit(1);
  }
  exiting = true;
  console.log('\n正在退出...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('uncaughtException', e => {
  console.error('\n未捕获的异常: ' + e.message);
  if (e.stack) {
    console.error(e.stack.split('\n').slice(1).join('\n'));
  }
  process.exit(1);
});

process.on('unhandledRejection', reason => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('\n未处理的 Promise 拒绝: ' + msg);
  process.exit(1);
});

function printShortHelp() {
  console.log('\nmihomo-cli v' + VERSION + '  (mihomo help 查看完整帮助)\n');
  console.log(
    '常用命令:\n' +
      '  start [tun|mixed]    启动/切换代理\n' +
      '  ui [zash|dash|yacd]  打开 Web UI\n' +
      '  ow [on|off]          覆写配置\n' +
      '  sub [use|update]     订阅管理\n',
  );
}

function printHelp() {
  console.log(
    '\nmihomo-cli v' +
      VERSION +
      '\n' +
      '\n' +
      '命令别名: mihomo, mmc, mh\n' +
      '\n' +
      '用法:\n' +
      '  mihomo <命令> [选项]\n' +
      '\n' +
      '控制:\n' +
      '  start [tun|mixed]            启动/切换代理 (默认 mixed)\n' +
      '  stop                         停止代理\n' +
      '  status                       查看状态\n' +
      '\n' +
      '界面:\n' +
      '  ui [zash|dash|yacd]          打开 Web UI (默认 zash)\n' +
      '  log [-o]                     实时日志（-o 打开文件）\n' +
      '  logs [编号] [-n N] [-o]      日志列表（0=当前，1+=归档）\n' +
      '\n' +
      '订阅:\n' +
      '  subscription                 列出所有订阅（别名 sub）\n' +
      '  subscription add <url> [name]  添加订阅\n' +
      '  subscription update [name]   更新订阅（无参更新所有）\n' +
      '  subscription use <name>      切换默认订阅\n' +
      '  subscription web [name]      打开订阅页面\n' +
      '\n' +
      '配置:\n' +
      '  overwrite                   查看覆写状态（别名 ow）\n' +
      '  overwrite on|off            启用/禁用覆写配置\n' +
      '  directory                   显示数据目录位置（别名 dir）\n' +
      '  directory open [target]     打开目录: root|subs|logs|overwrites|...\n' +
      '\n' +
      '系统:\n' +
      '  kernel [镜像|--no-mirror]    更新内核\n' +
      '  reset [--full]               重置用户数据 (--full 同时删除内核)\n' +
      '  help, -h                     显示帮助\n' +
      '  version, -v                  显示版本\n' +
      '\n' +
      '示例:\n' +
      '  mihomo start              # 启动/重启 Mixed 模式\n' +
      '  mihomo start tun          # 切换到 TUN 透明代理模式\n' +
      '  mihomo sub add <url>      # 添加订阅 (sub 是 subscription 别名)\n' +
      '  mihomo ui                 # 打开 Web UI\n' +
      '\n' +
      '模式说明:\n' +
      '  mixed  HTTP + SOCKS5 混合端口 (默认)\n' +
      '  tun    透明代理，全局自动路由，需要 sudo\n' +
      '\n' +
      '数据目录:\n' +
      '  环境变量 MIHOMO_CLI_DIR 可自定义位置\n' +
      '  默认: ' +
      config.USER_DATA_DIR +
      '\n',
  );
}

function printVersion() {
  const kv = config.getKernelVersion() || '未安装';
  console.log('mihomo-cli v' + VERSION);
  console.log('内核: ' + kv);
  console.log('数据目录: ' + config.USER_DATA_DIR);
}

function printStatus() {
  const status = processMgr.getStatus();
  const info = config.getConfigInfo();
  const owEnabled = overwrite.isOverwriteEnabled();
  const owFiles = overwrite.listOverwriteFiles().files;
  const activeSub = getActiveSubscription();

  console.log('');
  let modeLabel = '';
  if (info && status.running) {
    modeLabel = info.tun ? ' (TUN)' : ' (Mixed)';
  }
  console.log('状态: ' + (status.running ? '运行中' : '已停止') + modeLabel);
  console.log('内核: ' + (status.kernelVersion || '未安装'));

  if (status.pid) {
    console.log('PID:  ' + status.pid);
    if (status.processInfo) {
      console.log('内存: ' + status.processInfo.memory);
    }
  }

  if (info) {
    if (info.mixedPort) {
      console.log('端口: ' + info.mixedPort);
    } else {
      let ports = [];
      if (info.httpPort) ports.push('HTTP:' + info.httpPort);
      if (info.socksPort) ports.push('SOCKS:' + info.socksPort);
      console.log('端口: ' + (ports.length > 0 ? ports.join(', ') : '未知'));
    }
  }

  if (activeSub) {
    let subLine = '订阅: ' + activeSub.name;
    if (info) {
      subLine += ' (' + subscription.formatProxySummary(info) + ')';
    }
    console.log(subLine);
  } else {
    console.log('订阅: 未配置');
  }

  if (owEnabled && owFiles.length > 0) {
    const names = owFiles.map(f => f.name).join(', ');
    console.log('覆写: 已启用 (' + names + ')');
  } else if (owEnabled) {
    console.log('覆写: 已启用 (无文件)');
  } else {
    console.log('覆写: 已禁用');
  }
  console.log('');
}

function getActiveSubscription() {
  const subs = config.getSubscriptions();
  if (subs.length === 0) {
    return null;
  }
  return subs[0];
}

function findSubscriptionFuzzy(subs, pattern) {
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

function pickSingleSubscription(subs, pattern) {
  if (subs.length === 0) {
    console.error('错误: 未找到匹配 "' + pattern + '" 的订阅');
    process.exit(1);
  }
  if (subs.length === 1) {
    return subs[0];
  }
  console.error('错误: 匹配到多个订阅，请更精确指定');
  console.log('\n匹配的订阅:');
  subs.forEach(s => console.log('  ' + s.name));
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
  console.log('用系统默认程序打开: ' + displayLabel);
  const success = processMgr.openUrl(logPath);
  if (!success) {
    console.log('请手动打开: ' + logPath);
  }
}

function openDir(dirPath, label) {
  const displayLabel = label || dirPath;
  console.log('正在打开: ' + displayLabel);
  const success = processMgr.openUrl(dirPath);
  if (!success) {
    console.log('请手动打开: ' + dirPath);
  }
}

function viewLogWithTail(logPath, options) {
  const follow = options && options.follow;
  const lines = (options && options.lines) || 100;

  console.log('日志: ' + logPath);
  if (follow) {
    console.log('按 Ctrl+C 退出\n');
  } else {
    console.log('显示最后 ' + lines + ' 行\n');
  }

  const tailArgs = [];
  if (follow) tailArgs.push('-f');
  tailArgs.push('-n', lines.toString());
  tailArgs.push(logPath);

  const tail = spawn('tail', tailArgs, { stdio: 'inherit' });

  tail.on('close', () => process.exit(0));
  tail.on('error', e => {
    console.error('无法读取日志: ' + e.message);
    process.exit(1);
  });
}

async function cmdStart(args) {
  if (!config.hasKernel()) {
    console.error('错误: 未找到内核，请运行 "mihomo kernel"');
    process.exit(1);
  }

  const targetMode = args[1] === 'tun' ? 'tun' : 'mixed';

  const sub = getActiveSubscription();
  if (!sub) {
    console.error('错误: 没有订阅，请先添加订阅');
    process.exit(1);
  }

  await subscription.autoUpdateStaleSubscriptions();

  // 每次 start 都先确保完全干净的状态（停止进程 + 清理运行时文件）
  const status = processMgr.getStatus();
  const hasProcess = status.running || status.allProcesses.length > 0;

  if (hasProcess) {
    const count = status.allProcesses.length > 0 ? status.allProcesses.length : 1;
    console.log('停止 ' + count + ' 个进程...');
  }

  // 总是调用 stop（即使没进程也会清理 PID 文件和运行时目录）
  const stopResult = processMgr.stop(true);

  if (stopResult.remaining && stopResult.remaining.length > 0) {
    console.error('部分进程未终止: ' + stopResult.remaining.join(', '));
    console.error('请手动运行: sudo pkill -9 mihomo');
    process.exit(1);
  }

  if (hasProcess) {
    console.log('已停止\n');
  }

  let cfgInfo;
  try {
    cfgInfo = subscription.prepareConfigForStart(targetMode, sub.name);
  } catch (e) {
    console.error('配置错误: ' + e.message);
    process.exit(1);
  }

  const modeLabel = targetMode === 'tun' ? 'TUN' : 'Mixed';
  console.log([modeLabel, sub.name, subscription.formatProxySummary(cfgInfo)].join(' · '));

  try {
    const result = await processMgr.start(targetMode);
    console.log('已启动 (PID ' + result.pid + ')');
    printStatus();
  } catch (e) {
    console.error('启动失败: ' + e.message.split('\n')[0]);
    process.exit(1);
  }
}

async function cmdStop() {
  const pids = processMgr.getAllMihomoPids();
  if (pids.length === 0) {
    console.log('未在运行');
    return;
  }

  console.log('停止 ' + pids.length + ' 个进程...');
  const result = processMgr.stop(true);

  if (result.remaining && result.remaining.length > 0) {
    console.error('部分进程未终止: ' + result.remaining.join(', '));
    console.error('请手动运行: sudo pkill -9 mihomo');
    process.exit(1);
  }
  console.log('已停止');
}

function cmdUI(args) {
  const uiName = args[1] || 'zash';
  const url = UI_URLS[uiName];

  if (!url) {
    console.error('错误: 未知的 UI "' + uiName + '"');
    console.error('可用 UI: zash (默认), dash, yacd');
    process.exit(1);
  }

  console.log('打开 Web UI: ' + uiName);
  console.log('地址: ' + url);

  const success = processMgr.openUrl(url);
  if (!success) {
    console.log('请手动访问上面的地址');
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
      // 纯数字 1+ 表示归档日志的位置（最新=1）
      const parsedIdx = parseInt(targetName);
      if (!isNaN(parsedIdx) && parsedIdx > 0 && String(parsedIdx) === targetName) {
        const archiveLogs = processMgr.listLogs();
        const archive = archiveLogs.archives[parsedIdx - 1];
        if (!archive) {
          console.error('错误: 未找到日志 "' + targetName + '"');
          console.log('使用 "mihomo logs" 查看可用日志列表');
          process.exit(1);
        }
        logPath = archive.path;
      } else {
        logPath = processMgr.getLogPathByName(targetName);
      }
    }

    if (!logPath) {
      console.error('错误: 未找到日志 "' + targetName + '"');
      console.log('使用 "mihomo logs" 查看可用日志列表');
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
    console.log('暂无日志');
    return;
  }

  console.log('');
  console.log('日志列表:');
  console.log('');

  let archiveCounter = 0;
  all.forEach(log => {
    let num;
    if (log.isCurrent) {
      num = ' 0';
    } else {
      archiveCounter++;
      num = archiveCounter < 10 ? ' ' + archiveCounter : '' + archiveCounter;
    }
    const time = subscription.formatDate(log.mtime);
    const size = subscription.formatBytes(log.size);
    const name = log.isCurrent ? 'mihomo.log (当前运行中)' : log.name;

    console.log(' ' + num + '. ' + name);
    console.log('    时间: ' + time + '  大小: ' + size);
    if (!log.isCurrent) {
      console.log('    查看: mihomo logs ' + archiveCounter + '  或  mihomo logs ' + archiveCounter + ' -o');
    }
    console.log('');
  });

  console.log('用法:');
  console.log('  mihomo logs 0          # 查看当前日志 (最后 100 行)');
  console.log('  mihomo logs 1          # 查看第 1 个归档日志（最新）');
  console.log('  mihomo logs 1 -n 200   # 查看 200 行');
  console.log('  mihomo logs 1 -o       # 用系统默认程序打开');
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

  console.log('检查内核更新...');

  if (mirrorInfo.isOverride) {
    if (effectiveMirror === null) {
      console.log('镜像: 直连（命令行指定 --no-mirror）');
    } else {
      console.log('镜像: ' + effectiveMirror + ' (命令行指定)');
    }
  } else {
    console.log('镜像: ' + (effectiveMirror || '直连（无镜像）') + (isDefault && effectiveMirror ? ' (默认)' : ''));
  }

  console.log('\n可用镜像:');
  config.AVAILABLE_MIRRORS.forEach(m => {
    const isCurrent =
      effectiveMirror && (effectiveMirror.includes('//' + m + '/') || effectiveMirror.includes('//' + m + ':') || effectiveMirror.endsWith('//' + m));
    console.log('  ' + m + (isCurrent ? ' (当前)' : ''));
  });

  console.log('\n用法:');
  console.log('  mihomo kernel                    # 使用默认镜像');
  console.log('  mihomo kernel hk.gh-proxy.org    # 使用指定镜像');
  console.log('  mihomo kernel --mirror hk.gh-proxy.org');
  console.log('  mihomo kernel --no-mirror         # 直连，不使用镜像');
  console.log('');

  try {
    const info = await kernel.checkUpdate();
    console.log('当前: ' + info.current);
    console.log('最新: ' + info.latest);

    if (!info.needsUpdate) {
      console.log('已是最新版本');
      return;
    }

    console.log('\n正在下载...');
    const result = await kernel.downloadKernel(msg => {
      console.log(msg);
    }, mirrorInfo.mirror); // 传递镜像参数（undefined = 用配置，null = 禁用）
    console.log('已更新到 ' + result.version);
  } catch (e) {
    console.error('更新失败: ' + e.message);
    process.exit(1);
  }
}

async function printSubscriptionList() {
  const updateResult = await subscription.autoUpdateStaleSubscriptions();
  if (updateResult.total > 0) {
    console.log('');
  }

  const subs = config.getSubscriptionsWithCache();
  if (subs.length === 0) {
    console.log('没有订阅');
    console.log('');
    console.log('添加订阅: mihomo sub add <url> [name]');
    console.log('');
    return;
  }
  console.log('订阅列表:');
  subs.forEach((s, i) => {
    const time = subscription.formatDate(s.updated_at);
    const defaultMark = i === 0 ? ' [默认]' : '';
    const interval = s.update_interval || subscription.DEFAULT_UPDATE_INTERVAL_HOURS;
    console.log('  ' + (i + 1) + '. ' + s.name + defaultMark);
    console.log('    更新: ' + time + ' (间隔: ' + interval + 'h)');

    if (s.username) {
      console.log('    用户: ' + s.username);
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
      console.log('    流量: ' + usedStr + ' / ' + totalStr + percentStr);
    }
    if (s.expire !== undefined) {
      console.log('    到期: ' + subscription.formatTimestamp(s.expire));
    }
    if (s.web_page_url) {
      console.log('    页面: ' + s.web_page_url);
    }
  });
  console.log('');
  console.log('切换默认: mihomo sub use <name>');
  console.log('更新订阅: mihomo sub update [name]');
  console.log('打开页面: mihomo sub web [name]');
  console.log('新增订阅: mihomo sub add <url> [name]');
  console.log('');
}

async function cmdSubscription(args) {
  const action = args[1];

  if (!action || action === 'list') {
    await printSubscriptionList();
    return;
  }

  if (action === 'add') {
    const url = args[2];
    const name = args[3] || 'default';

    if (!url || !url.startsWith('http')) {
      console.error('错误: 请提供有效的订阅 URL');
      process.exit(1);
    }

    console.log('添加订阅: ' + name);
    try {
      config.addSubscription(url, name);
      const info = await subscription.downloadSubscription(url, name);
      console.log('已添加 (' + subscription.formatProxySummary(info) + ')');
    } catch (e) {
      console.error('添加失败: ' + e.message);
      process.exit(1);
    }
    console.log('');
    await printSubscriptionList();
    return;
  }

  if (action === 'update') {
    const name = args[2];
    const subs = config.getSubscriptions();

    if (subs.length === 0) {
      console.error('错误: 没有订阅');
      process.exit(1);
    }

    if (!name) {
      console.log('更新所有 ' + subs.length + ' 个订阅...');
      const results = await Promise.all(subs.map(subscription.tryUpdateOne));
      let ok = 0;
      results.forEach(r => {
        if (r.success) {
          ok++;
          console.log('✓ ' + r.name + ': 已更新 (' + subscription.formatProxySummary(r) + ')');
        } else {
          console.log('✗ ' + r.name + ': 失败 (' + r.error.split('\n')[0] + ')');
        }
      });
      if (ok === 0) process.exit(1);
      console.log('');
      await printSubscriptionList();
      return;
    }

    const matches = findSubscriptionFuzzy(subs, name);
    const target = pickSingleSubscription(matches, name);

    console.log('更新订阅: ' + target.name);
    try {
      const info = await subscription.downloadSubscription(target.url, target.name);
      console.log('已更新 (' + subscription.formatProxySummary(info) + ')');
    } catch (e) {
      console.error('更新失败: ' + e.message);
      process.exit(1);
    }
    console.log('');
    await printSubscriptionList();
    return;
  }

  if (action === 'use') {
    const name = args[2];
    const subs = config.getSubscriptions();

    if (!name) {
      console.error('错误: 请指定订阅名称');
      if (subs.length > 0) {
        console.log('\n可用订阅:');
        subs.forEach(s => console.log('  ' + s.name));
      }
      process.exit(1);
    }

    const matches = findSubscriptionFuzzy(subs, name);
    const target = pickSingleSubscription(matches, name);

    // 检查是否已是当前默认订阅
    const currentDefault = getActiveSubscription();
    const isAlreadyDefault = currentDefault && currentDefault.name === target.name;

    if (isAlreadyDefault) {
      console.log('"' + target.name + '" 已是当前默认订阅');
      console.log('');
      await printSubscriptionList();
      return;
    }

    // 检查当前运行状态和模式
    const status = processMgr.getStatus();
    const cfgInfo = config.getConfigInfo();
    const currentMode = cfgInfo && cfgInfo.tun ? 'tun' : 'mixed';

    const success = config.setDefaultSubscription(target.name);
    if (success) {
      console.log('已设置 "' + target.name + '" 为默认订阅');
    } else {
      console.error('错误: 未找到订阅 "' + name + '"');
      process.exit(1);
    }

    // 如果正在运行，自动重启
    if (status.running) {
      console.log('');
      await cmdStart(['start', currentMode]);
      return;
    }

    console.log('');
    await printSubscriptionList();
    return;
  }

  if (action === 'web' || action === 'open') {
    const name = args[2];
    const subs = config.getSubscriptionsWithCache();

    if (subs.length === 0) {
      console.error('错误: 没有订阅');
      process.exit(1);
    }

    let target;
    if (name) {
      const matches = findSubscriptionFuzzy(subs, name);
      target = pickSingleSubscription(matches, name);
    } else {
      target = subs[0];
    }

    let webPageUrl = target.web_page_url;
    if (!webPageUrl) {
      console.log('订阅信息中缺少页面地址，正在更新订阅...');
      try {
        const info = await subscription.downloadSubscription(target.url, target.name);
        // 重新读取缓存获取 web_page_url
        const cache = config.readSubscriptionsCache();
        if (cache[target.name] && cache[target.name].web_page_url) {
          webPageUrl = cache[target.name].web_page_url;
        } else {
          console.error('错误: 该订阅没有提供页面地址');
          process.exit(1);
        }
      } catch (e) {
        console.error('更新失败: ' + e.message);
        process.exit(1);
      }
    }

    console.log('打开订阅页面: ' + webPageUrl);
    const opened = processMgr.openUrl(webPageUrl);
    if (!opened) {
      console.log('请手动访问上面的地址');
    }
    return;
  }

  console.error('错误: 未知的订阅命令');
  console.log('用法: mihomo sub [list|add|update|use|web]');
  process.exit(1);
}

async function cmdReset(args) {
  const fullReset = args && (args.includes('--full') || args.includes('-f'));
  const skipConfirm = args && (args.includes('--yes') || args.includes('-y'));

  const pids = processMgr.getAllMihomoPids();
  if (pids.length > 0) {
    console.log('停止 ' + pids.length + ' 个进程...');
    processMgr.cleanupAll(true);
    for (let i = 0; i < 50; i++) {
      if (processMgr.getAllMihomoPids().length === 0) break;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const mode = fullReset ? '完整重置 (含内核)' : '重置配置';
  console.log(mode);

  if (!skipConfirm) {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise(resolve => {
      rl.question('确认? (y/N) ', a => {
        rl.close();
        resolve(a);
      });
    });

    if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
      console.log('已取消');
      return;
    }
  }

  const count = config.resetUserData({ keepKernel: !fullReset });
  console.log('已重置 ' + count + ' 项');
}

function printOverwriteList() {
  const info = overwrite.listOverwriteFiles();
  console.log('状态: ' + (info.enabled ? '已启用' : '已禁用'));
  console.log('目录: ' + info.dir);
  console.log('');
  if (info.files.length === 0) {
    console.log('暂无覆写文件');
    console.log('');
    console.log('用法示例: 创建文件 ' + path.join(info.dir, '01-custom.yaml'));
    console.log('');
  } else {
    console.log('覆写文件 (' + info.files.length + ' 个，按顺序加载):');
    console.log('');
    info.files.forEach((f, i) => {
      const num = i < 10 ? ' ' + i : '' + i;
      console.log('  ' + num + '. ' + f.name);
      if (f.keys.length > 0) {
        console.log('    字段: ' + f.keys.join(', '));
      }
    });
    console.log('');
  }
  console.log('启用覆写: mihomo ow on');
  console.log('禁用覆写: mihomo ow off');
  console.log('');
}

async function cmdOverwrite(args) {
  const action = args && args[1];

  // 检查当前运行状态和模式
  const status = processMgr.getStatus();
  const cfgInfo = config.getConfigInfo();
  const currentMode = cfgInfo && cfgInfo.tun ? 'tun' : 'mixed';

  if (action === 'on' || action === 'enable') {
    // 如果已经启用，提示后直接返回
    if (overwrite.isOverwriteEnabled()) {
      console.log('覆写配置已是启用状态');
      console.log('');
      printOverwriteList();
      return;
    }

    overwrite.setOverwriteEnabled(true);
    console.log('已启用覆写配置');

    // 如果正在运行，自动重启
    if (status.running) {
      console.log('');
      await cmdStart(['start', currentMode]);
      return;
    }

    console.log('');
    printOverwriteList();
    return;
  }

  if (action === 'off' || action === 'disable') {
    // 如果已经禁用，提示后直接返回
    if (!overwrite.isOverwriteEnabled()) {
      console.log('覆写配置已是禁用状态');
      console.log('');
      printOverwriteList();
      return;
    }

    overwrite.setOverwriteEnabled(false);
    console.log('已禁用覆写配置');

    // 如果正在运行，自动重启
    if (status.running) {
      console.log('');
      await cmdStart(['start', currentMode]);
      return;
    }

    console.log('');
    printOverwriteList();
    return;
  }

  // 无参数、list、ls 都显示文件列表
  console.log('');
  printOverwriteList();
}

// 目录目标映射（精确匹配）
const DIRECTORY_TARGETS = {
  root: { path: null, label: '根目录' },
  subs: { path: config.DIRS.subscriptions, label: '订阅目录' },
  logs: { path: config.DIRS.logs, label: '日志目录' },
  data: { path: config.DIRS.data, label: 'mihomo 数据目录' },
  runtime: { path: config.DIRS.runtime, label: '运行时目录' },
  overwrites: { path: config.DIRS.overwrites, label: '覆写目录' },
  settings: { path: config.PATHS.settingsFile, label: '设置文件' },
  kernel: { path: config.DIRS.core, label: '内核目录' },
};

function cmdDirectory(args) {
  const action = args && args[1];

  if (action === 'open') {
    const target = args[2];

    if (!target || target === 'root') {
      openDir(config.USER_DATA_DIR, '根目录');
      return;
    }

    const targetInfo = DIRECTORY_TARGETS[target.toLowerCase()];
    if (targetInfo) {
      const path = targetInfo.path || config.USER_DATA_DIR;
      openDir(path, targetInfo.label);
      return;
    }

    console.error('错误: 未知的目录目标 "' + target + '"');
    console.log('');
    console.log('可用目标:');
    console.log('  root (默认)   根目录');
    console.log('  subs          订阅目录');
    console.log('  logs          日志目录');
    console.log('  data          mihomo 数据目录');
    console.log('  runtime       运行时目录');
    console.log('  overwrites    覆写目录');
    console.log('  settings      设置文件 (settings.json)');
    console.log('  kernel        内核目录');
    console.log('');
    process.exit(1);
  }

  // 无参数或未知参数：显示目录列表
  console.log('');
  console.log('数据目录位置:');
  console.log('  根目录: ' + config.USER_DATA_DIR);
  console.log('  全局设置: ' + config.PATHS.settingsFile);
  console.log('  内核文件: ' + config.PATHS.mihomoBinary);
  console.log('  订阅目录: ' + config.DIRS.subscriptions);
  console.log('    - cache.json (订阅缓存：更新时间、流量等)');
  console.log('    - xxx.yaml (订阅原始配置)');
  console.log('  运行时目录: ' + config.DIRS.runtime);
  console.log('    - config.yaml (启动时生成，stop 自动清除)');
  console.log('    - pid (PID 文件，stop 自动清除)');
  console.log('  日志文件: ' + config.PATHS.logFile);
  console.log('  mihomo 数据: ' + config.DIRS.data);
  console.log('    - cache.db, Geo*.dat 等 (mihomo 自行管理)');
  console.log('');
  console.log('打开目录:');
  console.log('  mihomo dir open                打开根目录');
  console.log('  mihomo dir open subs           打开订阅目录');
  console.log('  mihomo dir open logs           打开日志目录');
  console.log('  mihomo dir open runtime        打开运行时目录');
  console.log('  mihomo dir open overwrites     打开覆写目录');
  console.log('  mihomo dir open settings       打开设置文件');
  console.log('  mihomo dir open kernel         打开内核目录');
  console.log('');
  console.log('环境变量:');
  console.log('  MIHOMO_CLI_DIR: 自定义根目录位置');
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
      cmdUI(args);
      break;
    case 'kernel':
      await cmdKernel(args);
      break;
    case 'sub':
    case 'subscription':
    case 'subscriptions':
      await cmdSubscription(args);
      break;
    case 'dir':
    case 'dirs':
    case 'directory':
    case 'directories':
      cmdDirectory(args);
      break;
    case 'reset':
      await cmdReset(args);
      break;
    case 'ow':
    case 'overwrite':
      await cmdOverwrite(args);
      break;
    default:
      console.error('未知命令: ' + cmd);
      console.error('使用 "mihomo help" 查看帮助');
      process.exit(1);
  }
}

main().catch(e => {
  console.error('错误:', e.message);
  process.exit(1);
});
