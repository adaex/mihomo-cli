import { getConfigInfo } from '../config.js';
import * as processManager from '../process.js';
import { addSubscription, getSubscriptions, getSubscriptionsWithCache, readSubscriptionCache, setDefaultSubscription } from '../settings.js';
import * as subscription from '../subscription.js';
import { colors, formatBytes, formatDate, formatTimestamp } from '../utils.js';
import { cmdStart } from './start.js';

async function printSubscriptionList(): Promise<void> {
  const updateResult = await subscription.autoUpdateStaleSubscription();
  if (updateResult.total > 0) console.log('');

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
  console.log('更新订阅: mihomo sub update [name]');
  console.log('打开页面: mihomo sub web [name]');
  console.log('新增订阅: mihomo sub add <url> [name]');
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
      const info = await subscription.downloadSubscription(url, name);
      console.log(`已添加 (${subscription.formatProxySummary(info)})`);
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

  console.error('错误: 未知的订阅命令');
  console.log('用法: mihomo sub [list|add|update|use|web]');
  process.exit(1);
}
