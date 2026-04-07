const axios = require('axios');
const config = require('./config');
const utils = require('./utils');

const { colors } = utils;
const DEFAULT_UPDATE_INTERVAL_HOURS = 12;

const HTTP_CLIENT = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent': 'mihomo-cli/1.0',
  },
  maxContentLength: 50 * 1024 * 1024,
  maxBodyLength: 50 * 1024 * 1024,
});

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
  // 匹配 filename="..." 或 filename='...'
  const match = header.match(/filename\s*=\s*["']?([^"';\s]+)["']?/i);
  if (!match) return null;
  const filename = match[1];
  // 可能是 "glados.one/user@example.com" 格式，取最后一部分
  const parts = filename.split('/');
  return parts[parts.length - 1] || null;
}

function formatProxySummary(info) {
  const parts = [];
  if (info && info.proxyGroups > 0) parts.push(info.proxyGroups + ' 组');
  parts.push(((info && info.proxies) || 0) + ' 节点');
  return parts.join(', ');
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

  config.saveSubRawConfig(subName, content);

  // 提取 response headers 中的订阅信息
  const headers = response.headers;
  const userInfo = parseUserInfo(headers['subscription-userinfo']);
  const updateInterval = headers['profile-update-interval'] ? parseInt(headers['profile-update-interval']) : null;
  const webPageUrl = headers['profile-web-page-url'] || null;
  const username = parseUsernameFromContentDisposition(headers['content-disposition']);

  // 2. 动态数据 + updated_at 保存到缓存文件（settings 只存 name/url）

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

  const rawContent = config.readSubRawConfig(subName);
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
  downloadSubscription,
  prepareConfigForStart,
  formatProxySummary,
  tryUpdateOne,
  autoUpdateStaleSubscription,
};
