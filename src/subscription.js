const axios = require('axios');
const config = require('./config');

const HTTP_CLIENT = axios.create({
  timeout: 60000,
  headers: {
    'User-Agent': 'mihomo-cli/1.0',
  },
  maxContentLength: 50 * 1024 * 1024,
  maxBodyLength: 50 * 1024 * 1024,
});

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

  let parsed;
  try {
    const yaml = require('js-yaml');
    parsed = yaml.load(content);
  } catch (e) {
    try {
      parsed = JSON.parse(content);
    } catch (e2) {
      throw new Error('订阅内容格式错误，无法解析为 YAML 或 JSON');
    }
  }

  if (!parsed) {
    throw new Error('订阅内容为空');
  }

  config.saveSubRawConfig(subName, content);

  const subs = config.getSubscriptions();
  const sub = subs.find(s => s.name === subName);
  if (sub) {
    sub.updatedAt = new Date().toISOString();
    config.writeSettings({ subscriptions: subs });
  }

  return {
    proxies: parsed.proxies ? parsed.proxies.length : 0,
    proxyGroups: parsed['proxy-groups'] ? parsed['proxy-groups'].length : 0,
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

module.exports = {
  downloadSubscription,
  prepareConfigForStart,
  hasConfig: config.hasConfig,
  getConfigInfo: config.getConfigInfo,
};
