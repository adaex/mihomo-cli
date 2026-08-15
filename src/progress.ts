import { colors } from './colors.js';
import type { ProxyTestResult } from './types.js';

const IS_TTY = process.stdout.isTTY === true;
const BAR_WIDTH = 20;

interface TrackedResult {
  result: ProxyTestResult;
  round: number;
}

/**
 * 测速进度打印：TTY 下渲染进度条，结束后输出逐节点最终状态；
 * 非 TTY（管道/重定向）下进度条与逐节点列表都省略，只留汇总行，避免刷屏。
 * 从 commands/subscription.ts 抽出，供 start/test 等命令共用（消除命令层循环依赖）。
 */
export function createProgressPrinter(totalRounds = 1): {
  onResult: (result: ProxyTestResult, index: number, total: number, round?: number) => void;
  onRetryRound: (round: number, count: number) => void;
  finish: () => void;
} {
  let alive = 0;
  let dead = 0;
  const resultMap = new Map<string, TrackedResult>();

  function render(done: number, total: number): void {
    if (!IS_TTY) return;
    const pct = Math.round((done / total) * 100);
    const filled = Math.round((done / total) * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    process.stdout.write(`\r${bar} ${done}/${total} (${pct}%) | ${colors.green(`✓${alive}`)} ${colors.red(`✗${dead}`)}`);
  }

  return {
    onResult(result, index, total, round = 1) {
      if (resultMap.size === 0 && totalRounds > 1) {
        console.log(`--- 第 1 轮测试 (${total} 个节点) ---`);
      }
      // resultMap 按 name 去重；若同名节点已计过数（订阅存在重名时），先回退旧计数，避免 ✓/✗ 总和 > 节点数
      const prev = resultMap.get(result.name);
      if (prev) {
        if (prev.result.delay !== null) alive--;
        else dead--;
      }
      if (result.delay !== null) alive++;
      else dead++;

      resultMap.set(result.name, { result, round });
      render(index + 1, total);
    },
    onRetryRound(round, count) {
      if (IS_TTY) {
        process.stdout.write('\n');
      }
      console.log(`--- 第 ${round} 轮重试 (${count} 个节点) ---`);
      alive = 0;
      dead = 0;
    },
    finish() {
      if (IS_TTY) {
        process.stdout.write('\n');
      }
      console.log('');

      if (!IS_TTY) return;

      const entries = [...resultMap.values()];
      entries.sort((a, b) => a.result.name.localeCompare(b.result.name));
      const total = entries.length;
      console.log('节点最终状态:');

      for (let i = 0; i < entries.length; i++) {
        const { result, round } = entries[i];
        const prefix = `[${i + 1}/${total}]`;
        if (result.delay !== null) {
          const delayColor = result.delay < 300 ? colors.green : result.delay < 800 ? colors.yellow : colors.red;
          const retryNote = round > 1 ? colors.gray(` (第${round}轮通过)`) : '';
          console.log(`${prefix} ${colors.green('✓')} ${result.name} ${delayColor(`${result.delay}ms`)}${retryNote}`);
        } else {
          console.log(`${prefix} ${colors.red('✗')} ${result.name} ${colors.gray(result.error || 'timeout')}`);
        }
      }
      console.log('');
    },
  };
}

export function formatCleanSummary(result: { removedProxies: number; removedGroups: number; updatedGroups: number }): string {
  const parts = [`移除 ${result.removedProxies} 个节点`];
  if (result.removedGroups > 0) parts.push(`删除 ${result.removedGroups} 个空分组`);
  if (result.updatedGroups > 0) parts.push(`更新 ${result.updatedGroups} 个分组`);
  return parts.join(', ');
}

export function formatTestSummary(summary: { alive: number; dead: number; total: number }): string {
  return `结果: ${colors.green(`${summary.alive} 存活`)} / ${colors.red(`${summary.dead} 失败`)} / ${summary.total} 总计`;
}
