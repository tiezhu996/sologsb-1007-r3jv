import type { TermPair } from "./types";

export interface TermHit {
  pairId: string;
  index: number;
}

/** 去掉空错写法（防死循环），并按错写法长度降序排列，保证嵌套词条先套最长的。 */
const matchOrder = (pairs: TermPair[]) =>
  pairs.filter((pair) => pair.wrong.length > 0).sort((a, b) => b.wrong.length - a.wrong.length);

/**
 * 在文本中匹配已登记的错写法。
 * 规则：从左到右扫描，同一位置有多个词条能套上时取错写法最长的一条；
 * 已命中的区间被消耗，不再参与后续匹配（互不重叠）。
 */
export function findTermHits(text: string, pairs: TermPair[]): TermHit[] {
  const sorted = matchOrder(pairs);
  const hits: TermHit[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const pair = sorted.find((item) => text.startsWith(item.wrong, cursor));
    if (pair) {
      hits.push({ pairId: pair.id, index: cursor });
      cursor += pair.wrong.length;
    } else {
      cursor += 1;
    }
  }
  return hits;
}

/**
 * 把文本中属于指定词条的命中全部改写为规范写法。
 * 嵌套在更长错写法里的同名片段不属于该词条，保持原样。
 */
export function applyTermPair(text: string, pairs: TermPair[], pairId: string) {
  const pair = pairs.find((item) => item.id === pairId);
  if (!pair) return { text, count: 0 };
  const hits = findTermHits(text, pairs).filter((hit) => hit.pairId === pairId);
  if (!hits.length) return { text, count: 0 };
  let output = "";
  let cursor = 0;
  for (const hit of hits) {
    output += text.slice(cursor, hit.index) + pair.standard;
    cursor = hit.index + pair.wrong.length;
  }
  return { text: output + text.slice(cursor), count: hits.length };
}

/**
 * 若某条的规范写法同时是另一条的错写法，返回这两条：
 * source 是规范写法被复用的一方，target 是把该写法当作错写法的一方。
 */
export function findChainConflict(pairs: TermPair[]) {
  for (const source of pairs) {
    const target = pairs.find((item) => item.id !== source.id && item.wrong === source.standard);
    if (target) return { source, target };
  }
  return null;
}
