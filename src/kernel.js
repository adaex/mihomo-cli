// 内置模块
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 第三方模块
const { compareVersions } = require('compare-versions');

// 本地模块
const config = require('./config');
const utils = require('./utils');

// 常量定义
const GITHUB_REPO = 'MetaCubeX/mihomo';
const KERNEL_HTTP_TIMEOUT = 120000;
const KERNEL_MAX_CONTENT_LENGTH = 200 * 1024 * 1024;
const KERNEL_DOWNLOAD_TIMEOUT = 180000;

// 内核专用 HTTP 客户端（超时和容量较大，适合下载大文件）
const HTTP_CLIENT = utils.createHttpClient({
  timeout: KERNEL_HTTP_TIMEOUT,
  maxContentLength: KERNEL_MAX_CONTENT_LENGTH,
});

function withMirror(url, overrideMirror) {
  const mirror = overrideMirror !== undefined ? overrideMirror : config.getGitHubMirror();
  if (mirror && url.startsWith('https://github.com/')) {
    return mirror + url;
  }
  return url;
}

function getArch() {
  const arch = process.arch;
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'amd64';
  return arch;
}

function findMatchingAsset(assets, platform, arch) {
  const prefix = 'mihomo-' + platform + '-' + arch;
  const matchingAssets = assets.filter(a => {
    return (a.name.startsWith(prefix) && a.name.endsWith('.gz')) || (a.name.startsWith(prefix + '-') && a.name.endsWith('.gz'));
  });

  if (matchingAssets.length === 0) {
    return null;
  }

  if (matchingAssets.length === 1) {
    return matchingAssets[0];
  }

  const standardAsset = matchingAssets.find(a => {
    const nameWithoutGz = a.name.slice(0, -3);
    const parts = nameWithoutGz.split('-');
    const lastPart = parts[parts.length - 1];
    return /^v?\d+\.\d+\.\d+/.test(lastPart) && !nameWithoutGz.includes('-go');
  });

  if (standardAsset) {
    return standardAsset;
  }

  return matchingAssets[0];
}

async function getLatestRelease(repo) {
  const url = 'https://api.github.com/repos/' + repo + '/releases';
  const response = await HTTP_CLIENT.get(url);

  const releases = response.data;

  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error('无法获取版本信息');
  }

  const stableReleases = releases.filter(
    r =>
      !r.prerelease &&
      !r.tag_name.toLowerCase().includes('alpha') &&
      !r.tag_name.toLowerCase().includes('beta') &&
      !r.tag_name.toLowerCase().includes('prerelease'),
  );

  if (stableReleases.length > 0) {
    return stableReleases[0];
  }

  return releases[0];
}

async function checkUpdate() {
  const currentVersion = config.getKernelVersion();
  const latest = await getLatestRelease(GITHUB_REPO);
  const latestVersion = latest.tag_name;

  let needsUpdate = false;
  let currentDisplay = currentVersion || '未安装';

  if (!currentVersion) {
    needsUpdate = true;
  } else {
    try {
      needsUpdate = compareVersions(latestVersion.replace(/^v/, ''), currentVersion.replace(/^v/, '')) > 0;
    } catch (e) {
      needsUpdate = latestVersion !== currentVersion;
    }
  }

  return {
    current: currentDisplay,
    latest: latestVersion,
    needsUpdate,
    assets: latest.assets,
    htmlUrl: latest.html_url,
  };
}

function findBinaryInDir(dir) {
  const files = fs.readdirSync(dir);

  for (const f of files) {
    const fullPath = path.join(dir, f);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const found = findBinaryInDir(fullPath);
      if (found) return found;
      continue;
    }

    if (f === 'mihomo') {
      return fullPath;
    }
    if (f.includes('mihomo') && !f.endsWith('.gz')) {
      return fullPath;
    }
  }

  return null;
}

async function downloadKernel(progressCallback, mirror) {
  config.ensureDirs();

  const latest = await getLatestRelease(GITHUB_REPO);
  const arch = getArch();
  const platform = 'darwin';

  const asset = findMatchingAsset(latest.assets, platform, arch);

  if (!asset) {
    const available = latest.assets.map(a => a.name).join(', ');
    let hint = '';
    if (available) {
      hint = '\n  可用版本: ' + available;
    }
    throw new Error('未找到匹配的内核文件\n  平台: ' + platform + ', 架构: ' + arch + hint);
  }

  const downloadUrl = withMirror(asset.browser_download_url, mirror);
  const tempPath = path.join(config.DIRS.core, asset.name);

  if (progressCallback) {
    const sizeMB = (asset.size / 1024 / 1024).toFixed(2);
    progressCallback('下载内核: ' + asset.name + ' (' + sizeMB + ' MB)');
  }

  const response = await HTTP_CLIENT({
    method: 'get',
    url: downloadUrl,
    responseType: 'stream',
    timeout: KERNEL_DOWNLOAD_TIMEOUT,
  });

  const writer = fs.createWriteStream(tempPath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  if (progressCallback) {
    progressCallback('解压内核...');
  }

  const extractPath = config.DIRS.core;
  let extractedBinary = null;

  try {
    if (tempPath.endsWith('.tar.gz') || tempPath.endsWith('.tgz')) {
      execSync('tar -xzf "' + tempPath + '" -C "' + extractPath + '"', {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
    } else if (tempPath.endsWith('.gz')) {
      const baseName = path.basename(tempPath, '.gz');
      const outputPath = path.join(extractPath, baseName);
      execSync('gzip -dc "' + tempPath + '" > "' + outputPath + '"', {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      extractedBinary = outputPath;
    }
  } catch (e) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw new Error('解压失败: ' + e.message);
  }

  const foundBinary = extractedBinary || findBinaryInDir(extractPath);

  if (!foundBinary) {
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw new Error('解压后未找到可执行文件');
  }

  const targetPath = config.PATHS.mihomoBinary;

  if (foundBinary !== targetPath) {
    if (fs.existsSync(targetPath)) {
      fs.chmodSync(targetPath, 0o755);
      try {
        fs.unlinkSync(targetPath);
      } catch {}
    }
    fs.renameSync(foundBinary, targetPath);
  }

  fs.chmodSync(targetPath, 0o755);

  try {
    fs.unlinkSync(tempPath);
  } catch (e) {}

  config.clearKernelVersionCache();

  return {
    version: latest.tag_name,
    path: targetPath,
  };
}

module.exports = {
  GITHUB_REPO,
  KERNEL_HTTP_TIMEOUT,
  KERNEL_MAX_CONTENT_LENGTH,
  KERNEL_DOWNLOAD_TIMEOUT,
  checkUpdate,
  downloadKernel,
};
