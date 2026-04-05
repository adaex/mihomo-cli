const axios = require('axios');
const yaml = require('js-yaml');
const config = require('./config');

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

function formatBytes(bytes) {
  if (bytes === undefined || bytes === null) return '未知';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTimestamp(ts) {
  if (!ts) return '未知';
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  } catch {
    return '未知';
  }
}

function formatDate(dateOrIso) {
  if (!dateOrIso) return '未知';
  try {
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
    if (isNaN(d.getTime())) return '未知';
    return d.toLocaleString('zh-CN');
  } catch {
    return '未知';
  }
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

  // 1. updatedAt 保存到 settings.json（元数据，用于判断更新间隔）
  // 同时清理旧的动态字段（迁移到缓存文件）
  const subs = config.getSubscriptions();
  const subIndex = subs.findIndex(s => s.name === subName);
  if (subIndex >= 0) {
    // 只保留核心配置字段，动态字段已迁移到缓存
    const cleanedSub = {
      name: subs[subIndex].name,
      url: subs[subIndex].url,
      updatedAt: new Date().toISOString(),
    };
    subs[subIndex] = cleanedSub;
    config.writeSettings({ subscriptions: subs });
  }

  // 2. 动态数据保存到缓存文件
  const cacheData = {};
  if (userInfo) {
    cacheData.upload = userInfo.upload;
    cacheData.download = userInfo.download;
    cacheData.total = userInfo.total;
    cacheData.expire = userInfo.expire;
  }
  if (updateInterval) {
    cacheData.updateInterval = updateInterval;
  }
  if (webPageUrl) {
    cacheData.webPageUrl = webPageUrl;
  }
  if (username) {
    cacheData.username = username;
  }
  config.saveSubCache(subName, cacheData);

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
  if (!sub.updatedAt) return true;
  const lastUpdate = new Date(sub.updatedAt).getTime();
  if (isNaN(lastUpdate)) return true;
  const intervalHours = sub.updateInterval || DEFAULT_UPDATE_INTERVAL_HOURS;
  const intervalMs = intervalHours * 60 * 60 * 1000;
  return (Date.now() - lastUpdate) > intervalMs;
}

async function tryUpdateOne(sub) {
  try {
    const info = await downloadSubscription(sub.url, sub.name);
    return { name: sub.name, success: true, proxies: info.proxies };
  } catch (e) {
    return { name: sub.name, success: false, error: e.message };
  }
}

async function autoUpdateStaleSubscriptions() {
  const allSubs = config.getSubscriptionsWithCache();
  const staleSubs = allSubs.filter(needsAutoUpdate);

  if (staleSubs.length === 0) {
    return { total: 0, updated: 0, failed: 0 };
  }

  if (staleSubs.length === 1) {
    const sub = staleSubs[0];
    const interval = sub.updateInterval || DEFAULT_UPDATE_INTERVAL_HOURS;
    console.log('  订阅 "' + sub.name + '" 超过 ' + interval + ' 小时未更新，正在更新...');
  } else {
    console.log('  检查到 ' + staleSubs.length + ' 个订阅需要更新，正在并行更新...');
  }

  const results = await Promise.all(staleSubs.map(tryUpdateOne));
  let updatedCount = 0;

  results.forEach(r => {
    if (r.success) {
      updatedCount++;
      console.log('  ✓ ' + r.name + ': 已更新 (' + r.proxies + ' 节点)');
    } else {
      console.log('  ✗ ' + r.name + ': 更新失败，使用本地缓存');
      console.log('    原因: ' + r.error.split('\n')[0]);
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
  hasConfig: config.hasConfig,
  getConfigInfo: config.getConfigInfo,
  formatBytes,
  formatTimestamp,
  formatDate,
  tryUpdateOne,
  autoUpdateStaleSubscriptions,
};
