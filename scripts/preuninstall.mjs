#!/usr/bin/env node
// npm 卸载前提示。**只警告、不自动卸载服务**：
// `mihomo update`（npm 升级）也会触发旧版本的 preuninstall，若在这里自动 uninstall，
// 每次升级都会把用户的 LaunchAgent 删掉。升级场景让用户忽略提示即可；真正卸载时
// CLI 在 preuninstall 阶段仍在 PATH，用户来得及中止后先跑 `mihomo uninstall`。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_LABEL = 'com.mihomo-cli.daemon';

/** 只读探测：服务是否装载、plist 与数据目录是否存在。纯函数化以便 spec 隔离 HOME/label 验证 */
export function inspectInstallation(env = process.env) {
  const label = env.MIHOMO_CLI_DAEMON_LABEL || DEFAULT_LABEL;
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const home = env.HOME || os.homedir();
  const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const dataDir = env.MIHOMO_CLI_DIR || path.join(home, '.mihomo-cli');

  let loaded = false;
  if (uid >= 0) {
    const r = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'ignore' });
    loaded = r.status === 0;
  }

  return {
    label,
    uid,
    plist,
    plistExists: fs.existsSync(plist),
    loaded,
    dataDir,
    dataExists: fs.existsSync(dataDir),
  };
}

/** 组装提示正文（纯函数） */
export function buildNotice(i) {
  return [
    '⚠️  mihomo-cli：npm 卸载只移除 npm 包，不会停止 launchd 服务、也不会删除数据目录',
    `   服务 label : ${i.label}（${i.loaded ? '当前已装载' : '未装载'}）`,
    `   LaunchAgent: ${i.plist}${i.plistExists ? '' : '（不存在）'}`,
    `   数据目录   : ${i.dataDir}${i.dataExists ? '' : '（不存在）'}`,
    '',
    '   · 若正在升级（mihomo update），忽略本提示即可，升级后服务与数据不变',
    '   · 若确实要卸载，请中止后先运行: mihomo uninstall',
    '   · CLI 已被移除后只能手动清理:',
    `       launchctl bootout gui/${i.uid}/${i.label} 2>/dev/null; rm -f ${i.plist}`,
    `       rm -rf ${i.dataDir}   # 订阅、内核、日志等全部数据`,
    '',
  ].join('\n');
}

function main() {
  const i = inspectInstallation();
  // 全都不存在：纯包卸载，无需打扰（常见于 CI、临时环境）
  if (!i.loaded && !i.plistExists && !i.dataExists) return;
  console.error(`\n${buildNotice(i)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
