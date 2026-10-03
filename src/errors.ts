export class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

export interface CliErrorOptions {
  /** 附加说明，渲染在主消息之后（每项一行）：候选列表 / 原因·文档 / 镜像提示等 */
  hint?: string | string[];
  /** 前缀标签，默认 '错误'；动词化场景传入如 '配置错误' / '启动失败' / '更新失败' */
  label?: string;
  /** 退出码，默认 1；仅 update 透传 npm 退出码时需要非 1 */
  exitCode?: number;
}

/**
 * 命令层「预期内、用户可见」的错误。抛出后由 index.ts 的 main().catch 统一收口：
 * 渲染 `label: message` + hint 多行，按 exitCode 退出，不打印堆栈。
 * 与 TimeoutError 相互独立（后者用于 withTimeout 的控制流 instanceof 判定，勿混继承）。
 * 约定：detached 子进程 / 事件回调中不得抛 CliError（此时 main 已 resolve，收口捕获不到）。
 */
export class CliError extends Error {
  readonly hint: string[];
  readonly label: string;
  readonly exitCode: number;
  constructor(message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.label = options.label ?? '错误';
    this.hint = options.hint === undefined ? [] : Array.isArray(options.hint) ? options.hint : [options.hint];
    this.exitCode = options.exitCode ?? 1;
  }
}

/**
 * 再包装既有 CliError（追加 hint / 换 label）的唯一出口：exitCode 随原错误透传。
 * 手写 `new CliError(e.message, { label, hint })` 会把 exitCode 静默重置成 1——
 * 带非默认退出码的错误（update 透传 npm 退出码）流经再包装就丢失，脚本消费方
 * 把失败归类错。所有再包装点一律走这里，丢字段在结构上不可能发生。
 */
export function relabelCliError(e: CliError, options: { label?: string; hint?: string[] }): CliError {
  return new CliError(e.message, { label: options.label ?? e.label, hint: options.hint ?? e.hint, exitCode: e.exitCode });
}

/**
 * 任意抛出物的消息文本：Error 取 message，其余（`throw 'str'` / 42 / undefined）
 * 按 String() 兜底。uncaughtException / unhandledRejection / main().catch 共用同一
 * 口径，非 Error 抛出也要渲染出可用信息而不是「…: undefined」。
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
