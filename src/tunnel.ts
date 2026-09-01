import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { BASE_CONFIG, CONTROLLER_PORT, TEST_CONFIG, TEST_CONTROLLER_ADDR } from './constants.js';
import { CliError } from './errors.js';
import { atomicWriteFileSync, DIRS, ensureDirs, USER_DATA_DIR } from './paths.js';
import { isProcessCommandMatching, isProcessRunning } from './process.js';
import { readSettings, SAFE_NAME_RE, writeSettings } from './settings.js';
import type { Settings, TunnelConfig, TunnelRuntime, TunnelStatus } from './types.js';
import { sleepSync } from './utils.js';

/**
 * ssh -D 动态转发隧道的生命周期管理。
 *
 * 只做一件事：管住 `ssh -D` 进程的启停与真实状态。分流本身完全交给覆写机制
 * （生成的 overwrite.tunnel-<name>.yaml 由用户维护），本模块不碰路由逻辑。
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
  const testPort = Number(TEST_CONFIG['mixed-port']);
  if (Number.isInteger(testPort)) reserved.set(testPort, '测速实例代理端口');
  const testController = Number(TEST_CONTROLLER_ADDR.split(':')[1]);
  if (Number.isInteger(testController)) reserved.set(testController, '测速实例控制器端口');
  return reserved;
}

// === 名称与参数校验 ===

export function validateTunnelName(name: string): void {
  if (!name || !SAFE_NAME_RE.test(name)) {
    throw new CliError(`隧道名称无效: "${name}"，只允许字母、数字、下划线、短横线和中文（最长 64 字符）`);
  }
}

/**
 * ssh 目标主机校验。**以 `-` 开头会被 ssh 当选项解析**，
 * `--host -oProxyCommand=<任意命令>` 即任意命令执行——这是本模块最重要的一条校验。
 * 同时限定字符集，排除空格与 shell 元字符（虽然 spawn 不经 shell，但仍防误配）。
 */
const SAFE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

export function validateTunnelHost(host: string): void {
  if (!host) {
    throw new CliError('缺少 --host', { hint: ['例如: mihomo tunnel add work --host m4 --port 1080'] });
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
export function validateTunnelPort(port: number, exclude?: string): void {
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
  const conflict = getTunnels().find(t => t.port === port && t.name !== exclude);
  if (conflict) {
    throw new CliError(`端口 ${port} 已被隧道 "${conflict.name}" 使用`, { label: '端口冲突' });
  }
}

// === 隧道列表（settings.json） ===

/**
 * 隧道列表的唯一读取入口。校验必须在此收口：settings.json 被手改成
 * `{"tunnels":"oops"}` 时，下游的展开运算符会把字符串按字符展开成垃圾列表且不报错
 * （与 getSubscriptions 同一教训）。
 */
export function getTunnels(): TunnelConfig[] {
  const settings = readSettings();
  const tunnels = settings.tunnels;
  if (!Array.isArray(tunnels)) {
    if (tunnels !== undefined) {
      console.warn('警告: settings.json 的 tunnels 不是列表，已忽略（可用 mihomo tunnel add 重新添加）');
    }
    return [];
  }
  return tunnels.filter(t => t != null && typeof t === 'object' && typeof t.name === 'string' && typeof t.host === 'string' && Number.isInteger(t.port));
}

export function findTunnel(name: string): TunnelConfig | undefined {
  return getTunnels().find(t => t.name === name);
}

export function addTunnel(config: TunnelConfig): void {
  validateTunnelName(config.name);
  validateTunnelHost(config.host);
  validateTunnelPort(config.port);
  const tunnels = [...getTunnels()];
  if (tunnels.some(t => t.name === config.name)) {
    throw new CliError(`隧道 "${config.name}" 已存在，请换个名称，或先删除（mihomo tunnel rm ${config.name}）`);
  }
  tunnels.push(config);
  writeSettings({ tunnels } as Partial<Settings>);
}

/** 从设置中移除隧道条目。不存在返回 false；**不删覆写文件**（那是用户维护的资产）。 */
export function removeTunnel(name: string): boolean {
  const tunnels = [...getTunnels()];
  const idx = tunnels.findIndex(t => t.name === name);
  if (idx < 0) return false;
  tunnels.splice(idx, 1);
  writeSettings({ tunnels } as Partial<Settings>);
  clearTunnelRuntime(name);
  return true;
}

// === 运行态文件 ===

function getTunnelRuntimePath(name: string): string {
  // 二次校验防路径穿越：名字正常经 addTunnel 校验，但 settings.json 可被手改成 ../ 之类
  validateTunnelName(name);
  return path.join(DIRS.tunnel, `${name}.json`);
}

function readTunnelRuntime(name: string): TunnelRuntime | null {
  try {
    const raw = fs.readFileSync(getTunnelRuntimePath(name), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const r = parsed as Partial<TunnelRuntime>;
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

function writeTunnelRuntime(name: string, runtime: TunnelRuntime): void {
  ensureDirs();
  atomicWriteFileSync(getTunnelRuntimePath(name), JSON.stringify(runtime, null, 2), { mode: 0o600 });
}

function clearTunnelRuntime(name: string): void {
  try {
    fs.rmSync(getTunnelRuntimePath(name), { force: true });
  } catch {
    /* ignore：名字非法时路径本就不该存在 */
  }
}

// === ssh 进程 ===

/**
 * ssh 参数。六个 `-o` 一个都不能少，各自防的失败模式见 docs/tunnel-requirement.md：
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
export function buildSshArgs(tunnel: Pick<TunnelConfig, 'host' | 'port'>): string[] {
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

export function getTunnelLogPath(name: string): string {
  validateTunnelName(name);
  return path.join(DIRS.logs, `tunnel-${name}.log`);
}

/** 进程是否为本隧道的 ssh：存活 + 命令行匹配双条件（防 PID 复用误杀，同 process.ts 口径） */
function isTunnelProcessAlive(pid: number, port: number): boolean {
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

export async function getTunnelStatus(config: TunnelConfig): Promise<TunnelStatus> {
  const runtime = readTunnelRuntime(config.name);
  const alive = runtime !== null && isTunnelProcessAlive(runtime.pid, runtime.port || config.port);

  if (!alive) {
    return { config, state: 'stopped', pid: null, started_by: null, started_at: null };
  }

  // 进程在不代表能用：ssh 可能连着但转发已失效，此时端口不通而 mihomo 仍在往那儿送流量。
  // 这正是「假活」，必须靠真实端口探测才能发现。
  const listening = await isPortListening(config.port);
  return {
    config,
    state: listening ? 'running' : 'dead-port',
    pid: (runtime as TunnelRuntime).pid,
    started_by: (runtime as TunnelRuntime).started_by,
    started_at: (runtime as TunnelRuntime).started_at || null,
  };
}

export async function getAllTunnelStatus(): Promise<TunnelStatus[]> {
  return Promise.all(getTunnels().map(getTunnelStatus));
}

export interface StartTunnelResult {
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
export async function startTunnel(name: string, options: { startedBy: 'auto' | 'manual' }): Promise<StartTunnelResult> {
  const config = findTunnel(name);
  if (!config) {
    throw new CliError(`未找到隧道 "${name}"`, { hint: ['查看全部隧道: mihomo tunnel'] });
  }

  const existing = readTunnelRuntime(name);
  if (existing && isTunnelProcessAlive(existing.pid, existing.port || config.port)) {
    // started_by 单向提升：manual 永不降级为 auto，因为「用户显式要过它」不该被 stop 带走
    if (options.startedBy === 'manual' && existing.started_by === 'auto') {
      writeTunnelRuntime(name, { ...existing, started_by: 'manual' });
    }
    return { alreadyRunning: true, pid: existing.pid };
  }

  // 陈旧状态文件（进程已退出）先清掉，避免下面失败时留下误导性记录
  if (existing) clearTunnelRuntime(name);

  // 起之前先检测端口占用，不盲启后失败——盲启的表现是 ssh 因 ExitOnForwardFailure 立刻退出，
  // 错误信息埋在日志里，远不如这里直接说清楚
  if (await isPortListening(config.port)) {
    throw new CliError(`端口 ${config.port} 已被占用`, {
      label: '无法启动隧道',
      hint: [`可能已有隧道或其他程序在监听 127.0.0.1:${config.port}。`, `查看占用: lsof -nP -iTCP:${config.port} -sTCP:LISTEN`],
    });
  }

  ensureDirs();
  const logPath = getTunnelLogPath(name);
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

  // 不注册 registerCleanup：那是「随 CLI 退出而死」的语义，而隧道必须在 CLI 退出后继续存活
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new CliError('无法创建 ssh 进程', { label: '启动隧道失败', hint: ['请确认已安装 ssh 客户端。'] });
  }

  writeTunnelRuntime(name, {
    pid,
    started_by: options.startedBy,
    started_at: new Date().toISOString(),
    port: config.port,
  });

  // 等转发真正建起来：进程活着不等于端口在监听（ssh 要先完成认证与通道协商）
  for (let i = 0; i < START_WAIT_ATTEMPTS; i++) {
    if (!isProcessRunning(pid)) break;
    if (await isPortListening(config.port)) {
      return { alreadyRunning: false, pid };
    }
    await new Promise(resolve => setTimeout(resolve, START_WAIT_INTERVAL));
  }

  // 到这里说明失败了：要么进程已退出，要么进程在但端口始终不通
  clearTunnelRuntime(name);
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

export interface StopTunnelResult {
  /** 本来就没在跑 */
  notRunning: boolean;
  pid: number | null;
}

/**
 * 停止隧道。SIGTERM → 轮询 → SIGKILL：ssh 收到 SIGTERM 会关闭转发通道再退出，
 * 直接 SIGKILL 可能留下半开连接。（现有代码对内核一律裸 SIGKILL，但内核是自己的进程，
 * 语义不同。）
 */
export function stopTunnel(name: string): StopTunnelResult {
  const config = findTunnel(name);
  const runtime = readTunnelRuntime(name);
  if (!runtime) {
    clearTunnelRuntime(name);
    return { notRunning: true, pid: null };
  }

  const port = runtime.port || config?.port || 0;
  const { pid } = runtime;

  if (!isTunnelProcessAlive(pid, port)) {
    clearTunnelRuntime(name);
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

  clearTunnelRuntime(name);
  return { notRunning: false, pid };
}

// === start / stop 联动 ===

export interface AutoTunnelOutcome {
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
export async function startAutoTunnels(): Promise<AutoTunnelOutcome[]> {
  const outcomes: AutoTunnelOutcome[] = [];
  for (const tunnel of getTunnels()) {
    if (!tunnel.auto) continue;
    try {
      const result = await startTunnel(tunnel.name, { startedBy: 'auto' });
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
 * **只停 started_by === 'auto' 的**——手动 `tunnel up` 起的不该被 `stop` 带走，
 * 否则下次 start 又起一个，累积僵尸进程。
 */
export function stopAutoTunnels(): string[] {
  const stopped: string[] = [];
  for (const tunnel of getTunnels()) {
    const runtime = readTunnelRuntime(tunnel.name);
    if (runtime?.started_by !== 'auto') continue;
    const result = stopTunnel(tunnel.name);
    if (!result.notRunning) stopped.push(tunnel.name);
  }
  return stopped;
}

/**
 * 停止全部隧道，不论 started_by。供 `reset` 使用：删掉运行态文件后就再也找不到
 * 那些 ssh 进程，它们会继续占着端口跑下去且 CLI 无路径可停，故必须在删除前停干净。
 */
export function stopAllTunnels(): string[] {
  const stopped: string[] = [];
  for (const tunnel of getTunnels()) {
    const result = stopTunnel(tunnel.name);
    if (!result.notRunning) stopped.push(tunnel.name);
  }
  return stopped;
}

// === 覆写文件模板 ===

export function getTunnelOverwritePath(name: string): string {
  validateTunnelName(name);
  return path.join(USER_DATA_DIR, `overwrite.tunnel-${name}.yaml`);
}

/**
 * 覆写模板正文。用 `~proxies` / `~proxy-groups`（按 name 就地合并）而非 `+proxies`：
 * 只有 `~` 是**顺序无关**的——它按 name 在数组里定位，无论本文件在字母序里排第几，
 * 同名节点都会被合并。`+proxies` 依赖「本文件恰好排在冲突文件之后」，
 * 用户再加个 overwrite.zzz.yaml 就压过去了。
 *
 * 手写字符串而非 dumpYaml：模板要带解释性注释。name 已过 SAFE_NAME_RE、
 * port 是整数，无 YAML 转义风险。
 */
export function renderTunnelOverwrite(tunnel: TunnelConfig): string {
  const proxyName = `Tunnel-${tunnel.name}-Host`;
  const groupName = `Tunnel-${tunnel.name}`;
  return `# mihomo-cli 隧道覆写（tunnel: ${tunnel.name}）
# 本文件由 mihomo-cli 首次创建，之后完全由你维护——CLI 不会再改写或删除它。
#
# ~ 是「按 name 就地合并」语义：与其他覆写文件中的同名节点/分组合并，
# 不依赖文件加载顺序（+proxies 则依赖字母序，会被后来的文件压过去）。

~proxies:
  - name: ${proxyName}
    type: socks5
    server: 127.0.0.1
    port: ${tunnel.port}

~proxy-groups:
  - name: ${groupName}
    type: select
    proxies:
      - ${proxyName}
      - DIRECT

# 取消注释并填入需要走隧道的内网域名/网段（CLI 无从知道你的内网地址）：
# +rules:
#   - DOMAIN-SUFFIX,example.internal,${groupName}
#   - IP-CIDR,10.0.0.0/8,${groupName}
`;
}

/**
 * 仅当文件不存在时生成模板，返回是否新建。
 * 绝不覆盖已有文件——它是用户维护的资产，覆盖等于不可恢复地丢掉用户写的分流规则。
 */
export function ensureTunnelOverwriteFile(tunnel: TunnelConfig): boolean {
  const filePath = getTunnelOverwritePath(tunnel.name);
  if (fs.existsSync(filePath)) return false;
  ensureDirs();
  atomicWriteFileSync(filePath, renderTunnelOverwrite(tunnel), { mode: 0o600 });
  return true;
}
