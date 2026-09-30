/**
 * did-you-mean 纠错：未知命令/子命令/选项时给出相近候选。
 */

/** Levenshtein 编辑距离（两行滚动数组，O(min(m,n)) 空间；输入为命令 token，长度很短） */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * 从候选词中挑出与输入相近的词，按相似度升序返回（至多 3 个）。
 * 命中规则（大小写不敏感）：前缀匹配，或编辑距离 <= 2。无相近词返回空数组。
 */
export function suggestSimilar(input: string, candidates: readonly string[]): string[] {
  const lower = input.toLowerCase();
  const scored: { name: string; score: number; lenDiff: number }[] = [];
  for (const cand of candidates) {
    const c = cand.toLowerCase();
    // 输入与候选完全一致（区分大小写）时不建议；仅大小写不同的仍建议（token 大小写易敲错）
    if (cand === input) continue;
    if (c.startsWith(lower)) {
      scored.push({ name: cand, score: 0, lenDiff: Math.abs(cand.length - input.length) });
    } else if (lower.length >= 3) {
      // 编辑距离只对 >= 3 字符的输入生效：两字符输入（如 su）与任意候选的距离都 <= 2，全是噪音
      const d = levenshtein(lower, c);
      if (d <= 2) scored.push({ name: cand, score: d, lenDiff: Math.abs(cand.length - input.length) });
    }
  }
  // 同分时优先长度接近的候选（su -> sub 优先于 subscription）
  scored.sort((a, b) => a.score - b.score || a.lenDiff - b.lenDiff);
  return scored.slice(0, 3).map(s => s.name);
}
