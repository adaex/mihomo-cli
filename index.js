#!/usr/bin/env node

// 内置模块
const path = require('path');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const readline = require('readline');

// 第三方模块
// （无第三方模块依赖）

// 本地模块
const config = require('./src/config');
const kernel = require('./src/kernel');
const subscription = require('./src/subscription');
const processManager = require('./src/process');
const overwrite = require('./src/overwrite');
const utils = require('./src/utils');

const execAsync = promisify(exec);
const VERSION = utils.VERSION;
const { colors } = utils;

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
  console.log('\n' + colors.cyan(colors.bold('mihomo-cli v' + VERSION)) + '  (mihomo help 查看完整帮助)\n');
  console.log(
    '常用命令:\n' +
      '  ' +
      colors.bold('start') +
      ' [tun|mixed]    启动/切换代理\n' +
      '  ' +
      colors.bold('sub') +
      ' [use|update]     订阅管理\n' +
      '  ' +
      colors.bold('ow') +
      ' [on|off]          覆写配置\n' +
      '  ' +
      colors.bold('ui') +
      ' [zash|dash|yacd]  打开 Web UI\n',
  );
}

function printHelp() {
  console.log(
    '\n' +
      colors.cyan(colors.bold('mihomo-cli v' + VERSION)) +
      '\n' +
      '\n' +
      '命令别名: mihomo, mmc, mh\n' +
      '\n' +
      '用法:\n' +
      '  mihomo <命令> [选项]\n' +
      '\n' +
      colors.cyan('控制:') +
      '\n' +
      '  ' +
      colors.bold('start') +
      ' [tun|mixed]            启动/切换代理 (默认 mixed)\n' +
      '  ' +
      colors.bold('stop') +
      '                         停止代理\n' +
      '  ' +
      colors.bold('status') +
      '                       查看状态\n' +
      '\n' +
      colors.cyan('界面:') +
      '\n' +
      '  ' +
      colors.bold('ui') +
      ' [zash|dash|yacd]          打开 Web UI (默认 zash)\n' +
      '  ' +
      colors.bold('log') +
      ' [-o]                     实时日志（-o 打开文件）\n' +
      '  ' +
      colors.bold('logs') +
      ' [编号] [-n N] [-o]      日志列表（0=当前，1+=归档）\n' +
      '\n' +
      colors.cyan('订阅:') +
      '\n' +
      '  ' +
      colors.bold('subscription') +
      '                 列出所有订阅（别名 sub）\n' +
      '  ' +
      colors.bold('subscription') +
      ' add <url> [name]  添加订阅\n' +
      '  ' +
      colors.bold('subscription') +
      ' update [name]   更新订阅（无参更新所有）\n' +
      '  ' +
      colors.bold('subscription') +
      ' use <name>      切换默认订阅\n' +
      '  ' +
      colors.bold('subscription') +
      ' web [name]      打开订阅页面\n' +
      '\n' +
      colors.cyan('配置:') +
      '\n' +
      '  ' +
      colors.bold('overwrite') +
      '                   查看覆写状态（别名 ow）\n' +
      '  ' +
      colors.bold('overwrite') +
      ' on|off            启用/禁用覆写配置\n' +
      '  ' +
      colors.bold('directory') +
      '                   显示数据目录位置（别名 dir）\n' +
      '  ' +
      colors.bold('directory') +
      ' open [target]     打开目录: root|subs|logs|overwrites|...\n' +
      '\n' +
      colors.cyan('系统:') +
      '\n' +
      '  ' +
      colors.bold('kernel') +
      ' [--mirror [镜像]]         更新内核（默认直连，--mirror 使用 v6）\n' +
      '  ' +
      colors.bold('update') +
      '                       更新 mihomo-cli (npm install -g)\n' +
      '  ' +
      colors.bold('reset') +
      ' [目标...] [--full]   重置: 留空保留设置/内核/覆写, 指定目标删对应项, --full 删全部\n' +
      '  ' +
      colors.bold('help') +
      ', -h                     显示帮助\n' +
      '  ' +
      colors.bold('version') +
      ', -v                  显示版本\n' +
      '\n' +
      colors.cyan('示例:') +
      '\n' +
      '  mihomo start              # 启动/重启 Mixed 模式\n' +
      '  mihomo start tun          # 切换到 TUN 透明代理模式\n' +
      '  mihomo sub add <url>      # 添加订阅 (sub 是 subscription 别名)\n' +
      '  mihomo ui                 # 打开 Web UI\n' +
      '\n' +
      colors.cyan('模式说明:') +
      '\n' +
      '  mixed  HTTP + SOCKS5 混合端口 (默认)\n' +
      '  tun    透明代理，全局自动路由，需要 sudo\n' +
      '\n' +
      colors.cyan('数据目录:') +
      '\n' +
      '  环境变量 MIHOMO_CLI_DIR 可自定义位置\n' +
      '  默认: ' +
      config.USER_DATA_DIR +
      '\n',
  );
}

function printVersion() {
  const kv = config.getKernelVersion() || '未安装';
  console.log(colors.cyan(colors.bold('mihomo-cli v' + VERSION)));
  console.log(colors.gray('内核: ') + kv);
  console.log(colors.gray('数据目录: ') + config.USER_DATA_DIR);
}

function printStatus() {
  const status = processManager.getStatus();
  const info = config.getConfigInfo();
  const overwriteEnabled = overwrite.isOverwriteEnabled();
  const overwriteFiles = overwrite.listOverwriteFile().files;
  const activeSub = subscription.getActiveSubscription();

  console.log('');
  let modeLabel = '';
  if (info && status.running) {
    modeLabel = colors.cyan(info.tun ? ' (TUN)' : ' (Mixed)');
  }
  const statusText = status.running ? colors.green('● 运行中') : colors.yellow('○ 已停止');
  console.log(colors.gray('状态: ') + statusText + modeLabel);
  console.log(colors.gray('内核: ') + (status.kernelVersion || '未安装'));

  if (status.pid) {
    console.log(colors.gray('PID:  ') + status.pid);
    if (status.processInfo) {
      console.log(colors.gray('内存: ') + status.processInfo.memory);
    }
  }

  if (info) {
    if (info.mixedPort) {
      console.log(colors.gray('端口: ') + info.mixedPort);
    } else {
      let ports = [];
      if (info.httpPort) ports.push('HTTP:' + info.httpPort);
      if (info.socksPort) ports.push('SOCKS:' + info.socksPort);
      console.log(colors.gray('端口: ') + (ports.length > 0 ? ports.join(', ') : '未知'));
    }
  }

  if (activeSub) {
    let subLine = colors.gray('订阅: ') + activeSub.name;
    if (info) {
      subLine += ' (' + subscription.formatProxySummary(info) + ')';
    }
    console.log(subLine);
  } else {
    console.log(colors.gray('订阅: ') + '未配置');
  }

  if (overwriteEnabled && overwriteFiles.length > 0) {
    const names = overwriteFiles.map(f => f.name).join(', ');
    console.log(colors.gray('覆写: ') + colors.green('已启用') + ' (' + names + ')');
  } else if (overwriteEnabled) {
    console.log(colors.gray('覆写: ') + colors.green('已启用') + ' (无文件)');
  } else {
    console.log(colors.gray('覆写: ') + colors.yellow('已禁用'));
  }
  console.log('');
}

function handleStopResult(result) {
  if (result.remaining && result.remaining.length > 0) {
    console.error(colors.red('部分进程未终止:') + ' ' + result.remaining.join(', '));
    console.error('请手动运行: sudo pkill -9 mihomo');
    process.exit(1);
  }
}

async function cmdStart(args) {
  if (!config.hasKernel()) {
    console.error('错误: 未找到内核，请运行 "mihomo kernel"');
    process.exit(1);
  }

  const targetMode = args[1] === 'tun' ? 'tun' : 'mixed';

  const sub = subscription.getActiveSubscription();
  if (!sub) {
    console.error('错误: 没有订阅，请先添加订阅');
    process.exit(1);
  }

  await subscription.autoUpdateStaleSubscription();

  const status = processManager.getStatus();
  const hasProcess = status.running || status.allProcesses.length > 0;

  if (hasProcess) {
    const count = status.allProcesses.length > 0 ? status.allProcesses.length : 1;
    console.log('停止 ' + count + ' 个进程...');
  }

  handleStopResult(processManager.stop(true));

  if (hasProcess) {
    console.log(colors.green('已停止进程') + '\n');
  }

  let configInfo;
  try {
    configInfo = subscription.prepareConfigForStart(targetMode, sub.name);
  } catch (e) {
    console.error(colors.red('配置错误:') + ' ' + e.message);
    process.exit(1);
  }

  const modeLabel = targetMode === 'tun' ? 'TUN' : 'Mixed';
  console.log([colors.cyan(modeLabel), sub.name, subscription.formatProxySummary(configInfo)].join(' · '));

  try {
    const result = await processManager.start(targetMode);
    console.log(colors.green('已启动') + ' (PID ' + result.pid + ')');
    printStatus();
  } catch (e) {
    console.error(colors.red('启动失败:') + ' ' + e.message.split('\n')[0]);
    process.exit(1);
  }
}

async function cmdStop() {
  const pids = processManager.getAllMihomoPids();
  if (pids.length === 0) {
    console.log(colors.yellow('未在运行'));
    return;
  }

  console.log('停止 ' + pids.length + ' 个进程...');
  handleStopResult(processManager.stop(true));
  console.log(colors.green('已停止进程'));
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

  const success = processManager.openUrl(url);
  if (!success) {
    console.log('请手动访问上面的地址');
  }
}

function cmdLog(args) {
  const logPath = processManager.getLogPath();

  if (utils.hasFlag(args, '-o', '--open')) {
    processManager.openLogFile(logPath);
    return;
  }

  processManager.viewLogWithTail(logPath, { follow: true, lines: 50 });
}

function cmdLogs(args) {
  const targetName = utils.getNonFlagArg(args, 1);
  const lines = utils.parseIntArg(args, '-n', '--lines', 100);
  const openInViewer = utils.hasFlag(args, '-o', '--open');

  if (targetName) {
    let logPath;

    if (targetName === 'current' || targetName === '0') {
      logPath = processManager.getLogPath();
    } else {
      const parsedIdx = parseInt(targetName);
      if (!isNaN(parsedIdx) && parsedIdx > 0 && String(parsedIdx) === targetName) {
        const archiveLogs = processManager.listLogs();
        const archive = archiveLogs.archives[parsedIdx - 1];
        if (!archive) {
          console.error('错误: 未找到日志 "' + targetName + '"');
          console.log('使用 "mihomo logs" 查看可用日志列表');
          process.exit(1);
        }
        logPath = archive.path;
      } else {
        logPath = processManager.getLogPathByName(targetName);
      }
    }

    if (!logPath) {
      console.error('错误: 未找到日志 "' + targetName + '"');
      console.log('使用 "mihomo logs" 查看可用日志列表');
      process.exit(1);
    }

    if (openInViewer) {
      processManager.openLogFile(logPath);
      return;
    }

    processManager.viewLogWithTail(logPath, { follow: false, lines });
    return;
  }

  const logs = processManager.listLogs();
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
    const time = utils.formatDate(log.mtime);
    const size = utils.formatBytes(log.size);
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

async function cmdKernel(args) {
  const mirrorInfo = utils.parseMirrorArg(args);
  const effectiveMirror = mirrorInfo.mirror;

  if (effectiveMirror) {
    let mirrorDesc = mirrorInfo.type === 'all' ? ' (API和下载均使用镜像)' : ' (下载时使用镜像)';
    console.log('镜像: ' + effectiveMirror + mirrorDesc);
  }

  console.log('\n提示: 如果下载速度过慢或直连失败，可使用 --mirror 参数通过镜像下载');
  console.log('\n用法:');
  console.log('  mihomo kernel                    # 直连');
  console.log('  mihomo kernel --mirror           # 下载使用默认镜像 (v6.gh-proxy.org)');
  console.log('  mihomo kernel --mirror hk.gh-proxy.org  # 下载使用指定镜像');
  console.log('  mihomo kernel --mirror-all       # API请求和下载都使用默认镜像');
  console.log('  mihomo kernel --mirror-all hk.gh-proxy.org  # API和下载都使用指定镜像');

  console.log('\n可用镜像:');
  config.AVAILABLE_MIRRORS.forEach(m => {
    const isCurrent =
      effectiveMirror && (effectiveMirror.includes('//' + m + '/') || effectiveMirror.includes('//' + m + ':') || effectiveMirror.endsWith('//' + m));
    console.log('  ' + m + (isCurrent ? ' (当前)' : ''));
  });
  console.log('');

  console.log('检查内核更新...');

  try {
    const apiMirror = mirrorInfo.type === 'all' ? effectiveMirror : null;
    const info = await kernel.checkUpdate(apiMirror);
    console.log('当前: ' + info.current);
    console.log('最新: ' + info.latest);

    if (!info.needsUpdate) {
      console.log('已是最新版本');
    } else {
      console.log('\n正在下载...');
      const result = await kernel.downloadKernel(
        msg => {
          console.log(msg);
        },
        mirrorInfo.mirror,
        info.release,
      );
      console.log('\n已更新到 ' + result.version);
    }
  } catch (e) {
    console.error('\n更新失败: ' + e.message);
    if (e.response && e.response.data) {
      if (e.response.data.message) {
        console.error('原因: ' + e.response.data.message);
      }
      if (e.response.data.documentation_url) {
        console.error('文档: ' + e.response.data.documentation_url);
      }
    }
    process.exit(1);
  }
}

async function printSubscriptionList() {
  const updateResult = await subscription.autoUpdateStaleSubscription();
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
  console.log(colors.cyan('订阅列表:'));
  subs.forEach((s, i) => {
    const time = utils.formatDate(s.updated_at);
    const defaultMark = i === 0 ? colors.green(' [默认]') : '';
    const interval = s.update_interval || subscription.DEFAULT_UPDATE_INTERVAL_HOURS;
    console.log('  ' + (i + 1) + '. ' + s.name + defaultMark);
    console.log('    ' + colors.gray('更新:') + ' ' + time + ' (间隔: ' + interval + 'h)');

    if (s.username) {
      console.log('    ' + colors.gray('用户:') + ' ' + s.username);
    }
    if (s.download !== undefined || s.total !== undefined) {
      const used = (s.upload || 0) + (s.download || 0);
      const usedStr = utils.formatBytes(used);
      const totalStr = utils.formatBytes(s.total);
      let percentStr = '';
      if (s.total && s.total > 0) {
        const percent = Math.min((used / s.total) * 100, 100);
        percentStr = ' (' + percent.toFixed(1) + '%)';
      }
      console.log('    ' + colors.gray('流量:') + ' ' + usedStr + ' / ' + totalStr + percentStr);
    }
    if (s.expire !== undefined) {
      console.log('    ' + colors.gray('到期:') + ' ' + utils.formatTimestamp(s.expire));
    }
    if (s.web_page_url) {
      console.log('    ' + colors.gray('页面:') + ' ' + s.web_page_url);
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
          console.log(colors.green('✓') + ' ' + r.name + ': ' + colors.green('已更新') + ' (' + subscription.formatProxySummary(r) + ')');
        } else {
          console.log(colors.red('✗') + ' ' + r.name + ': ' + colors.red('失败') + ' (' + r.error.split('\n')[0] + ')');
        }
      });
      if (ok === 0) process.exit(1);
      console.log('');
      await printSubscriptionList();
      return;
    }

    const matches = subscription.findSubscriptionFuzzy(subs, name);
    const target = subscription.pickSingleSubscription(matches, name);

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

    const matches = subscription.findSubscriptionFuzzy(subs, name);
    const target = subscription.pickSingleSubscription(matches, name);

    const currentDefault = subscription.getActiveSubscription();
    const isAlreadyDefault = currentDefault && currentDefault.name === target.name;

    if (isAlreadyDefault) {
      console.log('"' + target.name + '" 已是当前默认订阅');
      console.log('');
      await printSubscriptionList();
      return;
    }

    const status = processManager.getStatus();
    const configInfo = config.getConfigInfo();
    const currentMode = configInfo && configInfo.tun ? 'tun' : 'mixed';

    const success = config.setDefaultSubscription(target.name);
    if (success) {
      console.log('已设置 "' + target.name + '" 为默认订阅');
    } else {
      console.error('错误: 未找到订阅 "' + name + '"');
      process.exit(1);
    }

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
      const matches = subscription.findSubscriptionFuzzy(subs, name);
      target = subscription.pickSingleSubscription(matches, name);
    } else {
      target = subs[0];
    }

    let webPageUrl = target.web_page_url;
    if (!webPageUrl) {
      console.log('订阅信息中缺少页面地址，正在更新订阅...');
      try {
        await subscription.downloadSubscription(target.url, target.name);
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
    const opened = processManager.openUrl(webPageUrl);
    if (!opened) {
      console.log('请手动访问上面的地址');
    }
    return;
  }

  console.error('错误: 未知的订阅命令');
  console.log('用法: mihomo sub [list|add|update|use|web]');
  process.exit(1);
}

async function cmdUpdate() {
  console.log('当前版本: ' + colors.cyan(VERSION));
  console.log('');
  console.log('正在更新 mihomo-cli...');
  console.log('');

  await new Promise(resolve => {
    const npm = spawn('npm', ['install', '-g', 'mihomo-cli'], { stdio: 'inherit' });

    npm.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        process.exit(code);
      }
    });

    npm.on('error', e => {
      console.error('执行失败: ' + e.message);
      process.exit(1);
    });
  });

  try {
    const { stdout } = await execAsync('npm list -g mihomo-cli --json --depth=0');
    const result = JSON.parse(stdout);
    const newVersion = result.dependencies?.['mihomo-cli']?.version;

    console.log('');
    if (newVersion) {
      console.log('更新完成，最新版本: ' + colors.green(newVersion));
    } else {
      console.log('更新完成');
    }
  } catch {
    console.log('');
    console.log('更新完成');
  }
}

async function confirmPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question(question + ' (y/N) ', a => {
      rl.close();
      resolve(a);
    });
  });
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

const RESET_TARGETS = [
  {
    id: 'subs',
    aliases: ['sub', 'subs', 'subscription', 'subscriptions'],
    label: '订阅',
    paths: () => [config.DIRS.subscriptions],
    needsStop: true,
  },
  {
    id: 'logs',
    aliases: ['log', 'logs'],
    label: '日志',
    paths: () => [config.DIRS.logs],
    needsStop: false,
  },
  {
    id: 'data',
    aliases: ['data'],
    label: '运行数据',
    paths: () => [config.DIRS.data],
    needsStop: true,
  },
  {
    id: 'runtime',
    aliases: ['runtime'],
    label: '运行时',
    paths: () => [config.DIRS.runtime],
    needsStop: true,
  },
  {
    id: 'settings',
    aliases: ['setting', 'settings', 'config'],
    label: '设置',
    paths: () => [config.PATHS.settingsFile],
    needsStop: false,
  },
  {
    id: 'kernel',
    aliases: ['kernel', 'core'],
    label: '内核',
    paths: () => [config.DIRS.core],
    needsStop: false,
    onAfter: () => config.clearKernelVersionCache(),
    checkEmpty: () => !config.hasKernel(),
    emptyMsg: '内核未安装，无需删除',
    warnIfRunning: true,
  },
  {
    id: 'overwrites',
    aliases: ['overwrite', 'overwrites', 'ow'],
    label: '覆写',
    paths: () => [config.DIRS.overwrites],
    needsStop: false,
  },
];

function resolveResetTargets(names) {
  const matched = [];
  const unmatched = [];
  for (const name of names) {
    const t = RESET_TARGETS.find(t => t.aliases.includes(name.toLowerCase()));
    if (t) {
      if (!matched.find(m => m.id === t.id)) matched.push(t);
    } else {
      unmatched.push(name);
    }
  }
  return { matched, unmatched };
}

async function cmdReset(args) {
  const flags = (args || []).filter(a => a.startsWith('-'));
  const names = (args || []).slice(1).filter(a => !a.startsWith('-'));
  const fullReset = flags.includes('--full') || flags.includes('-f');
  const skipConfirm = flags.includes('--yes') || flags.includes('-y');

  let targets;

  if (fullReset) {
    targets = RESET_TARGETS;
  } else if (names.length > 0) {
    const { matched, unmatched } = resolveResetTargets(names);
    if (unmatched.length > 0) {
      console.error('错误: 未知的重置目标: ' + unmatched.join(', '));
      console.log('');
      console.log('可用目标: ' + RESET_TARGETS.map(t => t.aliases[0]).join(', '));
      console.log('');
      console.log('示例:');
      console.log('  mihomo reset sub log      # 删除订阅和日志');
      console.log('  mihomo reset kernel       # 只删内核');
      console.log('  mihomo reset --full       # 删除全部');
      console.log('  mihomo reset              # 删除全部（保留设置、内核、覆写）');
      process.exit(1);
    }
    targets = matched;
  } else {
    targets = RESET_TARGETS.filter(t => !['settings', 'kernel', 'overwrites'].includes(t.id));
  }

  for (const t of targets) {
    if (t.checkEmpty && t.checkEmpty()) {
      if (targets.length === 1) {
        console.log(t.emptyMsg);
        return;
      }
    }
  }

  const needsStop = targets.some(t => t.needsStop);
  const warnRunning = targets.some(t => t.warnIfRunning);

  const pids = needsStop || warnRunning ? processManager.getAllMihomoPids() : [];

  if (needsStop && pids.length > 0) {
    console.log('停止 ' + pids.length + ' 个进程...');
    processManager.cleanupAll(true);
    for (let i = 0; i < processManager.PROCESS_WAIT_ATTEMPTS; i++) {
      if (processManager.getAllMihomoPids().length === 0) break;
      await new Promise(r => setTimeout(r, processManager.PROCESS_WAIT_INTERVAL));
    }
  } else if (warnRunning && pids.length > 0) {
    console.log(colors.yellow('警告: mihomo 正在运行 (PID ' + pids.join(', ') + ')，删除内核后将无法重新启动'));
  }

  console.log('将删除: ' + targets.map(t => t.label).join('、'));

  if (!skipConfirm && !(await confirmPrompt('确认?'))) {
    console.log('已取消');
    return;
  }

  for (const t of targets) {
    for (const p of t.paths()) {
      if (config.fsExistsSync(p)) {
        try {
          config.rmrf(p);
        } catch (e) {
          console.warn('  警告: 无法删除 ' + p + ': ' + e.message);
        }
      }
    }
    if (t.onAfter) t.onAfter();
  }

  config.ensureDirs();
  if (targets.some(t => t.id === 'settings')) {
    config.invalidateSettingsCache();
  }

  console.log(colors.green('已重置: ' + targets.map(t => t.label).join('、')));
}

function printOverwriteList() {
  const info = overwrite.listOverwriteFile();
  const statusText = info.enabled ? colors.green('已启用') : colors.yellow('已禁用');
  console.log(colors.gray('状态:') + ' ' + statusText);
  console.log(colors.gray('目录:') + ' ' + info.dir);
  console.log('');
  if (info.files.length === 0) {
    console.log('暂无覆写文件');
    console.log('');
    console.log('用法示例: 创建文件 ' + path.join(info.dir, '01-custom.yaml'));
    console.log('');
  } else {
    console.log(colors.cyan('覆写文件') + ' (' + info.files.length + ' 个，按顺序加载):');
    console.log('');
    info.files.forEach((f, i) => {
      const num = i < 10 ? ' ' + i : '' + i;
      console.log('  ' + num + '. ' + f.name);
      if (f.keys.length > 0) {
        console.log('    ' + colors.gray('字段:') + ' ' + f.keys.join(', '));
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

  const status = processManager.getStatus();
  const configInfo = config.getConfigInfo();
  const currentMode = configInfo && configInfo.tun ? 'tun' : 'mixed';

  if (action === 'on' || action === 'enable') {
    if (overwrite.isOverwriteEnabled()) {
      console.log('覆写配置已是启用状态');
      console.log('');
      printOverwriteList();
      return;
    }

    overwrite.setOverwriteEnabled(true);
    console.log('已启用覆写配置');

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
    if (!overwrite.isOverwriteEnabled()) {
      console.log('覆写配置已是禁用状态');
      console.log('');
      printOverwriteList();
      return;
    }

    overwrite.setOverwriteEnabled(false);
    console.log('已禁用覆写配置');

    if (status.running) {
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

function cmdDirectory(args) {
  const action = args && args[1];

  if (action === 'open') {
    const target = args[2];

    if (!target || target === 'root') {
      const displayLabel = '根目录';
      console.log('正在打开: ' + displayLabel);
      const success = processManager.openUrl(config.USER_DATA_DIR);
      if (!success) {
        console.log('请手动打开: ' + config.USER_DATA_DIR);
      }
      return;
    }

    const targetInfo = config.DIRECTORY_TARGETS[target.toLowerCase()];
    if (targetInfo) {
      const targetPath = targetInfo.path || config.USER_DATA_DIR;
      console.log('正在打开: ' + targetInfo.label);
      const success = processManager.openUrl(targetPath);
      if (!success) {
        console.log('请手动打开: ' + targetPath);
      }
      return;
    }

    console.error('错误: 未知的目录目标 "' + target + '"');
    console.log('');
    console.log('可用目标:');
    console.log('  root (默认)   根目录');
    Object.entries(config.DIRECTORY_TARGETS).forEach(([key, val]) => {
      if (key !== 'root') {
        console.log('  ' + key.padEnd(14) + val.label);
      }
    });
    console.log('');
    process.exit(1);
  }

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
    case 'upd':
    case 'update':
    case 'upgrade':
      await cmdUpdate();
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
