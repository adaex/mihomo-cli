import { UI_URLS } from '../constants.js';
import * as processManager from '../process.js';
import { readSettings } from '../settings.js';
import { CliError } from '../utils.js';

export function cmdUI(args: string[]): void {
  const uiName = args[1] || 'zash';

  if (!Object.hasOwn(UI_URLS, uiName)) {
    throw new CliError(`未知的 UI "${uiName}"`, { hint: '可用 UI: zash (默认), dash, yacd' });
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
