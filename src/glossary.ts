import type { GlossaryEntry } from "./types";

/** 词条命中的一处区间 */
export interface GlossaryMatch {
  entryId: string;
  from: string;
  to: string;
  start: number;
  end: number;
}

/** 词条登记 / 应用时可能出现的问题 */
export type GlossaryIssueKind = "empty" | "same" | "duplicate";

export interface GlossaryIssue {
  kind: GlossaryIssueKind;
  message: string;
}

/** 同一片段内，一条规范写法恰好是另一条的错写法；按 A 改完文字会落进 B 的命中区 */
export interface GlossaryChain {
  /** 先应用的词条：它的规范写法等于 next.from */
  first: GlossaryEntry;
  /** 会被连带命中的另一条 */
  next: GlossaryEntry;
}

export const validateEntryDraft = (
  from: string,
  to: string,
  entries: GlossaryEntry[],
  excludeId?: string,
): GlossaryIssue | null => {
  const wrong = from.trim();
  const canonical = to.trim();
  if (!wrong || !canonical) return { kind: "empty", message: "错写法和规范写法都不能为空。" };
  if (wrong === canonical) return { kind: "same", message: "错写法与规范写法相同，无需登记。" };
  // 同一规范写法可以对应多个错写法（同一专名的几种误写），只拦截重复登记的错写法。
  const duplicated = entries.some((entry) => entry.id !== excludeId && entry.from === wrong);
  if (duplicated) {
    return { kind: "duplicate", message: `错写法「${wrong}」已经登记过，请勿重复登记。` };
  }
  return null;
};

/**
 * 扫描片段文本中当前仍能命中的词条区间。
 *
 * 同一位置可能被多条词条命中（词条互相套着）时，先套错写法最长的一条；
 * 长度相同则按词条登记顺序取靠前的一条，保证结果稳定。
 */
export function scanMatches(text: string, entries: GlossaryEntry[]): GlossaryMatch[] {
  const sorted = [...entries].sort((a, b) => b.from.length - a.from.length);
  const matches: GlossaryMatch[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let chosen: GlossaryMatch | null = null;
    for (const entry of sorted) {
      if (!entry.from) continue;
      const index = text.indexOf(entry.from, cursor);
      if (index === cursor) {
        chosen = { entryId: entry.id, from: entry.from, to: entry.to, start: index, end: index + entry.from.length };
        break;
      }
    }
    if (chosen) {
      matches.push(chosen);
      cursor = chosen.end;
    } else {
      cursor += 1;
    }
  }
  return matches;
}

export const countMatches = (text: string, entries: GlossaryEntry[]) => scanMatches(text, entries).length;

/**
 * 找出「规范写法又是另一条错写法」的词条对（含跨片段的间接环）。
 * 登记时即时提示；对某片段应用前也据此判断是否需要停下。
 */
export function findChains(entries: GlossaryEntry[]): GlossaryChain[] {
  const chains: GlossaryChain[] = [];
  for (const first of entries) {
    for (const next of entries) {
      if (next.id === first.id) continue;
      if (first.to.trim() === next.from.trim()) {
        chains.push({ first, next });
      }
    }
  }
  return chains;
}

/**
 * 应用单条词条前的链式检查：本片段按 entry 改写后，文字里是否会落入另一条词条的错写法。
 * 只检查直接的一跳——应用器一次只处理一条词条，环里的下一跳由后续应用再次拦截。
 */
export function chainBlockingEntry(
  entry: GlossaryEntry,
  entries: GlossaryEntry[],
): GlossaryEntry | null {
  return entries.find((other) => other.id !== entry.id && other.from.trim() === entry.to.trim()) ?? null;
}

/**
 * 把片段中属于 entry 的命中替换为规范写法，返回新文本（不改原串）。
 * 扫描用全部词条做最长优先，因此嵌套在更长词条内部的短词条不会被误改：
 * 例如同时登记「汇演 → 会演」「文艺汇演 → 文艺会演」时，对「汇演」应用只改独立出现的「汇演」。
 */
export function applyEntryToText(text: string, entry: GlossaryEntry, entries: GlossaryEntry[]): string {
  if (!entry.from) return text;
  const matches = scanMatches(text, entries).filter((match) => match.entryId === entry.id);
  if (!matches.length) return text;
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.start) + entry.to;
    cursor = match.end;
  }
  return result + text.slice(cursor);
}
