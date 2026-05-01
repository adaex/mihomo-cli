import { getConfigInfo } from '../config.js';
import * as processManager from '../process.js';
import {
  addSubscription,
  getSubscriptions,
  getSubscriptionsWithCache,
  readSubscriptionCache,
  removeSubscription,
  setDefaultSubscription,
} from '../settings.js';
import * as subscription from '../subscription.js';
import type { ProxyTestResult, Subscription } from '../types.js';
import { colors, formatBytes, formatDate, formatTimestamp, getNonFlagArg, parseIntArg } from '../utils.js';
import { cmdStart } from './start.js';

export function printTestResult(result: ProxyTestResult, index: number, total: number): void {
  const prefix = `[${index + 1}/${total}]`;
  if (result.delay !== null) {
    const delayColor = result.delay < 300 ? colors.green : result.delay < 800 ? colors.yellow : colors.red;
    console.log(`  ${prefix} ${colors.green('✓')} ${result.name} ${delayColor(`${result.delay}ms`)}`);
  } else {
    console.log(`  ${prefix} ${colors.red('✗')} ${result.name} ${colors.gray(result.error || 'timeout')}`);
  }
}

export function formatCleanSummary(result: { removedProxies: number; removedGroups: number; updatedGroups: number }): string {
  const parts = [`移除 ${result.removedProxies} 个节点`];
  if (result.removedGroups > 0) parts.push(`删除 ${result.removedGroups} 个空分组`);
  if (result.updatedGroups > 0) parts.push(`更新 ${result.updatedGroups} 个分组`);
  return parts.join(', ');
}

export function formatTestSummary(summary: { alive: number; dead: number; total: number }): string {
  return `结果: ${colors.green(`${summary.alive} 存活`)} / ${colors.red(`${summary.dead} 失败`)} / ${summary.total} 总计`;
}

function resolveActiveTestTarget(args: string[]): { target: Subscription; timeout: number; concurrency: number } {
  const subs = getSubscriptions();
  if (subs.length === 0) {
    console.error('错误: 没有订阅');
    process.exit(1);
  }

  const nameArg = getNonFlagArg(args, 2);
  const timeout = parseIntArg(args, '-t', '--timeout', 2000);
  const concurrency = parseIntArg(args, '-j', '--concurrency', 100);

  const activeSub = subscription.getActiveSubscription();
  let target: Subscription;
  if (nameArg) {
    const matches = subscription.findSubscriptionFuzzy(subs, nameArg);
    target = subscription.pickSingleSubscription(matches, nameArg);
  } else {
    if (!activeSub) {
      console.error('错误: 没有活跃订阅');
      process.exit(1);
    }
    target = activeSub;
  }

  const status = processManager.getStatus();
  if (!status.running) {
    console.error('错误: mihomo 未运行，请先启动 (mihomo start)');
    process.exit(1);
  }

  if (!activeSub || activeSub.name !== target.name) {
    console.error(`错误: 当前使用的订阅是 "${activeSub?.name}"，不是 "${target.name}"`);
    console.log(`请先切换: mihomo sub use ${target.name}`);
    process.exit(1);
  }

  return { target, timeout, concurrency };
}

async function printSubscriptionList(options?: { autoUpdate?: boolean }): Promise<void> {
  if (options?.autoUpdate !== false) {
    const updateResult = await subscription.autoUpdateStaleSubscription();
    if (updateResult.total > 0) console.log('');
  }
  const subs = getSubscriptionsWithCache();
  if (subs.length === 0) {
    console.log('没有订阅');
    console.log('');
    console.log('添加订阅: mihomo sub add <url> [name]');
    console.log('');
    return;
  }
  const activeSub = subscription.getActiveSubscription();
  console.log(colors.cyan('订阅列表:'));
  subs.forEach((s, i) => {
    const time = formatDate(s.updated_at);
    const defaultMark = activeSub && s.name === activeSub.name ? colors.green(' [使用中]') : '';
    const interval = s.update_interval || subscription.DEFAULT_UPDATE_INTERVAL_HOURS;
    console.log(`  ${i + 1}. ${s.name}${defaultMark}`);
    console.log(`    ${colors.gray('更新: ')}${time} (间隔: ${interval}h)`);

    if (s.username) {
      console.log(`    ${colors.gray('用户: ')}${s.username}`);
    }
    if (s.download !== undefined || s.total !== undefined) {
      const used = (s.upload || 0) + (s.download || 0);
      const usedStr = formatBytes(used);
      const totalStr = formatBytes(s.total);
      let percentStr = '';
      if (s.total && s.total > 0) {
        const percent = Math.min((used / s.total) * 100, 100);
        percentStr = ` (${percent.toFixed(1)}%)`;
      }
      console.log(`    ${colors.gray('流量: ')}${usedStr} / ${totalStr}${percentStr}`);
    }
    if (s.expire !== undefined) {
      console.log(`    ${colors.gray('到期: ')}${formatTimestamp(s.expire)}`);
    }
    if (s.web_page_url) {
      console.log(`    ${colors.gray('页面: ')}${s.web_page_url}`);
    }
  });
  console.log('');
  console.log('切换订阅: mihomo sub use <name>');
  console.log('新增订阅: mihomo sub add <url> [name]');
  console.log('更新订阅: mihomo sub update [name]');
  console.log('删除订阅: mihomo sub remove <name>');
  console.log('测试节点: mihomo sub test [name]');
  console.log('清理节点: mihomo sub clean [name]');
  console.log('打开页面: mihomo sub web [name]');
  console.log('');
}

export async function cmdSubscription(args: string[]): Promise<void> {
  const action = args[1];

  if (!action || action === 'list') {
    await printSubscriptionList();
    return;
  }

  if (action === 'add') {
    const url = args[2];
    const name = args[3] || 'default';

    if (!url?.startsWith('http')) {
      console.error('错误: 请提供有效的订阅 URL');
      process.exit(1);
    }

    console.log(`添加订阅: ${name}`);
    try {
      addSubscription(url, name);
      setDefaultSubscription(name);
      const info = await subscription.downloadSubscription(url, name);
      console.log(`已添加并切换到 "${name}" (${subscription.formatProxySummary(info)})`);
    } catch (e) {
      console.error(`添加失败: ${(e as Error).message}`);
      process.exit(1);
    }
    console.log('');
    await printSubscriptionList();
    return;
  }

  if (action === 'update') {
    const name = args[2];
    const subs = getSubscriptions();

    if (subs.length === 0) {
      console.error('错误: 没有订阅');
      process.exit(1);
    }

    if (!name) {
      console.log(`更新所有 ${subs.length} 个订阅...`);
      const results = await Promise.all(subs.map(subscription.tryUpdateOne));
      let ok = 0;
      for (const r of results) {
        if (r.success) {
          ok++;
          console.log(`${colors.green('✓')} ${r.name}: ${colors.green('已更新')} (${subscription.formatProxySummary(r)})`);
        } else {
          console.log(`${colors.red('✗')} ${r.name}: ${colors.red('失败')} (${(r.error || '').split('\n')[0]})`);
        }
      }
      if (ok === 0) process.exit(1);
      console.log('');
      await printSubscriptionList();
      return;
    }

    const matches = subscription.findSubscriptionFuzzy(subs, name);
    const target = subscription.pickSingleSubscription(matches, name);

    console.log(`更新订阅: ${target.name}`);
    try {
      const info = await subscription.downloadSubscription(target.url, target.name);
      console.log(`已更新 (${subscription.formatProxySummary(info)})`);
    } catch (e) {
      console.error(`更新失败: ${(e as Error).message}`);
      process.exit(1);
    }
    console.log('');
    await printSubscriptionList();
    return;
  }

  if (action === 'use') {
    const name = args[2];
    const subs = getSubscriptions();

    if (!name) {
      console.error('错误: 请指定订阅名称');
      if (subs.length > 0) {
        console.log('\n可用订阅:');
        for (const s of subs) console.log(`  ${s.name}`);
      }
      process.exit(1);
    }

    const matches = subscription.findSubscriptionFuzzy(subs, name);
    const target = subscription.pickSingleSubscription(matches, name);

    const currentDefault = subscription.getActiveSubscription();
    const isAlreadyDefault = currentDefault && currentDefault.name === target.name;

    if (isAlreadyDefault) {
      console.log(`"${target.name}" 已是当前使用的订阅`);
      console.log('');
      await printSubscriptionList();
      return;
    }

    const status = processManager.getStatus();
    const configInfo = getConfigInfo();
    const currentMode = configInfo?.tun ? 'tun' : 'mixed';

    const success = setDefaultSubscription(target.name);
    if (success) {
      console.log(`已切换到 "${target.name}"`);
    } else {
      console.error(`错误: 未找到订阅 "${name}"`);
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
    const subs = getSubscriptionsWithCache();

    if (subs.length === 0) {
      console.error('错误: 没有订阅');
      process.exit(1);
    }

    let target: { url: string; name: string };
    if (name) {
      const matches = subscription.findSubscriptionFuzzy(subs, name);
      target = subscription.pickSingleSubscription(matches, name);
    } else {
      target = subs[0];
    }

    const cached = getSubscriptionsWithCache().find(s => s.name === target.name);
    let webPageUrl = cached?.web_page_url;
    if (!webPageUrl) {
      console.log('订阅信息中缺少页面地址，正在更新订阅...');
      try {
        await subscription.downloadSubscription(target.url, target.name);
        const cache = readSubscriptionCache();
        if (cache[target.name]?.web_page_url) {
          webPageUrl = cache[target.name].web_page_url;
        } else {
          console.error('错误: 该订阅没有提供页面地址');
          process.exit(1);
        }
      } catch (e) {
        console.error(`更新失败: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    console.log(`打开订阅页面: ${webPageUrl}`);
    const opened = processManager.openUrl(webPageUrl as string);
    if (!opened) {
      console.log('请手动访问上面的地址');
    }
    return;
  }

  if (action === 'remove' || action === 'rm' || action === 'delete') {
    const name = args[2];
    const subs = getSubscriptions();

    if (!name) {
      console.error('错误: 请指定要删除的订阅名称');
      if (subs.length > 0) {
        console.log('\n可用订阅:');
        for (const s of subs) console.log(`  ${s.name}`);
      }
      process.exit(1);
    }

    const matches = subscription.findSubscriptionFuzzy(subs, name);
    const target = subscription.pickSingleSubscription(matches, name);

    const switchedTo = removeSubscription(target.name);
    console.log(`已删除订阅 "${target.name}"`);
    if (switchedTo) {
      console.log(`已自动切换到 "${switchedTo}"`);
    }

    console.log('');
    await printSubscriptionList({ autoUpdate: false });
    return;
  }

  if (action === 'clean') {
    const { target, timeout, concurrency } = resolveActiveTestTarget(args);

    console.log(`清理订阅 "${target.name}"...`);
    console.log(`超时: ${timeout}ms  并发: ${concurrency}`);
    console.log('');

    const result = await subscription.autoCleanSubscription(target.name, {
      timeout,
      concurrency,
      onResult: printTestResult,
    });

    console.log('');
    console.log(formatTestSummary(result.summary));

    if (result.removedProxies > 0) {
      console.log(`${colors.green('已清理')}: ${formatCleanSummary(result)}`);
    }

    console.log('');
    console.log('提示: 需要重启 mihomo 使更改生效 (mihomo start)');
    return;
  }

  if (action === 'test') {
    const { target, timeout, concurrency } = resolveActiveTestTarget(args);

    console.log(`测试订阅 "${target.name}" 的节点连通性...`);
    console.log(`超时: ${timeout}ms  并发: ${concurrency}`);
    console.log('');

    const summary = await subscription.testSubscriptionProxies(target.name, {
      timeout,
      concurrency,
      onResult: printTestResult,
    });

    console.log('');
    console.log(formatTestSummary(summary));

    return;
  }

  console.error('错误: 未知的订阅命令');
  console.log('用法: mihomo sub [list|use|add|update|remove|web|test|clean]');
  process.exit(1);
}
