// Deterministic verifier for a proposed edit. It flags concrete new facts in the
// edited text - numbers (license #s, dollar amounts, quantities, dates) and
// multi-word proper names (project/place/person names) - that do NOT appear in
// the original paragraph or in the retrieved knowledge-base snippets. Those are
// exactly the fabrication surface in a procurement document. This is a cheap,
// no-latency guardrail (rules, not a second model call); a model-based verifier
// is the natural next step. Advisory only: it says "double-check these".

export type Flag = { kind: "number" | "name"; value: string };

// True when `cleaned` differs from `original` only in whitespace and hyphenation
// (line-break hyphens). Used to gate the OCR cleanup pass: a fix like
// "Proj ect" -> "Project" or "compre- hensive" -> "comprehensive" passes, but any
// change to a word, number, name, or punctuation does not - so cleanup can never
// alter content, only spacing.
export function isSpacingOnlyChange(original: string, cleaned: string): boolean {
  const strip = (s: string) => s.replace(/[\s\-‐-―]+/g, "");
  return strip(original) === strip(cleaned);
}

// Apply the model's RE-SPACING while forcing the ORIGINAL characters. This lets
// cleanup fix spacing/hyphenation even when the model also tried to change a
// letter (a common OCR "I"/"l" or "1" swap) - the letter change is reverted, the
// spacing kept. Returns null (reject) if the model added or removed real
// characters, which would be a content change we refuse to apply. This makes the
// cleanup pass unable to alter content, only whitespace.
export function respaceWithOriginalChars(original: string, cleaned: string): string | null {
  const isSep = (c: string) => /[\s\-‐-―]/.test(c);
  const oChars = [...original].filter((c) => !isSep(c));
  const cChars = [...cleaned].filter((c) => !isSep(c));
  if (oChars.length !== cChars.length) return null;
  let oi = 0;
  let out = "";
  for (const c of cleaned) out += isSep(c) ? c : oChars[oi++];
  return out;
}

const CONNECTORS = new Set(["of", "and", "the", "for", "de", "on", "at", "&"]);

// Pull runs of Capitalized words (allowing lowercase connectors mid-phrase) as
// candidate proper names, keeping only multi-word phrases to avoid flagging
// ordinary sentence-initial words like "The" or "Our".
function properPhrases(text: string): string[] {
  const clean = (w: string) => w.replace(/^[("'‘“]+/, "").replace(/[.,;:)"'’”]+$/, "");
  const isCap = (w: string) => /^[A-Z][A-Za-z0-9.&'/-]*$/.test(w);
  const words = text.split(/\s+/);
  const phrases: string[] = [];
  let cur: string[] = [];
  for (const raw of words) {
    const w = clean(raw);
    if (isCap(w)) cur.push(w);
    else if (cur.length && CONNECTORS.has(w.toLowerCase())) cur.push(w.toLowerCase());
    else {
      if (cur.length) phrases.push(cur.join(" "));
      cur = [];
    }
  }
  if (cur.length) phrases.push(cur.join(" "));
  return phrases
    .map((p) => p.replace(/\s+(?:of|and|the|for|&)$/i, "").trim())
    .filter((p) => p.split(/\s+/).length >= 2);
}

// Normalize away punctuation/whitespace so "Company, Inc." matches "Company Inc".
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

export function unverifiedAdditions(before: string, after: string, kb: string[] = []): Flag[] {
  const src = before + " " + kb.join(" ");
  const wordHay = " " + norm(src) + " ";
  const numHay = new Set((src.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "")));
  const seen = new Set<string>();
  const flags: Flag[] = [];
  for (const n of after.match(/\b\d[\d,]*(?:\.\d+)?\b/g) ?? []) {
    const bare = n.replace(/,/g, "");
    if (numHay.has(bare) || seen.has("n:" + bare)) continue;
    seen.add("n:" + bare);
    flags.push({ kind: "number", value: n });
  }
  for (const p of properPhrases(after)) {
    const np = norm(p);
    if (!np || seen.has("p:" + np) || wordHay.includes(" " + np + " ")) continue;
    seen.add("p:" + np);
    flags.push({ kind: "name", value: p });
  }
  return flags.slice(0, 8);
}
