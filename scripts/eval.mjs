// Eval harness — runs real edits against the running app's /api/edit endpoint
// and reports diagnostics. Run the dev server, then: node scripts/eval.mjs
//
// Metrics (see README "How I'd evaluate this"):
//   1. Name fidelity    — a "change client X->Y" edit replaces every X with Y
//                         and leaves no stale X behind.
//   2. Scope discipline — the edit changes only what's asked; we measure the
//                         fraction of the original left byte-identical (word diff).
//   3. Hallucination    — a rewrite/tighten introduces no NEW numbers or proper
//                         nouns that weren't in the source (fabrication proxy).

const BASE = process.env.EVAL_BASE || "http://localhost:3000";

// Real paragraphs from easy.pdf (MECO / City of Dixon SOQ).
const OUR_FIRM =
  "MECO Engineering is celebrating its 40th anniversary this year. This long-spanning career has been built on serving municipalities, such as yours, in a vast span of projects with varying needs, requirements, funding, and challenges. We take pride in gaining the majority of our business from repeat, satisfied customers. MECO currently has seven office locations, with a location conveniently close for all your project needs in Jefferson City, MO, approximately 55 miles from the City of Dixon.";
const COVER =
  "MECO Engineering Company, Inc. (MECO) is pleased to present qualifications to the City of Dixon, MO for professional engineering services.";
const APPROACH =
  "MECO's “Standard of Care” and “Project Approach” is a team-centric based philosophy to ensure that every step of project scope development and design review fully invests the client in each step of the process. MECO does not believe in an engineer-driven project development process; we see the most value in investing our client input in the process, first and foremost.";

const CASES = [
  { name: "name-fidelity/cover", metric: "name", blockText: COVER,
    instruction: "Change the client from the City of Dixon to the City of Rolla. Change nothing else.",
    from: "Dixon", to: "Rolla" },
  { name: "name-fidelity/our-firm", metric: "name", blockText: OUR_FIRM,
    instruction: "Change every reference to the City of Dixon to the City of Rolla.",
    from: "Dixon", to: "Rolla" },
  { name: "scope/tighten-approach", metric: "tighten", blockText: APPROACH,
    instruction: "Tighten this paragraph; keep every concrete fact and the meaning.",
    keyFacts: ["Standard of Care", "Project Approach", "team-centric"] },
  { name: "scope/formal-cover", metric: "scope", blockText: COVER,
    instruction: "Make the tone slightly more formal.",
    mustKeep: ["MECO", "Dixon", "engineering services"] },
  { name: "hallucination/tighten-our-firm", metric: "halluc", blockText: OUR_FIRM,
    instruction: "Tighten this paragraph.",
    source: OUR_FIRM },
];

const tok = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
function retainedFraction(before, after) {
  // longest-common-subsequence-ish via token multiset intersection (cheap proxy)
  const a = tok(before), b = new Map();
  for (const t of tok(after)) b.set(t, (b.get(t) ?? 0) + 1);
  let keep = 0;
  for (const t of a) if ((b.get(t) ?? 0) > 0) { keep++; b.set(t, b.get(t) - 1); }
  return a.length ? keep / a.length : 1;
}
const nums = (s) => new Set(s.match(/\b\d[\d,.]*\b/g) ?? []);
const propers = (s) =>
  new Set((s.match(/\b[A-Z][a-zA-Z]+\b/g) ?? []).filter((w) => w.length > 2));

async function callEdit(c) {
  const res = await fetch(`${BASE}/api/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "custom", instruction: c.instruction, blockText: c.blockText,
      docMeta: "Statement of Qualifications for City of Dixon",
    }),
  });
  if (!res.ok) throw new Error(`${c.name}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).newText;
}

const results = [];
for (const c of CASES) {
  const after = await callEdit(c);
  const r = { name: c.name, metric: c.metric, pass: false, detail: "" };
  if (c.metric === "name") {
    const hasTo = new RegExp(`\\b${c.to}\\b`).test(after);
    const noFrom = !new RegExp(`\\b${c.from}\\b`).test(after);
    r.pass = hasTo && noFrom;
    r.detail = `${c.to} present: ${hasTo}, stale ${c.from} removed: ${noFrom}, scope kept: ${(retainedFraction(c.blockText, after) * 100) | 0}%`;
  } else if (c.metric === "tighten") {
    const shorter = after.length < c.blockText.length;
    const facts = c.keyFacts.filter((f) => after.includes(f)).length;
    r.pass = shorter && facts === c.keyFacts.length;
    r.detail = `shorter: ${shorter} (${c.blockText.length}->${after.length}), facts kept: ${facts}/${c.keyFacts.length}`;
  } else if (c.metric === "scope") {
    const kept = c.mustKeep.filter((k) => after.includes(k)).length;
    const frac = retainedFraction(c.blockText, after);
    r.pass = kept === c.mustKeep.length;
    r.detail = `anchors kept: ${kept}/${c.mustKeep.length}, tokens retained: ${(frac * 100) | 0}%`;
  } else if (c.metric === "halluc") {
    const srcN = nums(c.source), srcP = propers(c.source);
    const newN = [...nums(after)].filter((n) => !srcN.has(n));
    const newP = [...propers(after)].filter((p) => !srcP.has(p));
    r.pass = newN.length === 0 && newP.length === 0;
    r.detail = `novel numbers: [${newN.join(", ")}], novel proper nouns: [${newP.join(", ")}]`;
  }
  results.push(r);
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}`);
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n=== ${pass}/${results.length} passed ===`);
