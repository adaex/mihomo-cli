import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CliError } from './errors.js';
import { allocateArchivePath } from './log-files.js';
import { DIRS, PATHS } from './paths.js';

/**
 * CLI 诊断事件：独立于内核文本日志的本地 JSONL，只还原操作链，不保存原始输入或错误正文。
 *
 * 只有 index 在入口守卫之后调用 beginDiagnosticOperation 才会启用。底层函数被测试或其他
 * 模块直接 import 时 context 为空，写事件恒 no-op，避免模块加载/纯函数调用产生文件副作用。
 * 所有文件异常一律吞掉：诊断缺失可以接受，绝不能改变主命令的结果与退出码。
 */

export type DiagnosticResult = 'success' | 'failure' | 'begin' | 'skipped' | 'aborted' | 'fallback' | 'cancelled' | 'timeout';

/**
 * 持久化字段白名单。新增字段只能是不会携带用户输入的结构化元数据；
 * 刻意没有 args、url、subscription、message、stack、content 或任意 details 对象。
 */
export interface DiagnosticDetails {
  stage?: string;
  reason?: string;
  mode?: 'mixed' | 'tun';
  purpose?: 'start' | 'doctor';
  updateRequested?: boolean;
  timeoutMs?: number;
  staleCount?: number;
  succeeded?: number;
  failed?: number;
  abortedCount?: number;
  timedOut?: boolean;
  durationMs?: number;
  exitCode?: number | null;
  lastExitCode?: number | null;
  lastTerminatingSignal?: string | null;
  kernelPid?: number | null;
  port?: number;
  httpStatus?: number | null;
  errorType?: string;
  errorLabel?: string;
  errorCode?: string | number;
  aborted?: boolean;
  rawBeforeSha256?: string | null;
  rawAfterSha256?: string;
  sourceRawSha256?: string;
  candidateSha256?: string;
  runtimeBeforeSha256?: string | null;
  runtimeAfterSha256?: string;
  changed?: boolean | null;
  proxies?: number;
  proxyGroups?: number;
  rollback?: 'restored' | 'deleted' | 'failed';
}

interface DiagnosticContext {
  operationId: string;
  command: string;
  startedAt: number;
}

let context: DiagnosticContext | null = null;
let exitHookRegistered = false;

/** 单文件超过 2MB 后在下一次写入前轮转；归档保留 7 天，与内核归档互不混用。 */
export const DIAGNOSTIC_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DIAGNOSTIC_ARCHIVE_RE = /^diagnostic\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/;

/** 建立一次 CLI 调用的关联上下文；退出钩子必须同步，覆盖 main.catch 与 viewLogWithTail 的直接 process.exit。 */
export function beginDiagnosticOperation(command: string): void {
  context = { operationId: randomUUID(), command, startedAt: Date.now() };
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', exitCode => {
    if (!context) return;
    recordDiagnosticEvent('cli.command', exitCode === 0 ? 'success' : 'failure', {
      exitCode,
      durationMs: Date.now() - context.startedAt,
    });
  });
}

/** 只细化成代码内固定的命令名（如 sub update），绝不传原始 argv token。 */
export function setDiagnosticCommand(command: string): void {
  if (context) context.command = command;
}

/** 整份配置哈希只用于比较前后版本；不要对单节点、URL 或低熵字段调用。 */
export function hashDiagnosticContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 读取旧运行配置摘要只是附加诊断，任何读取失败都按“前值未知”处理，不影响提交。 */
export function hashDiagnosticFile(filePath: string): string | null {
  try {
    return hashDiagnosticContent(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const KNOWN_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'CliError', 'AbortError', 'TimeoutError', 'SudoAuthError']);

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value)) return value;
  return undefined;
}

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * 从错误链提取安全的结构化原因。错误 name 也只收已知内部形态，code 只收数字或系统常量，
 * 防止用户脚本/远端服务把凭据藏进自由文本后间接落盘。
 */
export function diagnosticErrorDetails(error: unknown): DiagnosticDetails {
  if (!(error instanceof Error)) return { errorType: 'NonError' };
  const details: DiagnosticDetails = {};
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    details.errorType = KNOWN_ERROR_NAMES.has(current.name) ? current.name : 'Error';
    if (current instanceof CliError) details.errorLabel = current.label;
    if (current.name === 'AbortError') details.aborted = true;
    const withMetadata = current as Error & { code?: unknown; response?: { status?: unknown }; cause?: unknown };
    const errorCode = safeErrorCode(withMetadata.code);
    const httpStatus = safeHttpStatus(withMetadata.response?.status);
    if (details.errorCode === undefined && errorCode !== undefined) details.errorCode = errorCode;
    if (details.httpStatus === undefined && httpStatus !== undefined) details.httpStatus = httpStatus;
    current = withMetadata.cause;
  }
  return details;
}

function cleanupDiagnosticArchives(): void {
  const now = Date.now();
  for (const file of fs.readdirSync(DIRS.logs)) {
    if (!DIAGNOSTIC_ARCHIVE_RE.test(file)) continue;
    try {
      const archivePath = path.join(DIRS.logs, file);
      if (now - fs.statSync(archivePath).mtimeMs > DIAGNOSTIC_RETENTION_MS) fs.unlinkSync(archivePath);
    } catch {
      /* 单个归档不可读/并发删除不挡其他清理 */
    }
  }
}

/** 与内核 rotateLog 同款的 rename 语义；绝不为轮转读全文件或重写 JSONL。 */
function rotateDiagnosticLogIfNeeded(): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(PATHS.diagnosticEventsFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (stat.size < DIAGNOSTIC_LOG_MAX_BYTES) return;

  const archivePath = allocateArchivePath('diagnostic', 'jsonl');
  try {
    fs.renameSync(PATHS.diagnosticEventsFile, archivePath);
  } catch (e) {
    try {
      fs.unlinkSync(archivePath);
    } catch {
      /* ignore */
    }
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  cleanupDiagnosticArchives();
}

/** 追加一条完整 JSONL。序列化、轮转和写入同一层全捕获，不向 stdout/stderr 泄露辅助错误。 */
export function recordDiagnosticEvent(event: string, result: DiagnosticResult, details: DiagnosticDetails = {}): void {
  if (!context) return;
  try {
    const line = `${JSON.stringify({
      v: 1,
      ts: new Date().toISOString(),
      event,
      result,
      operationId: context.operationId,
      command: context.command,
      pid: process.pid,
      ...details,
    })}\n`;
    fs.mkdirSync(DIRS.logs, { recursive: true, mode: 0o700 });
    rotateDiagnosticLogIfNeeded();
    // O_APPEND + 单次小写入保证并发进程不会交叉拼接事件；不能用整文件原子替换
    fs.appendFileSync(PATHS.diagnosticEventsFile, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* 诊断永远是 best-effort，不能替换主命令成功/失败 */
  }
}
