import { spawnSync } from 'node:child_process';
import { colors } from '../colors.js';
import { UI_URLS } from '../constants.js';
import { CliError } from '../errors.js';
import { openUrl } from '../open.js';
import { getRunningState } from '../runtime.js';
import { getPorts, readSettings } from '../settings.js';
import { assertKnownFlags, assertPositionalCount, getNonFlagArg, hasFlag } from '../utils.js';

/**
 * 解析 UI 名称：未传参取默认 zash，传参就小写归一（与启动模式/目录目标/reset 同口径）。
 * 空串是变量展开为空的笔误（`ui "$UNSET"`），与未知名称一样报错，不能静默落到 zash。
 * 与 resolveStartMode 同范式：纯函数、抛 CliError，便于不打开浏览器地测试。
 */
export function resolveUiName(args: string[]): string {
  // 用 getNonFlagArg 而非 args[1]：`ui -c` / `ui -c dash` 时不能把 flag 当成 UI 名
  const raw = getNonFlagArg(args, 1);
  const name = (raw ?? 'zash').toLowerCase();
  if (name === '' || !Object.hasOwn(UI_URLS, name)) {
    throw new CliError(`未知的 UI "${raw ?? ''}"`, { hint: '可用 UI: zash (默认), dash, yacd' });
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
  assertKnownFlags(args.slice(1), ['-c', '--copy-secret'], 'ui [zash|dash|yacd] [-c]');
  // 名称至多一个：`ui zash extra` 此前静默忽略 extra；校验先于打开浏览器等副作用
  assertPositionalCount(args, 1, 1, 'mihomo ui [zash|dash|yacd] [-c]');
  const uiName = resolveUiName(args);
  const copySecret = hasFlag(args, '-c', '--copy-secret');

  // UI 依赖 external-controller，未运行时打开也连不上：先提醒再照常打开（用户可能只是想看看面板）
  if (!getRunningState().running) {
    console.log(colors.yellow('提示: mihomo 未运行，UI 暂时无法连接（先执行 mihomo start 启动）'));
    console.log('');
  }

  const url = UI_URLS[uiName];
  const controllerPort = getPorts().controller;

  console.log(`打开 Web UI: ${uiName}`);
  console.log(`页面: ${url}`);
  // 控制器地址固定打印：托管网页默认连 127.0.0.1:9090，自定义端口后这里是唯一可见的
  // 实际连接地址（排查「UI 连不上」全靠它）
  console.log(`控制器: http://127.0.0.1:${controllerPort}`);

  // 非字符串值在 buildConfig 时会报错（start/doctor/config 路径），这里只读 settings
  // 展示 UI 信息，单独收口：不把数字/布尔塞进 pbcopy 或当成密钥提示
  const secret = readSettings().controller_secret;
  if (typeof secret === 'string' && secret) {
    if (copySecret) {
      // 显式 -c 才动剪贴板：默认复制会悄悄覆盖用户原有内容，且通用剪贴板可能同步到
      // 同 Apple ID 的其他设备；复制与否由用户当次决定
      console.log(
        copyToClipboard(secret) ? '访问密钥已复制到剪贴板，UI 连接时粘贴' : colors.yellow('访问密钥复制失败，请到 settings.json 查看 controller_secret'),
      );
    } else {
      console.log(colors.gray('已配置访问密钥，UI 连接时需输入（mihomo ui -c 可复制到剪贴板）'));
    }
  }
  console.log('');

  // 地址已在上面打印：openUrl 是 detached spawn，检不出失败（见 open.ts），
  // 浏览器没弹出时用户可自行复制上面那行
  openUrl(url);
}
