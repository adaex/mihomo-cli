import { colors } from '../colors.js';
import { UI_URLS } from '../constants.js';
import { CliError } from '../errors.js';
import * as processManager from '../process.js';
import { getRunningState } from '../runtime.js';
import { readSettings } from '../settings.js';

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
    console.log('已配置访问密钥（UI 连接 127.0.0.1:9090 时需输入，密钥见 settings.json）');
  }

  const success = processManager.openUrl(url);
  if (!success) {
    console.log('请手动访问上面的地址');
  }
}
