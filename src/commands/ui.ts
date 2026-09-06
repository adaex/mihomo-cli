import { spawnSync } from 'node:child_process';

import { colors } from '../colors.js';
import { UI_URLS } from '../constants.js';
import { CliError } from '../errors.js';
import { openUrl } from '../open.js';
import { getRunningState } from '../runtime.js';
import { getPorts, readSettings } from '../settings.js';

/** 复制到剪贴板（macOS pbcopy）；失败返回 false，调用方回退到手动提示 */
function copyToClipboard(text: string): boolean {
  try {
    return spawnSync('pbcopy', [], { input: text }).status === 0;
  } catch {
    return false;
  }
}

export function cmdUI(args: string[]): void {
  const uiName = args[1] || 'zash';

  if (!Object.hasOwn(UI_URLS, uiName)) {
    throw new CliError(`未知的 UI "${uiName}"`, { hint: '可用 UI: zash (默认), dash, yacd' });
  }

  // UI 依赖 external-controller，未运行时打开也连不上：先提醒再照常打开（用户可能只是想看看面板）
  if (!getRunningState().running) {
    console.log(colors.yellow('提示: mihomo 未运行，UI 暂时无法连接（先执行 mihomo start 启动）'));
    console.log('');
  }

  const url = UI_URLS[uiName];

  console.log(`打开 Web UI: ${uiName}`);
  console.log(`地址: ${url}`);

  const secret = readSettings().controller_secret;
  if (secret) {
    // 用户接下来就要在 UI 里粘贴密钥：顺手放进剪贴板，省一次翻 settings.json
    console.log(
      copyToClipboard(secret)
        ? '已配置访问密钥（已复制到剪贴板，UI 连接时粘贴）'
        : `已配置访问密钥（UI 连接 127.0.0.1:${getPorts().controller} 时需输入，密钥见 settings.json）`,
    );
  }

  // 地址已在上面打印：openUrl 是 detached spawn，检不出失败（见 open.ts），
  // 浏览器没弹出时用户可自行复制上面那行
  openUrl(url);
}
