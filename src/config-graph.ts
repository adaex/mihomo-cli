import { CliError } from './errors.js';

/**
 * JSON 不保留 YAML 别名：共享子图会按每次引用展开。展示路径用符号计算限制展开后的
 * 节点数，避免脱敏深拷贝与 JSON.stringify 对小型 DAG 做指数级实际展开。
 * 100000 是交互式展示预算；下载、start 与内核校验不经过此限制。
 */
export const CONFIG_GRAPH_MAX_EXPANDED_NODES = 100_000;

/** 脱敏与覆写合并仍有递归遍历；限制深度，防止无别名的长链撞调用栈。 */
const CONFIG_GRAPH_MAX_DEPTH = 200;

interface CompletedNode {
  readonly cost: number;
  /** 当前子树内相对本节点的最大边深度；缓存复用时仍需按引用位置复核总深度。 */
  readonly height: number;
}

const SCALAR_NODE: CompletedNode = { cost: 1, height: 0 };

function cycleError(source: string): CliError {
  return new CliError(`${source}包含循环引用，无法安全处理配置图`, {
    label: '配置错误',
    hint: ['检查 YAML 别名是否引用了自身或祖先；若由覆写脚本产生，请移除写回祖先对象的引用。'],
  });
}

function depthError(source: string): CliError {
  return new CliError(`${source}的嵌套深度超过 ${CONFIG_GRAPH_MAX_DEPTH} 层，无法安全递归处理`, {
    label: '配置错误',
    hint: ['请缩减配置嵌套；YAML 别名与覆写脚本都不能生成过深的配置图。'],
  });
}

function budgetError(source: string): CliError {
  return new CliError(`${source}展开后的节点数超过 ${CONFIG_GRAPH_MAX_EXPANDED_NODES}，已拒绝处理以避免资源耗尽`, {
    label: '配置错误',
    hint: ['减少共享 YAML 别名或覆写脚本产生的重复引用；配置展示与 JSON 序列化需要展开这些引用。'],
  });
}

function addCost(left: number, right: number, source: string, checkExpansionBudget: boolean): number {
  const total = left + right;
  if (checkExpansionBudget && total > CONFIG_GRAPH_MAX_EXPANDED_NODES) throw budgetError(source);
  return total;
}

/** 下载、start 与合并路径的结构检查：只拒绝循环与过深图，不限制合法配置的展开体量。 */
export function assertConfigGraphSafe(root: unknown, source = '配置'): void {
  assertConfigGraph(root, source, false);
}

/** config 展示检查：结构安全之外，再给递归脱敏或无别名的 JSON 出口加上展开预算。 */
export function assertConfigGraphExpansionSafe(root: unknown, source = '配置'): void {
  assertConfigGraph(root, source, true);
}

/**
 * 带完成缓存的 DFS 记录节点展开成本与相对高度：共享 DAG 的预检成本随实际节点与引用数线性增长，
 * 而非随展开后的大小增长。active 与 completed 分离，合法共享引用不会误判成循环。
 * 深度上限同时约束本函数与后续递归消费者，最深进入第 201 层即抛错。
 */
function assertConfigGraph(root: unknown, source: string, checkExpansionBudget: boolean): void {
  const active = new WeakSet<object>();
  const completed = new WeakMap<object, CompletedNode>();

  const visit = (value: unknown, depth: number): CompletedNode => {
    if (depth > CONFIG_GRAPH_MAX_DEPTH) throw depthError(source);
    if (value === null || typeof value !== 'object') return SCALAR_NODE;
    if (active.has(value)) throw cycleError(source);
    const cached = completed.get(value);
    if (cached !== undefined) {
      // 成本与引用位置无关，深度却有关：同一子图在浅处完成缓存后，仍可能从深处引用。
      if (depth + cached.height > CONFIG_GRAPH_MAX_DEPTH) throw depthError(source);
      return cached;
    }

    active.add(value);
    const children: unknown[] = Array.isArray(value) ? value : Object.values(value);
    let cost = 1;
    let height = 0;
    for (const child of children) {
      const childResult = visit(child, depth + 1);
      cost = addCost(cost, childResult.cost, source, checkExpansionBudget);
      height = Math.max(height, childResult.height + 1);
    }
    active.delete(value);
    const result = { cost, height };
    completed.set(value, result);
    return result;
  };

  visit(root, 0);
}
