import fs from 'node:fs';

import { colors } from './colors.js';
import { assertServiceLabelSafe, SERVICE_LABEL } from './constants.js';
import { CliError } from './errors.js';
import { DIRS, PATHS } from './paths.js';
import { cleanupAll, describePidCleanupFailure, reapPidWhenQuiet } from './process-stop.js';
import { runSudoScript, SudoAuthError } from './sudo.js';
import { shellQuote } from './text.js';
import type { CleanupResult } from './types.js';

/**
 * 遗留 root LaunchDaemon（v3.0–v4.0）的识别与清理，及残留内核清理结果的分档处置
 * （classifyResidueCleanup / buildRootResidueCleanupError）。为何保留对旧安装的清理
 * 见 docs/decisions.md D1。自 service.ts 拆出；既有消费方经 service.ts 的 re-export 取用。
 */

/**
 * 是否存在遗留的**系统级**安装（v3.0–v4.0 的 root LaunchDaemon，背景见 D1）。
 * 它带 KeepAlive 会持续拉起内核抢占端口，用户态 launchctl 动不了它——不认的话对用户就是
 * 「代理停不掉、CLI 说没装」的幽灵。只识别不自动清理：删 root 文件要提权，
 * 交由 uninstall 在用户明确要求时做。
 */
export function detectLegacySystemInstall(): boolean {
  return fs.existsSync(PATHS.systemDaemonPlist);
}

// === 状态解析（纯函数，单测锁定） ===

/** root 残留清理失败包装的上下文：主体动作进行到哪一步、重试入口，三个调用点各不相同 */
export interface RootResidueCleanupContext {
  /** 主体动作的结果描述，如「服务已停止，登录自启已关闭」；start 路径是「服务尚未启动」 */
  mainOutcome: string;
  /** 重新尝试清理的命令，如 'mihomo-cli stop' */
  retryCommand: string;
}

/**
 * 把 cleanupAll 的 root 清理结果包成 CliError——纯函数，供测试。
 * 统一说清三件关键事实：主体动作已完成到哪一步、root 残留还在（带 PID）、重试入口。
 * sudo 取消（scriptError 是 SudoAuthError；pidError 免提权、不可能是它）label 用
 * 「已取消」；其余失败保留原始消息（scriptError 优先——它先于 pid 收口发生）。
 * remaining 的归因按 scriptError 分：非空 = root 脚本没走通，残留按 root 论；
 * 空 = 没进过 root 分支，残留是用户态没能终止的，不许说成 root 属主。
 * remaining 为空时 **scriptError 优先于 pidError**：仅 pidError = pid 文件残留；
 * scriptError（无论是否并存 pidError）= 进程在死亡等待内自行退光、清理没走完，
 * 主归因随脚本、pid 文件错误只作附带——「可能仍有进程」比「文件残留」更需用户行动，
 * 被 pidError 盖成 rm 引导会漏掉潜在的存活内核
 */
export function buildRootResidueCleanupError(result: Pick<CleanupResult, 'remaining' | 'scriptError' | 'pidError'>, ctx: RootResidueCleanupContext): CliError {
  const { scriptError, pidError } = result;
  const cancelled = scriptError instanceof SudoAuthError;
  const hasKernelResidue = result.remaining.length > 0;
  const pidList = `PID ${result.remaining.join(', ')}`;
  const residueHint = hasKernelResidue
    ? scriptError
      ? `root 残留内核仍在运行（${pidList}），可能继续占用代理端口`
      : `残留内核仍在运行（${pidList}）——用户态未能终止，与提权无关`
    : scriptError
      ? `root 残留清理未完成，进程目前已不在（死亡等待内自行退出，非 sudo 清理）${pidError ? `；${describePidCleanupFailure(pidError)}` : ''}`
      : pidError
        ? `${describePidCleanupFailure(pidError)}: ${PATHS.pidFile}`
        : 'root 残留未清理干净';
  const hint = [ctx.mainOutcome, residueHint, `重新运行可再次尝试清理: ${ctx.retryCommand}`];
  // 有 kernel 残留、或脚本没走完（可能仍有进程）→ pkill 幂等兜底；仅 pid 文件残留才引导 rm
  hint.push(hasKernelResidue || scriptError ? '手动清理: sudo pkill -9 mihomo' : `手动清理: sudo rm -f ${PATHS.pidFile}`);
  if (cancelled) {
    return new CliError('管理员密码未输入或有误，root 残留未被清理', { label: '已取消', hint });
  }
  return new CliError(scriptError?.message ?? pidError?.message ?? 'root 残留未清理干净', { label: '清理残留进程失败', hint });
}

/**
 * 残留清理结果的三档处置（纯判据，供测试——真实 root/非 TTY 场景无法黑盒构造）：
 * - 'throw'：root 清理没走通且进程仍在（remaining + scriptError），主体动作结果要说清
 * - 'warn'：无残留进程但有收尾错误（pid 文件没删掉，或进程自行退光而清理没走完），
 *   无害不拦命令
 * - 'ok'：无问题；用户态残留（remaining 非空、无 scriptError）也归这档——交各命令
 *   外层既有的复核（cmdStop 抛、cmdUninstall 提示、start 健康确认）。pidError 是
 *   免提权 unlink 的小错，不参与 throw 分档：remaining 非空时它跟着外层的残留
 *   处置走，不单独拦命令
 */
export type ResidueCleanupVerdict = 'ok' | 'warn' | 'throw';

export function classifyResidueCleanup(result: Pick<CleanupResult, 'remaining' | 'scriptError' | 'pidError'>): ResidueCleanupVerdict {
  // 有进程活着：root 清理没走通（scriptError）才拦命令；用户态残留无论是否
  // 带着pidError 小错都交外层复核。进程清零：收尾错误只警告
  if (result.remaining.length > 0) return result.scriptError !== null ? 'throw' : 'ok';
  return result.scriptError !== null || result.pidError !== null ? 'warn' : 'ok';
}

/**
 * 服务路径的残留内核收口。唯一实现是 process-stop 的 cleanupAll
 * （用户态逐 pid 复核 / root 一次 sudo 脚本 + 死亡等待），抛错/警告判据见
 * classifyResidueCleanup。pid 文件免提权清理、失败只警告，非 TTY 的
 * `mihomo-cli stop` 不会被一个无害残留挡成 exit 1
 */
export async function cleanupKernelsOrThrow(ctx: RootResidueCleanupContext): Promise<void> {
  const result = await cleanupAll();
  const verdict = classifyResidueCleanup(result);
  if (verdict === 'ok') return;
  const err = buildRootResidueCleanupError(result, ctx);
  if (verdict === 'throw') throw err;
  console.warn(colors.yellow(`警告: ${err.message}`));
  for (const line of err.hint) console.warn(colors.gray(line));
}

/**
 * 生成遗留安装清理脚本的 body（写盘 + chmod + sudo + 退出码映射由 runSudoScript 统一完成）。
 * 导出仅为测试退出码协议：脚本内部失败用 ≥2 的退出码（bootout 真实失败为 3，
 * plist rm 后复核仍存在为 4），1 留给 sudo 鉴权取消/密码错误。
 *
 * 脚本**不删 pid 文件**：bootout 返回 113（daemon 未装载）时，pid 可能属于一个无关的
 * 活 TUN，脚本内无条件 rm 会删掉活进程的 isRunning 真相源。pid 由
 * cleanupLegacyInstallOrThrow 在拆除成功、复核零进程后免提权收口（reapPidWhenQuiet）
 */
export function buildLegacyCleanupScript(): string {
  return [
    '#!/bin/bash',
    // bootout 退出码分级：113=未装载（daemon 已不在，正常），其余是真实失败，
    // 不能 || true 吞掉后照样 rm plist 报「已清理」
    `bootout_code=0`,
    `launchctl bootout ${shellQuote(`system/${SERVICE_LABEL}`)} 2>/dev/null || bootout_code=$?`,
    `if [ $bootout_code -ne 0 ] && [ $bootout_code -ne 113 ]; then`,
    `  echo "launchctl bootout 失败（退出码 $bootout_code）" >&2`,
    `  exit 3`,
    `fi`,
    `rm -f ${shellQuote(PATHS.systemDaemonPlist)}`,
    // rm -f 静默吞错：删失败（文件系统只读等极端态）不声不响，而残留 plist 会在
    // 下次开机被 launchd 重新加载（KeepAlive 幽灵复活）——删除结果必须复核可见
    `if [ -e ${shellQuote(PATHS.systemDaemonPlist)} ]; then`,
    `  echo "遗留服务 plist 删除失败（rm 后仍存在）" >&2`,
    `  exit 4`,
    `fi`,
    `chown "$SUDO_UID:$SUDO_GID" ${shellQuote(PATHS.logFile)} 2>/dev/null || true`,
    `chown -R "$SUDO_UID:$SUDO_GID" ${shellQuote(DIRS.data)} 2>/dev/null || true`,
    'exit 0',
    '',
  ].join('\n');
}

/**
 * 清理遗留的系统级安装（v3.0–v4.0 的 root LaunchDaemon，背景见 D1）。
 *
 * 需要一次密码：plist 是 root:wheel 拥有的，且 `launchctl bootout system/...` 需 root。
 * 顺带把 root 属主的日志/数据归还当前用户——不归还的话，之后的用户级服务会因
 * EACCES 写不了日志而起不来。
 */
function cleanupLegacySystemInstall(): void {
  assertServiceLabelSafe();

  runSudoScript(buildLegacyCleanupScript(), {
    action: '清理遗留的系统级服务',
    file: 'legacy-cleanup.sh',
    // 3 = 脚本内 bootout 真实失败（见 buildLegacyCleanupScript 的分级）；
    // 4 = plist rm 后复核仍存在（rm -f 静默失败的可见化）；
    // 具体退出码已由脚本 echo 到终端，故只指向「上方输出」
    codeMessages: { 3: 'launchctl bootout 未能卸载旧 daemon（详见上方输出）', 4: '未能删除遗留服务的 plist（详见上方输出）' },
  });
}

/**
 * 清理遗留 root LaunchDaemon 并把 runSudoScript 的普通 Error 包成 CliError——
 * 否则 sudo 取消密码 / 非 TTY 这类常规操作会带完整堆栈按「未预期错误」渲染。
 * install / uninstall / stop / start(tun) / reset 共用。
 *
 * 放 service.ts 而非 commands/shared.ts：shared.ts 被 start.ts 导入（restartToApply），
 * 若 start.ts 再反向导入 shared.ts 就成环。放这里依赖方向单向（commands → service）。
 */
export async function cleanupLegacyInstallOrThrow(): Promise<void> {
  try {
    cleanupLegacySystemInstall();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError((e as Error).message, {
      label: '清理遗留服务失败',
      hint: ['也可手动清理:', `  sudo launchctl bootout system/$(basename ${PATHS.systemDaemonPlist} .plist)`, `  sudo rm -f ${PATHS.systemDaemonPlist}`],
    });
  }

  // 脚本不碰 pid：root 拆除成功后等进程收割，零进程才免提权删；并存的活 TUN 保留
  // 其 pid（status 真相）。删除失败只警告——迁移主体已完成，孤儿 pid 下次 stop 再清
  const pidError = await reapPidWhenQuiet();
  if (pidError) {
    console.warn(colors.yellow(`警告: ${describePidCleanupFailure(pidError)}，下次 stop 会再次尝试`));
  }
}
