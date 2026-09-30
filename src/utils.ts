/**
 * 跨领域杂项的落脚点。带独立职责的函数按域拆出后只剩 sleep：
 * - argv 解析 → argv.ts
 * - 显示宽度与格式化 → format.ts
 * - did-you-mean → suggest.ts
 * - 字符串安全（正则/bash/终端）→ text.ts
 * - kernel 选项（--mirror/--proxy）→ kernel-args.ts
 * - 代理指向判定（isLoopbackHost/proxyEnvPointsAtSelf）→ system-proxy.ts
 * - 订阅紧急度判定 → settings.ts
 * 新函数请直接进对应模块，别再回到这里。
 */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
