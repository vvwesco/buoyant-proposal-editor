# Buoyant — Proposal Editor

Upload a proposal PDF, and edit it **paragraph by paragraph with AI**: select any
paragraph, tell the AI what to do ("rewrite in our voice", "change the client to
Rolla", "add a sentence about a similar past project"), see exactly what changed,
and apply it. Edits compose and can be undone.

Built for the Buoyant take-home. Target user: a civil-engineering firm's proposal
writer recycling a past Statement of Qualifications (SOQ) into a new pursuit.

**Live app:** _<add Vercel URL>_  ·  **Demo fixture:** `easy.pdf` (loads from the
landing screen).

---

## Setup & run

```bash
npm install
# create .env.local:
#   BUOYANT_PROXY_BASE=https://hiring-proxy.trybuoyant.ai
#   BUOYANT_PROXY_TOKEN=<your proxy token>
npm run dev            # http://localhost:3000
```

Click **easy.pdf** on the landing screen (or drop in your own PDF), select a
paragraph in the middle pane, and edit it. The original renders in the left pane;
the token is server-side only (edits go through `/api/edit`).

Run the eval against a running server:

```bash
node scripts/eval.mjs
```

**Stack:** Next.js 16 (App Router) + TypeScript + Tailwind. `pdfjs-dist` for text
extraction, `@anthropic-ai/sdk` (Claude Sonnet 5) via the proxy, `diff` for the
word-level change preview. No database — see below.

---

## Design decisions

### PDF representation — geometry-first structure recovery, then edit as text
PDFs expose glyphs at (x, y), not paragraphs. I recover structure **deterministically**
in the browser (`src/lib/pdf.ts`): text items → cluster into lines by y-proximity →
split into paragraphs on vertical-gap and font-size changes → classify headings by
relative font size and length. The document becomes an ordered list of `Block`s
(`src/lib/types.ts`), and **that list is the editable source of truth.**

Why deterministic and not an LLM parse? Two reasons. (1) **Cost/latency:** the brief
notes AI parsing can take 5–10 min; spending the model on every parse would make the
app feel broken. I spend the LLM budget on the *edit*, where it adds value, and parse
for free in ~1s. (2) **The edit loop doesn't need a perfect parse** — it needs stable,
selectable units. Geometry gives that on the single-column `easy.pdf` cleanly.

### Two panes: fidelity on the left, editing in the middle
- **Left — original PDF** via the browser's *native* viewer (an `<iframe>` over a blob).
  I deliberately **do not re-rasterize** with a pdfjs canvas: it bought perfect fidelity
  nowhere and added a real failure surface (canvas/render races). The brief explicitly
  says faithful reconstruction isn't the point, so the native viewer is strictly better.
- **Middle — reconstructed editable document.** Every paragraph is a selectable unit;
  edited paragraphs are marked. This is where "interact with the content" happens.

The unit of interaction is the **paragraph** — the natural grain of the edits users
actually ask for ("fix this sentence", "rewrite this section's intro").

### Agent design — one paragraph, tightly scoped, structured, grounded
`/api/edit` sends the selected paragraph plus **local context** (section heading,
previous/next paragraph, document title) and the instruction to Claude, and forces a
**structured tool call** (`propose_edit → { newText, rationale, usedFacts }`) so the
response is always parseable. The system prompt (`src/lib/anthropic.ts`) hard-codes the
rules that matter for procurement docs:
- **Smallest change that satisfies the instruction**; preserve everything else, including voice.
- **Never fabricate** names, PE license numbers, dollar amounts, dates, or projects —
  a made-up fact in a bid is disqualifying. If asked for specifics it can't verify, it
  says so in the rationale instead of inventing.
- When KB grounding is on, use only facts actually present in the retrieved excerpts,
  and list them (`usedFacts`) so the user can audit the grounding.

### UX — review before apply, compose, undo
The AI never edits silently. It returns a **word-level diff** (green add / red strike);
the user applies or discards. Applied edits compose (edit many paragraphs; each keeps a
mark), and **Undo** pops the last applied change. Selecting a paragraph keeps focus;
presets cover the common asks, with a free-form box (⌘⏎) for anything else.

### No database
State is per-session in the client; parse results are cached in-memory by file hash.
A DB adds nothing to the core loop and the brief says skip it if unsure. Persistence is
a v2 concern (see below), not a demo concern.

---

## What I cut and why

- **pdfjs canvas rendering of pages** (with click-on-the-PDF overlay selection). I built
  it, hit render races, and realized it was pure risk for zero product value — the native
  viewer is more faithful. Cut it; kept selection in the reconstructed pane. *Highest-value
  cut: it removed an entire class of bugs.*
- **Faithful export back to the original PDF layout.** Export is Markdown of the edited
  model. Reconstructing the InDesign-grade SOQ layout is the "significant licensing cost"
  problem the brief calls out; not where the signal is.
- **Embeddings for KB retrieval.** The corpus is 5 short proposals; keyword-overlap
  retrieval (`src/lib/kb.ts`) is enough and spends no tokens. Embeddings would be theater
  at this scale.
- **Multi-paragraph chat.** Genuinely harder (cross-paragraph consistency, partial
  application). One thoughtful per-paragraph loop beats a shaky multi-paragraph one.
- **Auth / multi-doc workspace / autosave.** Out of scope for a 4-hour proof of the loop.

## Failure modes I worried about

- **Fabrication.** The single worst outcome: a plausible but invented license number or
  project. Mitigated by the system prompt, the `usedFacts` audit trail, and the
  hallucination check in the eval — but an LLM can still fabricate. Before a paying
  customer, I'd add a verifier pass that flags any new named-entity/number not present in
  the source or KB.
- **Structure recovery on complex layouts.** The geometry parser is tuned for single
  column. On `hard.pdf` (multi-column, tables, embedded branding) it will mis-merge or
  mis-split blocks — headings sometimes merge with the paragraph below even on `easy.pdf`
  (a known rough edge). It **degrades, doesn't crash**: you still get selectable units.
- **Silent no-op / over-edit.** The model could "change nothing" or rewrite the whole
  paragraph when asked for a small fix. The diff surfaces this to the user, and the eval's
  scope metric quantifies it (95–98% retained on name changes).
- **Proxy/model errors & spend.** `/api/edit` returns a clean error to the UI on 4xx/5xx;
  the $100 cap is a hard ceiling. No retry/backoff yet — I'd add it before production.
- **Encrypted / scanned (image-only) PDFs.** No text layer → empty parse. I'd detect this
  and fall back to OCR or an LLM vision parse.

## How I'd evaluate this — and what it actually scores

If this shipped, the metric I'd watch is **edit faithfulness**: does the AI change exactly
what was asked and nothing else, without fabricating? I split it three ways and ran it
against the live endpoint (`scripts/eval.mjs`) on real `easy.pdf` paragraphs:

| Case | Metric | Result |
|---|---|---|
| Change client Dixon→Rolla (cover) | name fidelity + scope | new name present, stale name gone, **95%** of tokens untouched |
| Change every Dixon→Rolla (Our Firm) | name fidelity + scope | all replaced, **98%** untouched |
| Tighten Our Approach | shorten + keep facts | 371→289 chars, **3/3** key facts kept |
| Make cover more formal | scope | **3/3** anchors kept, 80% tokens retained |
| Tighten Our Firm | hallucination | **0** novel numbers, **0** novel proper nouns |

**5/5 passed.** The point isn't the score on 5 cases — it's that the harness turns "we
should measure faithfulness" into a number I can watch regress. At scale I'd run this
nightly over a labeled set and alert on the hallucination and stale-name rates.

## What I added beyond the brief and why

- **KB grounding** (a stretch goal): "Add from past work" retrieves from the 5-proposal
  corpus and the model cites which facts it used — because grounding-with-provenance is
  the thing that makes AI edits *trustworthy* in a procurement context, which is Buoyant's
  whole wedge.
- **The eval harness with a hallucination check** — the failure mode that actually matters
  here, made measurable.
- **Provenance surfacing** (`usedFacts` shown in the UI) so a user can trust an addition.

## What I'd build next given another 8 hours

1. **Verifier pass** — a second model call (or rules) that flags any new entity/number not
   traceable to the source or KB, turning "trust me" into "here's what's unverified."
2. **hard.pdf**: smarter structure recovery (column detection, table handling), likely a
   hybrid where geometry proposes blocks and an LLM cleans section boundaries.
3. **Streaming edits** for perceived speed, and retry/backoff on the proxy.
4. **Multi-paragraph chat** with a plan → per-paragraph diff → batch-apply flow.
5. **Export to DOCX** (the surface Buoyant users actually live in) with styles preserved.
6. **Persistence**: save a document + its edit history so work survives a refresh.
