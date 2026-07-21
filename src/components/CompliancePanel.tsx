"use client";

import { useState } from "react";
import type { ParsedDoc } from "@/lib/types";
import { parsePdf } from "@/lib/pdf";

// One row returned by /api/compliance: requirement fields merged with assessment.
interface Row {
  id: string;
  text: string;
  category: string;
  mandatory: boolean;
  status: "met" | "partial" | "missing";
  note: string;
  evidence: string;
}

interface Summary {
  met: number;
  partial: number;
  missing: number;
  total: number;
}

// Build a single proposal string from the parsed doc. Headings are marked so the
// model can see document structure; body blocks are joined with blank lines.
function buildProposalText(doc: ParsedDoc): string {
  return doc.blocks
    .map((b) => (b.type === "heading" ? `\n## ${b.text}` : b.text))
    .join("\n")
    .trim();
}

// Find the doc block that best contains a chunk of the evidence quote, so the
// "locate" button can jump to it. Deterministic and client-side (no API cost):
// normalize whitespace/case, then look for a window of the evidence inside any
// block, shrinking the window until something matches. Falls back to the block
// with the most shared words.
function locateBlock(doc: ParsedDoc, evidence: string): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const ev = norm(evidence);
  if (ev.length < 6) return null;
  const blocks = doc.blocks.map((b) => ({ id: b.id, t: norm(b.text) }));

  // Substring match on a shrinking window of the evidence.
  for (let len = Math.min(ev.length, 80); len >= 12; len -= 8) {
    for (let start = 0; start + len <= ev.length; start += Math.max(1, Math.floor(len / 2))) {
      const chunk = ev.slice(start, start + len);
      const hit = blocks.find((b) => b.t.includes(chunk));
      if (hit) return hit.id;
    }
  }

  // Fallback: highest shared-word overlap.
  const evWords = new Set(ev.split(" ").filter((w) => w.length > 3));
  if (!evWords.size) return null;
  let bestId: string | null = null;
  let bestScore = 0;
  for (const b of blocks) {
    let score = 0;
    for (const w of b.t.split(" ")) if (evWords.has(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestId = b.id;
    }
  }
  return bestScore >= 2 ? bestId : null;
}

const STATUS_STYLE: Record<Row["status"], { chip: string; label: string }> = {
  met: { chip: "bg-emerald-100 text-emerald-800 border border-emerald-200", label: "Met" },
  partial: { chip: "bg-amber-100 text-amber-800 border border-amber-200", label: "At risk" },
  missing: { chip: "bg-red-100 text-red-700 border border-red-200", label: "Missing" },
};

interface Draft {
  text: string;
  usedFacts: string[];
  note: string;
  warnings: { kind: string; value: string }[];
  loading?: boolean;
  error?: string;
}

export default function CompliancePanel({
  doc,
  sessionKb,
  onSelectBlock,
  onInsertParagraph,
}: {
  doc: ParsedDoc | null;
  sessionKb: { name: string; text: string }[];
  onSelectBlock: (blockId: string) => void;
  onInsertParagraph: (text: string) => void;
}) {
  const [rfp, setRfp] = useState<{ name: string; text: string } | null>(null);
  const [parsing, setParsing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const draftFixFor = async (r: Row) => {
    if (!doc) return;
    setDrafts((d) => ({ ...d, [r.id]: { text: "", usedFacts: [], note: "", warnings: [], loading: true } }));
    try {
      const res = await fetch("/api/draft-fix", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requirement: r.text,
          category: r.category,
          proposalText: buildProposalText(doc),
          sessionKb,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Draft failed.");
      setDrafts((d) => ({
        ...d,
        [r.id]: {
          text: data.text ?? "",
          usedFacts: data.usedFacts ?? [],
          note: data.note ?? "",
          warnings: data.warnings ?? [],
        },
      }));
    } catch (e) {
      setDrafts((d) => ({
        ...d,
        [r.id]: { text: "", usedFacts: [], note: "", warnings: [], error: e instanceof Error ? e.message : "Draft failed." },
      }));
    }
  };

  const insertDraft = (id: string, text: string) => {
    onInsertParagraph(text);
    setDrafts((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
  };

  const isPdf = (f: File) =>
    f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");

  // Run the matrix: extract requirements from the RFP, check them against the
  // current proposal draft. Uses whatever RFP text is passed (fresh upload) or
  // the already-loaded RFP (re-check).
  const run = async (rfpText: string) => {
    if (!doc) return;
    setChecking(true);
    setError(null);
    setRows(null);
    setSummary(null);
    setDrafts({});
    try {
      const res = await fetch("/api/compliance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rfpText, proposalText: buildProposalText(doc) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Compliance check failed.");
      setRows(data.requirements ?? []);
      setSummary(data.summary ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compliance check failed.");
    } finally {
      setChecking(false);
    }
  };

  // Parse an uploaded RFP PDF in the browser, then immediately run the matrix.
  const onUploadRfp = async (file: File) => {
    if (!isPdf(file)) return setError("Please choose a PDF.");
    setError(null);
    setParsing(true);
    try {
      const parsed = await parsePdf(await file.arrayBuffer(), file.name);
      const text = parsed.blocks.map((b) => b.text).join("\n");
      setRfp({ name: file.name, text });
      await run(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the RFP PDF.");
    } finally {
      setParsing(false);
    }
  };

  const changeRfp = () => {
    setRfp(null);
    setRows(null);
    setSummary(null);
    setError(null);
    setDrafts({});
  };

  const onLocate = (evidence: string) => {
    if (!doc) return;
    const id = locateBlock(doc, evidence);
    if (id) onSelectBlock(id);
  };

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-400">
        Load a proposal to check it against an RFP.
      </div>
    );
  }

  // No RFP yet: dropzone / file picker.
  if (!rfp) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-auto p-4">
        <div>
          <div className="text-sm font-semibold text-neutral-800">Compliance matrix</div>
          <p className="mt-1 text-xs leading-snug text-neutral-500">
            Upload the RFP for this pursuit. We extract its requirements and check
            your current draft against each one - met, at risk, or missing.
          </p>
        </div>
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) onUploadRfp(f);
          }}
          className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-neutral-300 bg-white p-8 text-center transition-colors hover:border-sky-300 hover:bg-sky-50"
        >
          <span className="text-sm font-medium text-neutral-600">
            {parsing ? "Reading RFP..." : "Drop the RFP PDF here, or click to browse"}
          </span>
          <span className="text-[11px] text-neutral-400">Parsed in your browser, then checked against the draft.</span>
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            disabled={parsing}
            onChange={(e) => e.target.files?.[0] && onUploadRfp(e.target.files[0])}
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* RFP header + controls */}
      <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2.5">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Checking against
          </div>
          <div className="truncate text-sm font-medium text-neutral-700">{rfp.name}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => run(rfp.text)}
            disabled={checking}
            className="rounded-md bg-sky-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-40"
          >
            {checking ? "Checking..." : "Re-check"}
          </button>
          <button
            onClick={changeRfp}
            disabled={checking}
            className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
          >
            Change RFP
          </button>
        </div>
      </div>

      {/* Summary row */}
      {summary && (
        <div className="flex items-center gap-4 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-xs font-medium">
          <span className="text-emerald-700">{summary.met} met</span>
          <span className="text-amber-700">{summary.partial} at risk</span>
          <span className="text-red-700">{summary.missing} missing</span>
          <span className="ml-auto text-neutral-400">{summary.total} requirements</span>
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {checking && !rows && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-neutral-100" />
            ))}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {rows && rows.length === 0 && !checking && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            No checkable requirements were found in this RFP. It may be a cover
            letter or an image-only PDF without a text layer.
          </div>
        )}

        {rows && rows.length > 0 && (
          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const style = STATUS_STYLE[r.status];
              return (
                <li
                  key={r.id}
                  className="rounded-md border border-neutral-200 bg-white p-2.5"
                >
                  <div className="flex items-start gap-2">
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${style.chip}`}>
                      {style.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-neutral-800">
                        {r.text}
                        {r.mandatory && (
                          <span className="ml-1.5 align-middle text-[10px] font-semibold uppercase text-neutral-400">
                            required
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-neutral-500">{r.note}</p>
                      {r.evidence && (
                        <div className="mt-1.5 flex items-start gap-2">
                          <span className="min-w-0 flex-1 truncate text-[11px] italic text-neutral-400">
                            "{r.evidence}"
                          </span>
                          <button
                            onClick={() => onLocate(r.evidence)}
                            className="shrink-0 rounded border border-sky-200 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 hover:bg-sky-50"
                            title="Jump to the matching paragraph"
                          >
                            locate
                          </button>
                        </div>
                      )}

                      {r.status !== "met" && !drafts[r.id] && (
                        <button
                          onClick={() => draftFixFor(r)}
                          className="mt-2 rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 hover:bg-sky-100"
                        >
                          Draft a fix
                        </button>
                      )}

                      {drafts[r.id] && (
                        <DraftCard
                          draft={drafts[r.id]}
                          onInsert={() => insertDraft(r.id, drafts[r.id].text)}
                          onRetry={() => draftFixFor(r)}
                          onDismiss={() =>
                            setDrafts((d) => {
                              const next = { ...d };
                              delete next[r.id];
                              return next;
                            })
                          }
                        />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function DraftCard({
  draft,
  onInsert,
  onRetry,
  onDismiss,
}: {
  draft: Draft;
  onInsert: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (draft.loading) return <div className="mt-2 h-14 animate-pulse rounded-md bg-neutral-100" />;
  if (draft.error) {
    return (
      <div className="mt-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
        {draft.error}{" "}
        <button onClick={onRetry} className="underline">
          retry
        </button>
      </div>
    );
  }
  if (!draft.text) {
    return (
      <div className="mt-2 rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
        {draft.note || "This requirement needs a form or data you must supply; it can't be drafted."}{" "}
        <button onClick={onDismiss} className="text-neutral-400 underline">
          dismiss
        </button>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-md border border-sky-200 bg-sky-50/60 p-2">
      <p className="text-xs leading-relaxed text-neutral-800">{draft.text}</p>
      {draft.usedFacts.length > 0 && (
        <p className="mt-1 text-[10px] text-emerald-700">Grounded in: {draft.usedFacts.join("; ")}</p>
      )}
      {draft.warnings.length > 0 && (
        <p className="mt-1 text-[10px] font-medium text-red-700">
          Verify (not found in KB): {draft.warnings.map((w) => w.value).join(", ")}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          onClick={onInsert}
          className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-emerald-700"
        >
          Insert into document
        </button>
        <button
          onClick={onRetry}
          className="rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-50"
        >
          Redo
        </button>
        <button
          onClick={onDismiss}
          className="rounded-md px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
