import { UI_URLS } from '../constants.js';
import * as processManager from '../process.js';

export function cmdUI(args: string[]): void {
  const uiName = args[1] || 'zash';

  if (!Object.hasOwn(UI_URLS, uiName)) {
    console.error(`错误: 未知的 UI "${uiName}"`);
    console.error('可用 UI: zash (默认), dash, yacd');
    process.exit(1);
  }

  const url = UI_URLS[uiName];

  console.log(`打开 Web UI: ${uiName}`);
  console.log(`地址: ${url}`);

  const success = processManager.openUrl(url);
  if (!success) {
    console.log('请手动访问上面的地址');
  }
}
