// Deterministic literal find-and-replace for the Find & replace bar. Both sides
// are treated literally: the search term is regex-escaped, and any $ in the
// replacement is escaped so a value like "$5,000" or "A&B" is inserted verbatim
// rather than interpreted as a replacement pattern ($&, $1, ...).
export function buildFindRegex(find: string, ci: boolean): RegExp {
  return new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ci ? "gi" : "g");
}

export function literalReplaceAll(text: string, find: string, replace: string, ci: boolean): string {
  if (!find) return text;
  return text.replace(buildFindRegex(find, ci), replace.replace(/\$/g, "$$$$"));
}

export function countMatches(text: string, find: string, ci: boolean): number {
  if (!find) return 0;
  return (text.match(buildFindRegex(find, ci)) ?? []).length;
}
