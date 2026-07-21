// Lightweight KB retrieval. The corpus is tiny (5 short proposals), so we skip
// embeddings and use keyword-overlap scoring over paragraph chunks. Cheap,
// deterministic, no extra API spend. Good enough to ground "add a paragraph
// about a similar past project" against the firm's real history.

import kbDocs from "@/data/kb.json";

export interface KbChunk {
  docId: string;
  project: string;
  text: string;
}

const STOP = new Set(
  "the a an and or of to for in on at by with is are was were be as our we you your their this that from will can our its it".split(
    " ",
  ),
);

function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOP.has(t),
  );
}

let _chunks: KbChunk[] | null = null;
function chunks(): KbChunk[] {
  if (_chunks) return _chunks;
  const out: KbChunk[] = [];
  for (const d of kbDocs as { id: string; project: string; text: string }[]) {
    for (const para of d.text.split(/\n{2,}/)) {
      const t = para.replace(/\s+/g, " ").trim();
      if (t.length >= 60) out.push({ docId: d.id, project: d.project, text: t });
    }
  }
  _chunks = out;
  return out;
}

export function retrieveKb(query: string, k = 4): KbChunk[] {
  const q = new Set(tokens(query));
  if (!q.size) return [];
  const scored = chunks().map((c) => {
    const ts = tokens(c.text);
    let hits = 0;
    for (const t of ts) if (q.has(t)) hits++;
    // length-normalized overlap, lightly favoring information-dense chunks
    const score = hits / Math.sqrt(ts.length + 1);
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.c);
}

export const kbProjects = (kbDocs as { id: string; project: string }[]).map(
  (d) => d.project,
);
