// 内置模块
// （无内置模块依赖）

// 第三方模块
const axios = require('axios');

// 本地模块
const config = require('./config');
const utils = require('./utils');

const { colors } = utils;
const DEFAULT_UPDATE_INTERVAL_HOURS = 12;

// 订阅专用 HTTP 客户端（超时较短，适合下载订阅配置）
const HTTP_CLIENT = utils.createHttpClient({
  timeout: 60000,
  maxContentLength: 50 * 1024 * 1024,
});

// 订阅查找常量（从 index.js 移入）
const MATCH_EXACT = 'exact';
const MATCH_PREFIX = 'prefix';
const MATCH_INCLUDES = 'includes';

function parseUserInfo(header) {
  if (!header) return null;
  const info = {};
  const parts = header.split(';').map(p => p.trim());
  for (const part of parts) {
    const [key, val] = part.split('=').map(s => s.trim());
    if (key && val !== undefined) {
      const numVal = parseFloat(val);
      info[key] = isNaN(numVal) ? val : numVal;
    }
  }
  return info;
}

function parseUsernameFromContentDisposition(header) {
  if (!header) return null;
  const match = header.match(/filename\s*=\s*["']?([^"';\s]+)["']?/i);
  if (!match) return null;
  const filename = match[1];
  const parts = filename.split('/');
  return parts[parts.length - 1] || null;
}

function formatProxySummary(info) {
  const parts = [];
  if (info && info.proxyGroups > 0) parts.push(info.proxyGroups + ' 组');
  parts.push(((info && info.proxies) || 0) + ' 节点');
  return parts.join(', ');
}

/**
 * 获取当前默认订阅（从 index.js 移入）
 */
function getActiveSubscription() {
  const subs = config.getSubscriptions();
  if (subs.length === 0) {
    return null;
  }
  return subs[0];
}

/**
 * 模糊查找订阅（从 index.js 移入）
 */
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

/**
 * 从匹配列表中选择单个订阅（从 index.js 移入）
 * 如果匹配多个，打印错误并退出进程
 */
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

async function downloadSubscription(url, subName) {
  if (subName === undefined) subName = 'default';

  let response;
  try {
    response = await HTTP_CLIENT.get(url, {
      responseType: 'text',
    });
  } catch (e) {
    const maskedUrl = config.maskUrl(url);
    let errorMsg = '获取订阅失败: ' + e.message;
    if (e.response) {
      errorMsg += ' (HTTP ' + e.response.status + ')';
    }
    errorMsg += '\n  URL: ' + maskedUrl;
    throw new Error(errorMsg);
  }

  const content = response.data;
  if (!content || !content.trim()) {
    throw new Error('订阅内容为空');
  }

  const parsed = config.parseYamlOrJson(content, '订阅内容');
  if (!parsed) {
    throw new Error('订阅内容为空');
  }

  config.saveSubscriptionRawConfig(subName, content);

  const headers = response.headers;
  const userInfo = parseUserInfo(headers['subscription-userinfo']);
  const updateInterval = headers['profile-update-interval'] ? parseInt(headers['profile-update-interval']) : null;
  const webPageUrl = headers['profile-web-page-url'] || null;
  const username = parseUsernameFromContentDisposition(headers['content-disposition']);

  const cacheData = {
    updated_at: new Date().toISOString(),
  };
  if (userInfo) {
    cacheData.upload = userInfo.upload;
    cacheData.download = userInfo.download;
    cacheData.total = userInfo.total;
    cacheData.expire = userInfo.expire;
  }
  if (updateInterval) {
    cacheData.update_interval = updateInterval;
  }
  if (webPageUrl) {
    cacheData.web_page_url = webPageUrl;
  }
  if (username) {
    cacheData.username = username;
  }
  config.saveSubscriptionCache(subName, cacheData);

  return {
    proxies: parsed.proxies ? parsed.proxies.length : 0,
    proxyGroups: parsed['proxy-groups'] ? parsed['proxy-groups'].length : 0,
    userInfo,
    updateInterval,
    webPageUrl,
    username,
  };
}

function prepareConfigForStart(mode, subName) {
  if (subName === undefined) subName = 'default';

  const rawContent = config.readSubscriptionRawConfig(subName);
  if (!rawContent) {
    throw new Error('未找到订阅配置 "' + subName + '"，请先添加订阅');
  }

  const mergedConfig = config.buildConfig(rawContent, mode);
  config.writeMihomoConfig(mergedConfig);

  return {
    proxies: mergedConfig.proxies ? mergedConfig.proxies.length : 0,
    proxyGroups: mergedConfig['proxy-groups'] ? mergedConfig['proxy-groups'].length : 0,
  };
}

function needsAutoUpdate(sub) {
  if (!sub.updated_at) return true;
  const lastUpdate = new Date(sub.updated_at).getTime();
  if (isNaN(lastUpdate)) return true;
  const intervalHours = sub.update_interval || DEFAULT_UPDATE_INTERVAL_HOURS;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return Date.now() - lastUpdate > intervalMs;
}

async function tryUpdateOne(sub) {
  try {
    const info = await downloadSubscription(sub.url, sub.name);
    return { name: sub.name, success: true, proxies: info.proxies, proxyGroups: info.proxyGroups };
  } catch (e) {
    return { name: sub.name, success: false, error: e.message };
  }
}

async function autoUpdateStaleSubscription() {
  const allSubs = config.getSubscriptionsWithCache();
  const staleSubs = allSubs.filter(needsAutoUpdate);

  if (staleSubs.length === 0) {
    return { total: 0, updated: 0, failed: 0 };
  }

  if (staleSubs.length === 1) {
    const sub = staleSubs[0];
    const interval = sub.update_interval || DEFAULT_UPDATE_INTERVAL_HOURS;
    console.log('订阅 "' + sub.name + '" 超过 ' + interval + ' 小时未更新，正在更新...');
  } else {
    console.log('检查到 ' + staleSubs.length + ' 个订阅需要更新，正在并行更新...');
  }

  const results = await Promise.all(staleSubs.map(tryUpdateOne));
  let updatedCount = 0;

  results.forEach(r => {
    if (r.success) {
      updatedCount++;
      console.log(colors.green('✓') + ' ' + r.name + ': ' + colors.green('已更新') + ' (' + formatProxySummary(r) + ')');
    } else {
      console.log(colors.red('✗') + ' ' + r.name + ': ' + colors.red('失败') + ' (' + r.error.split('\n')[0] + ')');
    }
  });

  return {
    total: staleSubs.length,
    updated: updatedCount,
    failed: staleSubs.length - updatedCount,
  };
}

module.exports = {
  DEFAULT_UPDATE_INTERVAL_HOURS,
  getActiveSubscription,
  findSubscriptionFuzzy,
  pickSingleSubscription,
  downloadSubscription,
  prepareConfigForStart,
  formatProxySummary,
  tryUpdateOne,
  autoUpdateStaleSubscription,
};
