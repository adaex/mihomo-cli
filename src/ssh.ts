import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { BASE_CONFIG, CONTROLLER_PORT } from './constants.js';
import { CliError } from './errors.js';
import { registerCleanup } from './lifecycle.js';
import { atomicWriteFileSync, DIRS, ensureDirs } from './paths.js';
import { isProcessCommandMatching, isProcessRunning } from './process-probe.js';
import { getSshTunnels, updateSettings, validateSshName } from './settings.js';
import type { Settings, SshConfig, SshRuntime, SshStatus } from './types.js';
import { sleepSync } from './utils.js';

/**
 * ssh -D 动态转发隧道的**进程侧**：启停与真实状态。
 *
 * 配置侧（ssh.<name>.yaml 的加载、节点合成、与主配置合并）在 ssh-config.ts。
 * 分家是为了依赖方向：config.ts 要用配置侧，而本模块依赖 process-probe.ts、
 * process-probe.ts 又依赖 config.ts——不拆会成环。
 *
 * 放 src/ 而非 commands/：commands 的 start/stop/status 三处都要用它，
 * 放命令层会造成命令层互相 import。
 *
 * 也刻意不并入 runtime.ts 门面——那个门面收敛的是「普通进程 vs launchd 保活」双轨，
 * 隧道是与内核无关的第三方进程，不属于该双轨。
 */

/** 端口探测超时：status 会对每条隧道各探一次，且 printStatus 是裸 `mihomo` 的入口，必须短 */
const PORT_PROBE_TIMEOUT_MS = 300;

/** 停止隧道时等待退出的轮询参数（SIGTERM 后最多等 2 秒再 SIGKILL），同 test-instance 的口径 */
const STOP_WAIT_ATTEMPTS = 20;
const STOP_WAIT_INTERVAL = 100;

/** 启动后等待 ssh 建立转发的轮询上限：ConnectTimeout=15，故留 20 秒余量 */
const START_WAIT_ATTEMPTS = 40;
const START_WAIT_INTERVAL = 500;

/**
 * mihomo 自身占用的端口，隧道不得与之冲突。取自 constants 而非硬编码，
 * 上游改端口时这里自动跟随。
 */
function getReservedPorts(): Map<number, string> {
  const reserved = new Map<number, string>();
  const mixedPort = Number(BASE_CONFIG['mixed-port']);
  if (Number.isInteger(mixedPort)) reserved.set(mixedPort, 'mihomo 混合代理端口');
  reserved.set(CONTROLLER_PORT, 'mihomo 控制器端口');
  return reserved;
}

// === 名称与参数校验 ===

/**
 * ssh 目标主机校验。**以 `-` 开头会被 ssh 当选项解析**，
 * `--host -oProxyCommand=<任意命令>` 即任意命令执行——这是本模块最重要的一条校验。
 * 同时限定字符集，排除空格与 shell 元字符（虽然 spawn 不经 shell，但仍防误配）。
 */
const SAFE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function validateSshHost(host: string): void {
  if (!host) {
    throw new CliError('缺少 --host', { hint: ['例如: mihomo ssh add work --host m4 --port 1080'] });
  }
  if (host.startsWith('-')) {
    throw new CliError(`主机名无效: "${host}"`, {
      label: '参数错误',
      hint: ['主机名不能以 "-" 开头——它会被 ssh 当作选项解析（如 -oProxyCommand=... 可执行任意命令）。'],
    });
  }
  if (!SAFE_HOST_RE.test(host)) {
    throw new CliError(`主机名无效: "${host}"，只允许字母、数字、点、下划线、短横线和 @`, {
      label: '参数错误',
      hint: ['可用 ssh 别名（~/.ssh/config 里的 Host）或 user@hostname。'],
    });
  }
}

/** 端口校验：上界、与 mihomo 自身端口冲突、与其他隧道重复。`exclude` 为改动自身时跳过的隧道名。 */
export function validateSshPort(port: number, exclude?: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`端口无效: ${port}，需为 1-65535 的整数`);
  }
  const reservedLabel = getReservedPorts().get(port);
  if (reservedLabel) {
    throw new CliError(`端口 ${port} 已被 ${reservedLabel} 占用`, {
      label: '端口冲突',
      hint: ['请换一个端口，例如 1080。'],
    });
  }
  const conflict = getSshTunnels().find(t => t.port === port && t.name !== exclude);
  if (conflict) {
    throw new CliError(`端口 ${port} 已被隧道 "${conflict.name}" 使用`, { label: '端口冲突' });
  }
}

// === 隧道列表（settings.json） ===

export function findSshTunnel(name: string): SshConfig | undefined {
  return getSshTunnels().find(t => t.name === name);
}

export function addSshTunnel(config: SshConfig): void {
  validateSshName(config.name);
  validateSshHost(config.host);
  validateSshPort(config.port);
  // 经 updateSettings：隧道与订阅同住 settings.json，慢速 `sub add` 期间执行本命令，
  // 此前会被对方拿陈旧缓存全量写回抹掉，而这里已经打印过「已添加」
  let duplicate = false;
  updateSettings(() => {
    const tunnels = [...getSshTunnels()];
    if (tunnels.some(t => t.name === config.name)) {
      duplicate = true;
      return {};
    }
    tunnels.push(config);
    return { ssh: tunnels } as Partial<Settings>;
  });
  if (duplicate) {
    throw new CliError(`隧道 "${config.name}" 已存在，请换个名称，或先删除（mihomo ssh rm ${config.name}）`);
  }
}

/** 从设置中移除隧道条目。不存在返回 false；**不删覆写文件**（那是用户维护的资产）。 */
export function removeSshTunnel(name: string): boolean {
  let found = false;
  updateSettings(() => {
    const tunnels = [...getSshTunnels()];
    const idx = tunnels.findIndex(t => t.name === name);
    if (idx < 0) return {};
    found = true;
    tunnels.splice(idx, 1);
    return { ssh: tunnels } as Partial<Settings>;
  });
  if (!found) return false;
  clearSshRuntime(name);
  return true;
}

// === 运行态文件 ===

function getSshRuntimePath(name: string): string {
  // 二次校验防路径穿越：名字正常经 addSshTunnel 校验，但 settings.json 可被手改成 ../ 之类
  validateSshName(name);
  return path.join(DIRS.ssh, `${name}.json`);
}

function readSshRuntime(name: string): SshRuntime | null {
  try {
    const raw = fs.readFileSync(getSshRuntimePath(name), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const r = parsed as Partial<SshRuntime>;
    if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return null;
    return {
      pid: r.pid as number,
      started_by: r.started_by === 'manual' ? 'manual' : 'auto',
      started_at: typeof r.started_at === 'string' ? r.started_at : '',
      port: Number.isInteger(r.port) ? (r.port as number) : 0,
    };
  } catch {
    return null;
  }
}

function writeSshRuntime(name: string, runtime: SshRuntime): void {
  ensureDirs();
  atomicWriteFileSync(getSshRuntimePath(name), JSON.stringify(runtime, null, 2), { mode: 0o600 });
}

function clearSshRuntime(name: string): void {
  try {
    fs.rmSync(getSshRuntimePath(name), { force: true });
  } catch {
    /* ignore：名字非法时路径本就不该存在 */
  }
}

// === ssh 进程 ===

/**
 * ssh 参数。六个 `-o` 一个都不能少，各自防的失败模式见 docs/ssh-requirement.md：
 * - ExitOnForwardFailure: 「连上了但转发没建起来」的假活
 * - BatchMode:            无 TTY 时任何交互提示都会挂死
 * - ConnectTimeout:       网络半死不活时久等，期间看着还活着
 * - ServerAlive*:         断线后进程不退出，端口成僵尸
 *
 * `-D` 恒绑 127.0.0.1：绑 0.0.0.0 会让同一 WiFi 下任何设备经本机进内网，是安全红线，
 * 因此不提供 bind 地址开关。
 *
 * 返回 argv 数组供 spawn 直接使用（不经 shell，无注入面）。
 */
export function buildSshArgs(tunnel: Pick<SshConfig, 'host' | 'port'>): string[] {
  return [
    '-D',
    `127.0.0.1:${tunnel.port}`,
    '-N',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ConnectTimeout=15',
    tunnel.host,
  ];
}

/**
 * 命令行匹配用的 needle。取 `-D 127.0.0.1:<port>`：紧跟 ssh 之后、偏移极小，
 * 不会撞上 BSD ps 的 79 列截断（isProcessCommandMatching 已带 -ww，此处是双保险）；
 * 且端口在本工具内唯一，不会误匹配到别的隧道。
 */
function commandNeedle(port: number): string {
  return `-D 127.0.0.1:${port}`;
}

export function getSshLogPath(name: string): string {
  validateSshName(name);
  return path.join(DIRS.logs, `ssh-${name}.log`);
}

/** 进程是否为本隧道的 ssh：存活 + 命令行匹配双条件（防 PID 复用误杀，同 process-probe.ts 口径） */
function isSshProcessAlive(pid: number, port: number): boolean {
  return isProcessRunning(pid) && isProcessCommandMatching(pid, commandNeedle(port));
}

/**
 * 端口是否有人在监听。代码库此前无先例，故新写：TCP 连一下，连上即在监听。
 * 用途有二：起之前检测占用（不盲启）、status 探测真实可用性（识破假活）。
 */
export function isPortListening(port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

export async function getSshStatus(config: SshConfig): Promise<SshStatus> {
  const runtime = readSshRuntime(config.name);
  const alive = runtime !== null && isSshProcessAlive(runtime.pid, runtime.port || config.port);

  if (!alive) {
    return { config, state: 'stopped', pid: null, started_by: null, started_at: null };
  }

  // 进程在不代表能用：ssh 可能连着但转发已失效，此时端口不通而 mihomo 仍在往那儿送流量。
  // 这正是「假活」，必须靠真实端口探测才能发现。
  const listening = await isPortListening(config.port);
  return {
    config,
    state: listening ? 'running' : 'dead-port',
    pid: (runtime as SshRuntime).pid,
    started_by: (runtime as SshRuntime).started_by,
    started_at: (runtime as SshRuntime).started_at || null,
  };
}

export async function getAllSshStatus(): Promise<SshStatus[]> {
  return Promise.all(getSshTunnels().map(getSshStatus));
}

export interface StartSshResult {
  /** 已经在跑，本次未启动 */
  alreadyRunning: boolean;
  pid: number;
}

/**
 * 启动隧道。已在运行则原样返回（**不改 started_by**——把用户手动起的降级成 auto，
 * 下次 `mihomo stop` 会误杀）。
 *
 * 失败一律抛 CliError，由调用方决定是致命还是仅告警（`start` 里只告警）。
 */
export async function startSshTunnel(name: string, options: { startedBy: 'auto' | 'manual' }): Promise<StartSshResult> {
  const config = findSshTunnel(name);
  if (!config) {
    throw new CliError(`未找到隧道 "${name}"`, { hint: ['查看全部隧道: mihomo ssh'] });
  }

  const existing = readSshRuntime(name);
  if (existing && isSshProcessAlive(existing.pid, existing.port || config.port)) {
    // started_by 单向提升：manual 永不降级为 auto，因为「用户显式要过它」不该被 stop 带走
    if (options.startedBy === 'manual' && existing.started_by === 'auto') {
      writeSshRuntime(name, { ...existing, started_by: 'manual' });
    }
    return { alreadyRunning: true, pid: existing.pid };
  }

  // 陈旧状态文件（进程已退出）先清掉，避免下面失败时留下误导性记录
  if (existing) clearSshRuntime(name);

  // 起之前先检测端口占用，不盲启后失败——盲启的表现是 ssh 因 ExitOnForwardFailure 立刻退出，
  // 错误信息埋在日志里，远不如这里直接说清楚
  if (await isPortListening(config.port)) {
    throw new CliError(`端口 ${config.port} 已被占用`, {
      label: '无法启动隧道',
      hint: [`可能已有隧道或其他程序在监听 127.0.0.1:${config.port}。`, `查看占用: lsof -nP -iTCP:${config.port} -sTCP:LISTEN`],
    });
  }

  ensureDirs();
  const logPath = getSshLogPath(name);
  // 'w' 截断重建：日志只保留本次会话，既便于定位本次失败，也不会无限增长
  const logFd = fs.openSync(logPath, 'w');

  const child = spawn('ssh', buildSshArgs(config), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  // detached 进程的 error 事件（如 ssh 不存在 ENOENT）若无 handler 会冒泡成 uncaughtException，
  // 被全局处理器当 bug 打印堆栈。吞掉后由下面的存活检查 + 日志读取给出可读错误。
  child.on('error', () => {});
  fs.closeSync(logFd);

  // unref：隧道必须能活过 CLI 退出，不能作为子进程被父进程的生命周期拴住。
  // （启动等待窗口内另有一次性的 registerCleanup 兜底，见下方注释）
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new CliError('无法创建 ssh 进程', { label: '启动隧道失败', hint: ['请确认已安装 ssh 客户端。'] });
  }

  writeSshRuntime(name, {
    pid,
    started_by: options.startedBy,
    started_at: new Date().toISOString(),
    port: config.port,
  });

  // 仅在「等待转发建立」这段窗口内注册清理：此时隧道尚未确认可用，用户按 Ctrl+C
  // 意味着放弃本次启动。SIGINT 处理器走 process.exit(130) 会跳过 finally，
  // 此前会留下一个孤儿 ssh 进程 + 一份声称健康的运行态文件（实测持久残留，
  // 不会自愈），随后 `ssh up` 报「已在运行」、`status` 报「假活」，自相矛盾。
  //
  // 一旦转发建立成功就立刻注销——那之后隧道必须活过 CLI 退出（本模块的既定语义）。
  const unregisterCleanup = registerCleanup(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 进程可能已自行退出 */
    }
    clearSshRuntime(name);
  });

  // 等转发真正建起来：进程活着不等于端口在监听（ssh 要先完成认证与通道协商）
  try {
    for (let i = 0; i < START_WAIT_ATTEMPTS; i++) {
      if (!isProcessRunning(pid)) break;
      if (await isPortListening(config.port)) {
        unregisterCleanup();
        return { alreadyRunning: false, pid };
      }
      await new Promise(resolve => setTimeout(resolve, START_WAIT_INTERVAL));
    }
  } finally {
    // 无论成功返回、抛错还是循环走完，都要摘掉清理注册（成功路径上隧道要活过 CLI；
    // 失败路径下面会显式收尸，留着会造成重复 kill）
    unregisterCleanup();
  }

  // 到这里说明失败了：要么进程已退出，要么进程在但端口始终不通
  clearSshRuntime(name);
  if (isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }

  throw new CliError('ssh 隧道未能建立', {
    label: '启动隧道失败',
    hint: [...readLogTail(logPath), `完整日志: ${logPath}`],
  });
}

/** 读日志尾部若干行，供错误提示引用真实原因（不吞掉 ssh 说了什么） */
export function readLogTail(logPath: string, maxLines = 5): string[] {
  try {
    const content = fs.readFileSync(logPath, 'utf8').trim();
    if (!content) return [];
    return content
      .split('\n')
      .slice(-maxLines)
      .map(line => `  ${line.trim()}`);
  } catch {
    return [];
  }
}

export interface StopSshResult {
  /** 本来就没在跑 */
  notRunning: boolean;
  pid: number | null;
}

/**
 * 停止隧道。SIGTERM → 轮询 → SIGKILL：ssh 收到 SIGTERM 会关闭转发通道再退出，
 * 直接 SIGKILL 可能留下半开连接。（现有代码对内核一律裸 SIGKILL，但内核是自己的进程，
 * 语义不同。）
 */
export function stopSshTunnel(name: string): StopSshResult {
  const config = findSshTunnel(name);
  const runtime = readSshRuntime(name);
  if (!runtime) {
    clearSshRuntime(name);
    return { notRunning: true, pid: null };
  }

  const port = runtime.port || config?.port || 0;
  const { pid } = runtime;

  if (!isSshProcessAlive(pid, port)) {
    clearSshRuntime(name);
    return { notRunning: true, pid: null };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* 已经没了 */
  }

  for (let i = 0; i < STOP_WAIT_ATTEMPTS; i++) {
    if (!isProcessRunning(pid)) break;
    sleepSync(STOP_WAIT_INTERVAL);
  }

  if (isProcessRunning(pid) && isProcessCommandMatching(pid, commandNeedle(port))) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
    for (let i = 0; i < STOP_WAIT_ATTEMPTS; i++) {
      if (!isProcessRunning(pid)) break;
      sleepSync(STOP_WAIT_INTERVAL);
    }
  }

  clearSshRuntime(name);
  return { notRunning: false, pid };
}

// === start / stop 联动 ===

export interface AutoSshOutcome {
  name: string;
  ok: boolean;
  alreadyRunning?: boolean;
  error?: CliError;
}

/**
 * 拉起全部 `auto: true` 的隧道，供 `mihomo start` 调用。
 * **不抛错**——隧道失败只影响内网分流那部分规则，让整个 start 失败是过度反应。
 * 逐条返回结果，由调用方显眼地告警。
 */
export async function startAutoSshTunnels(): Promise<AutoSshOutcome[]> {
  const outcomes: AutoSshOutcome[] = [];
  for (const tunnel of getSshTunnels()) {
    if (!tunnel.auto) continue;
    try {
      const result = await startSshTunnel(tunnel.name, { startedBy: 'auto' });
      outcomes.push({ name: tunnel.name, ok: true, alreadyRunning: result.alreadyRunning });
    } catch (e) {
      outcomes.push({
        name: tunnel.name,
        ok: false,
        error: e instanceof CliError ? e : new CliError((e as Error).message),
      });
    }
  }
  return outcomes;
}

/**
 * 停止由 `start` 顺带拉起的隧道，供 `mihomo stop` 调用。
 * **只停 started_by === 'auto' 的**——手动 `ssh up` 起的不该被 `stop` 带走，
 * 否则下次 start 又起一个，累积僵尸进程。
 */
export function stopAutoSshTunnels(): string[] {
  const stopped: string[] = [];
  for (const tunnel of getSshTunnels()) {
    const runtime = readSshRuntime(tunnel.name);
    if (runtime?.started_by !== 'auto') continue;
    const result = stopSshTunnel(tunnel.name);
    if (!result.notRunning) stopped.push(tunnel.name);
  }
  return stopped;
}

/**
 * 停止全部隧道，不论 started_by。供 `reset` 使用：删掉运行态文件后就再也找不到
 * 那些 ssh 进程，它们会继续占着端口跑下去且 CLI 无路径可停，故必须在删除前停干净。
 */
export function stopAllSshTunnels(): string[] {
  const stopped: string[] = [];
  for (const tunnel of getSshTunnels()) {
    const result = stopSshTunnel(tunnel.name);
    if (!result.notRunning) stopped.push(tunnel.name);
  }
  return stopped;
}
