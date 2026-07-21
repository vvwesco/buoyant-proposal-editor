# Buoyant - Proposal Editor

Upload a proposal PDF and edit it paragraph by paragraph with AI: select any
paragraph, tell the AI what to do ("rewrite in our voice", "change the client to
Rolla", "add a sentence about a similar past project"), see exactly what changed,
and apply it. Edits compose and can be undone.

Built for the Buoyant take-home. Target user: a civil-engineering firm's proposal
writer recycling a past Statement of Qualifications (SOQ) into a new pursuit.

Live app: https://buoyant-proposal-editor.vercel.app  (load the "easy.pdf" sample
from the landing screen).

## Setup and run

```bash
npm install
# create .env.local:
#   BUOYANT_PROXY_BASE=https://hiring-proxy.trybuoyant.ai
#   BUOYANT_PROXY_TOKEN=<your proxy token>
npm run dev            # http://localhost:3000
```

Click "easy.pdf" on the landing screen (or drop in your own PDF), select a
paragraph in the middle pane, and edit it. The original renders in the left pane.
The token is server-side only (edits go through /api/edit).

Run the unit tests (pure parser + diff + retrieval logic, no server needed):

```bash
npm test
```

Run the eval against a running server:

```bash
node scripts/eval.mjs
```

Stack: Next.js 16 (App Router) + TypeScript + Tailwind. pdfjs-dist for text
extraction, @anthropic-ai/sdk (Claude Sonnet 5) via the proxy, and the diff
package for the word-level change preview. No database (see below).

## Design decisions

### PDF representation: geometry-first structure recovery, then edit as text
PDFs expose glyphs at (x, y), not paragraphs. I recover structure deterministically
in the browser (src/lib/pdf.ts): text items, cluster into lines by y-proximity,
split into paragraphs on vertical-gap and font-size changes, then classify headings
by relative font size and by an all-caps heading test. The document becomes an
ordered list of Blocks (src/lib/types.ts), and that list is the editable source of
truth.

Why deterministic and not an LLM parse? Two reasons. (1) Cost and latency: the brief
notes AI parsing can take 5-10 minutes; spending the model on every parse would make
the app feel broken. I spend the LLM budget on the edit, where it adds value, and
parse for free in about a second. (2) The edit loop does not need a perfect parse; it
needs stable, selectable units. Geometry gives that on the single-column easy.pdf
cleanly.

Multi-column pages: sorting purely top-to-bottom interleaves side-by-side columns, so
on the resume/bio pages of hard.pdf a sidebar heading like "AREA OF EXPERTISE/DESIGN"
absorbed body text from the other column. Before line clustering, a column-detection
pass (a projection-profile / XY-cut: find the wide, near-empty vertical gutter that
spans the page height) splits the page into columns, parses each independently, and
orders them left-to-right. If fewer than two columns are found the page takes the
identical single-pass path, so single-column pages are provably unchanged (covered by
unit tests).

### Three panes: original PDF, editable document, edit panel
- Left: the original PDF, rendered by us with pdfjs (src/components/PdfPane.tsx) and a
  transparent hit-box positioned over every recovered paragraph. This is what makes the
  panes linked: click a paragraph in either the PDF or the editable document and the
  match highlights and scrolls into view in the other, and edited paragraphs are tinted
  on the page. (An earlier version used the browser's native PDF viewer in an iframe;
  I moved back to our own canvas render specifically to get that overlay, since you
  cannot position highlights over a native viewer.)
- Middle: the reconstructed editable document. Every paragraph is a selectable unit,
  and edited paragraphs carry a track-changes marker. This is where the editing happens.
- Right: the edit panel (suggestions, actions, the diff, verifier warnings, accept/discard).

The unit of interaction is the paragraph, the natural grain of the edits users
actually ask for ("fix this sentence", "rewrite this section's intro").

### Agent design: one paragraph, tightly scoped, structured, grounded
/api/edit sends the selected paragraph plus local context (section heading,
previous and next paragraph, document title) and the instruction to Claude, and forces
a structured tool call (propose_edit returning newText, rationale, usedFacts) so the
response is always parseable. The system prompt (src/lib/anthropic.ts) hard-codes the
rules that matter for procurement documents:
- Make the smallest change that satisfies the instruction; preserve everything else,
  including voice.
- Never fabricate names, PE license numbers, dollar amounts, dates, or projects. A
  made-up fact in a bid is disqualifying. If asked for specifics it cannot verify, it
  says so in the rationale instead of inventing.
- When KB grounding is on, use only facts actually present in the retrieved excerpts,
  and list them (usedFacts) so the user can audit the grounding.

### UX: review before apply, compose, undo
The AI never edits silently. It returns a word-level diff (green add, red strike); the
user applies (Enter) or discards (Escape). Each proposal shows how much of the
paragraph it changed, flagged when a "small fix" rewrote most of it. Applied edits
compose (edit many paragraphs; each keeps a mark), and Undo reverts the last operation.

For the most common recycle task, changing a client name across the whole document,
there is a deterministic Find & replace: it shows a live match count and applies as one
undoable operation with no AI call. A literal string swap should be instant and can
never be a fabrication surface, so it does not belong in the LLM path.

### No database
State is per-session in the client; parse results are cached in-memory by file hash.
A database adds nothing to the core loop and the brief says skip it if unsure.
Persistence is a v2 concern (see below), not a demo concern.

## What I cut and why

- Re-rendering edited text back onto the original PDF image. The panes are linked
  (click-to-highlight, edited-paragraph tint), but I stopped short of painting the new
  text over the original glyphs on the canvas: covering original text and matching fonts
  is fiddly and risks looking worse than it helps. The edited copy lives in the middle
  pane and exports; the left pane stays a faithful reference. (I did go back and forth on
  the left pane: native iframe first, then our own pdfjs canvas once linked selection
  needed an overlay. See the panes note above.)
- Faithful export back to the original PDF layout. Export is Markdown, DOCX, or a clean
  paginated PDF of the edited
  model. Reconstructing the InDesign-grade SOQ layout is the "significant licensing
  cost" problem the brief calls out; not where the signal is.
- Embeddings for KB retrieval. The corpus is 5 short proposals; keyword-overlap
  retrieval (src/lib/kb.ts) is enough and spends no tokens. Embeddings would be
  theater at this scale.
- Painting edited text back onto the original PDF canvas (kept the left pane a faithful
  reference; see the panes note above).
- Auth, multi-doc workspace, autosave. Out of scope for a proof of the core loop.

## Failure modes I worried about

- Fabrication. The single worst outcome: a plausible but invented license number or
  project. Mitigated in layers: the system prompt, the usedFacts audit trail, the
  hallucination check in the eval, and a deterministic verifier pass (src/lib/verify.ts)
  that flags any new number or multi-word proper name not present in the source or KB
  before you apply. The document-wide planner is held to the same bar: when a request
  would require inventing a fact (for example "reference San Francisco" in a Missouri
  firm's SOQ), it declines and says why in plain language rather than making something up.
  An LLM can still fabricate; the next step is a second-model verifier over what the rules
  flag.
- Structure recovery on complex layouts. Two-column pages are now detected and split
  (see design decisions), but tables, 3+ columns, and full-width banners over columns can
  still mis-split. It degrades, it does not crash: you still get selectable units.
- Silent no-op or over-edit. The model could change nothing, or rewrite the whole
  paragraph when asked for a small fix. The diff plus a change-magnitude indicator
  surface this to the user, and the eval's scope metric quantifies it (95-98 percent
  retained on name changes).
- Truncation and empty edits. A long (e.g. mis-merged multi-column) block can exceed
  the output budget; the server now detects stop_reason=max_tokens and rejects empty
  edits instead of applying a cut-off paragraph.
- Wrong-paragraph edits. If the user switches blocks while a request is in flight, a
  request-id guard drops the stale response so a diff never lands on the wrong block.
- Proxy or model errors and spend. /api/edit returns a clean error to the UI on 4xx
  and 5xx; the 100 dollar cap is a hard ceiling. No retry/backoff yet; I would add it
  before production.
- Encrypted or scanned (image-only) PDFs. No text layer means an empty parse. I would
  detect this and fall back to OCR or an LLM vision parse.

## How I'd evaluate this, and what it actually scores

If you are reviewing this, here is the lens I would use. In a procurement context the
whole game is trust: an AI edit has to change exactly what was asked, ground anything it
adds, and never quietly invent a fact. Four things to look at, and where each is handled:

- Faithfulness. Does an edit change only what was asked? The unit of interaction is the
  paragraph because that is the grain writers actually work in, every change is a
  word-level diff you accept or discard, and a change-magnitude indicator flags a "small
  fix" that rewrote the whole paragraph. Measured below.
- Anti-hallucination. The system prompt forbids invented facts, the model lists the facts
  it used, and a deterministic verifier (src/lib/verify.ts) flags any new number or
  proper name not traceable to the source or KB before you apply. The document-wide
  planner declines rather than fabricate (try "reference San Francisco").
- Structure recovery. PDFs give glyphs at (x, y), not paragraphs. It is rebuilt
  deterministically in the browser, including a projection-profile column split so
  side-by-side bio and resume pages do not interleave. Single-column pages provably take
  the identical single-pass path (unit tested).
- Closing the loop. The RFP compliance matrix does not just report gaps; each missing row
  drafts a grounded, cited fix you can insert, or declines and tells you what to supply.

The metric I would watch in production is that first one, edit faithfulness. I split it
three ways and ran it against the live endpoint (scripts/eval.mjs) on real easy.pdf
paragraphs:

| Case | Metric | Result |
|---|---|---|
| Change client Dixon to Rolla (cover) | name fidelity + scope | new name present, stale name gone, 95 percent of tokens untouched |
| Change every Dixon to Rolla (Our Firm) | name fidelity + scope | all replaced, 98 percent untouched |
| Tighten Our Approach | shorten + keep facts | 371 to 289 chars, 3 of 3 key facts kept |
| Make cover more formal | scope | 3 of 3 anchors kept, 80 percent tokens retained |
| Tighten Our Firm | hallucination | 0 novel numbers, 0 novel proper nouns |

5 of 5 passed. The point is not the score on 5 cases; it is that the harness turns "we
should measure faithfulness" into a number I can watch regress. At scale I would run
this nightly over a labeled set and alert on the hallucination and stale-name rates.

## What I added beyond the brief and why

- KB grounding (a stretch goal): "Add from past work" retrieves from the 5-proposal
  corpus and the model cites which facts it used. Grounding with provenance is the
  thing that makes AI edits trustworthy in a procurement context, which is Buoyant's
  whole wedge. Verified end to end: it cited MECO's real "County Road 372 Bridge over
  Little Fabius River" project, which is present verbatim in the KB.
- The eval harness with a hallucination check: the failure mode that actually matters
  here, made measurable.
- Provenance surfacing (usedFacts shown in the UI) so a user can trust an addition.
- Deterministic Find & replace for the client-name swap, the single most common recycle
  edit: instant, no tokens, and undone in one step. Keeping it out of the LLM path is
  the point, not an afterthought.
- Guardrails that back the failure-modes section rather than just listing it: truncation
  detection, empty-edit rejection, a stale-response guard, an empty-state for
  image-only PDFs, and a change-magnitude indicator to catch over-edits.

Beyond the core loop (the "Review", "Draft", and trust parts of Buoyant's own product):
- RFP compliance matrix with one-click fixes (src/lib/compliance.ts, CompliancePanel):
  upload the RFP and it extracts the concrete requirements and checks the current draft
  against each one - met, at risk, or missing, with a reason and a supporting quote, and a
  "locate" that jumps to the paragraph. This is Buoyant's Review stage. The loop is
  closed: each unmet row has a "Draft a fix" that writes a grounded, cited paragraph you
  can insert with one click, and when a requirement needs a real form or signature it
  declines and tells you what to supply instead of faking it. Verified: it correctly
  reads a Missouri PE license as met and flags a missing non-collusion affidavit and
  missing references.
- Document-wide edits (src/lib/anthropic.ts planEdits, ChatPanel): describe a change that
  spans paragraphs ("make the whole Approach section speak to City X"); the AI plans which
  paragraphs to touch (skipping the rest), edits each through the same per-paragraph path
  (so each gets its own diff and verifier check), and you review the batch and apply it as
  one undoable operation.
- Verifier pass (src/lib/verify.ts): before you apply an edit, it flags any new number or
  multi-word proper name not traceable to the source paragraph or the KB. Deterministic,
  no extra latency; the anti-hallucination guardrail made real.

Stretch goals and product polish delivered:
- Export to Word (.docx) - the surface AEC writers round-trip through - plus a clean
  paginated PDF (jsPDF: title, bold headings, wrapped body, page numbers) and Markdown, all
  named "<original> - edited".
- Linked, interactive reference pane: instead of a read-only viewer, the PDF is rendered
  with a hit-box over every recovered paragraph, so clicking a paragraph in either pane
  highlights and scrolls to the match in the other, and edited paragraphs are tinted on
  the page.
- Multi-column parsing (the "hard fixture" stretch): column detection so hard.pdf's
  resume/bio pages parse correctly instead of interleaving the sidebar into the body,
  including full-width intro lines sitting above two columns (gutter-based bounds so a
  banner line does not merge the columns back together).
- OCR cleanup pass: PDF extraction sometimes splits a word ("Proj ect") or glues two
  together. A cheap fast-model pass repairs these at parse time, gated so it can only
  re-space text and can never change a word, number, or name (src/lib/verify.ts
  respaceWithOriginalChars).
- Find and jump: Find & replace is not just replace. Type a term and step Prev/Next
  through every matching paragraph, each scrolled into view and briefly highlighted, with
  no AI call and no change to the document.
- Supplementary knowledge base: users can add their own past proposals or resumes as
  session reference files (parsed in the browser, never uploaded) that ground
  "Add from past work" edits, with provenance.
- Editing niceties a real user expects: a track-changes toggle with a revision bar and a
  revert-all, home navigation, keyboard apply/discard, and actions that never scroll
  off-screen.

## What I'd build next given another 8 hours

1. (The Big one) Fix exporting so that the pdf format matches original

2. Better OCR, improve determination of weird layouts, sub sections, capitalization, titles, etc. (likely a hybrid where geometry proposes blocks and an LLM cleans section boundaries)

3. Along same lines as prior two - Continually display edited pdf, re render it as edits are made, find way to make this less expensive

4. Allow for user to live edit text on the web platform

5. Locally cache the OCR cleanup step so it isn't friction every time

6. Allow saving of edits to platform so that you can come back and changes persist

7. Content of Compliance, Document Edit tabs should persist as you close and open them

8. Allow for sharing a link that shows same tracked edits, etc. to allow team collaboration to stay on platform

9. Choice of models for tasks already smart, but could be smarter, allow for manual toggling or gate by plan negotiated with Buoyant

10. Windows should be collapsible and size adjustable, think Overleaf Latex editing GUI

11. Raw PDF window should allow zoom in/out

12. Strengthen the verifier with a second-model pass over what the rules flag, so the
   deterministic check gets a semantic backstop for the entities it cannot key on
   
13. Streaming edits for perceived speed, and retry/backoff on the proxy (one hiccup should
   not surface as a hard error)
   
14. Nit: Clean up domain name, landing page, beautify menu tab
