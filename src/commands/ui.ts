import { spawnSync } from 'node:child_process';
import { colors } from '../colors.js';
import { UI_URLS } from '../constants.js';
import { CliError } from '../errors.js';
import { openUrl } from '../open.js';
import { getRunningState } from '../runtime.js';
import { getPorts, readSettings } from '../settings.js';
import { assertKnownFlags, assertPositionalCount } from '../utils.js';

/**
 * 解析 UI 名称：未传参取默认 zash，传了就小写归一（与启动模式/目录目标/reset 同口径）。
 * 空串是变量展开为空的笔误（`ui "$UNSET"`），与未知名称一样报错，不能静默落到 zash。
 * 与 resolveStartMode 同范式：纯函数、抛 CliError，便于不打开浏览器地测试。
 */
export function resolveUiName(args: string[]): string {
  const name = (args[1] ?? 'zash').toLowerCase();
  if (name === '' || !Object.hasOwn(UI_URLS, name)) {
    throw new CliError(`未知的 UI "${args[1] ?? ''}"`, { hint: '可用 UI: zash (默认), dash, yacd' });
  }
  return name;
}

/** 复制到剪贴板（macOS pbcopy）；失败返回 false，调用方回退到手动提示 */
function copyToClipboard(text: string): boolean {
  try {
    return spawnSync('pbcopy', [], { input: text }).status === 0;
  } catch {
    return false;
  }
}

export function cmdUI(args: string[]): void {
  assertKnownFlags(args.slice(1), [], 'ui');
  // 名称至多一个：`ui zash extra` 此前静默忽略 extra；校验先于打开浏览器等副作用
  assertPositionalCount(args, 1, 1, 'mihomo ui [zash|dash|yacd]');
  const uiName = resolveUiName(args);

  // UI 依赖 external-controller，未运行时打开也连不上：先提醒再照常打开（用户可能只是想看看面板）
  if (!getRunningState().running) {
    console.log(colors.yellow('提示: mihomo 未运行，UI 暂时无法连接（先执行 mihomo start 启动）'));
    console.log('');
  }

  const url = UI_URLS[uiName];

  console.log(`打开 Web UI: ${uiName}`);
  console.log(`地址: ${url}`);

  // 非字符串值在 buildConfig 时会报错（start/doctor/config 路径），这里只读 settings
  // 展示 UI 信息，单独收口：不把数字/布尔塞进 pbcopy 或当成密钥提示
  const secret = readSettings().controller_secret;
  if (typeof secret === 'string' && secret) {
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
