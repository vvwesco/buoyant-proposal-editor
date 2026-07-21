import { diffWords } from "diff";

export interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

// Word-level diff for the accept/reject preview.
export function wordDiff(before: string, after: string): DiffPart[] {
  return diffWords(before, after).map((p) => ({
    value: p.value,
    added: p.added,
    removed: p.removed,
  }));
}

// Fraction of the original text left byte-identical (used by the eval and the
// "how big was this change" UI hint). 1 = untouched, 0 = fully rewritten.
export function retainedFraction(before: string, after: string): number {
  const parts = wordDiff(before, after);
  let same = 0;
  let total = 0;
  for (const p of parts) {
    const n = p.value.length;
    if (!p.added) total += n; // removed + unchanged make up the "before"
    if (!p.added && !p.removed) same += n;
  }
  return total === 0 ? 1 : same / total;
}
