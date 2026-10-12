/** 跨领域杂项：只剩 sleep，新函数请进对应域模块（撤编计划见 docs/todo.md） */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
