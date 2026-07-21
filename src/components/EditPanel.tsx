"use client";

import { useEffect, useState } from "react";
import type { Block } from "@/lib/types";
import { wordDiff } from "@/lib/diffWords";

// Symmetric change size: added + removed characters over the whole diff, so a
// pure insertion reads as changed too (retention alone would call it 0%).
function changeMagnitude(before: string, after: string): number {
  let changed = 0;
  let total = 0;
  for (const p of wordDiff(before, after)) {
    total += p.value.length;
    if (p.added || p.removed) changed += p.value.length;
  }
  return total ? Math.round((changed / total) * 100) : 0;
}

export interface Proposal {
  blockId: string;
  before: string;
  after: string;
  rationale: string;
  usedFacts: string[];
  action: string;
  instruction: string;
  kbUsed: number;
}

const PRESETS: { id: string; label: string; instruction: string; kb?: boolean }[] = [
  { id: "voice", label: "Rewrite in our voice", instruction: "Rewrite this paragraph in the firm's confident, client-centric voice, keeping all facts identical." },
  { id: "tighten", label: "Tighten", instruction: "Tighten this paragraph. Remove filler and redundancy while keeping every concrete fact and the same meaning." },
  { id: "formal", label: "More formal", instruction: "Make the tone more formal and polished, suitable for a public-agency selection committee." },
  { id: "grammar", label: "Fix grammar", instruction: "Fix any grammar, spelling, or punctuation issues. Change nothing else." },
  { id: "kb", label: "Add from past work", instruction: "Add one sentence citing a relevant, similar past project this firm has done, using only the provided knowledge-base excerpts.", kb: true },
];

export default function EditPanel({
  block,
  proposal,
  loading,
  error,
  onRun,
  onAccept,
  onReject,
}: {
  block: Block | null;
  proposal: Proposal | null;
  loading: boolean;
  error: string | null;
  onRun: (action: string, instruction: string, useKb: boolean) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [useKb, setUseKb] = useState(false);

  // Keyboard: while a proposal is open, Enter applies and Escape discards.
  useEffect(() => {
    if (!proposal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onAccept();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onReject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [proposal, onAccept, onReject]);

  const changedPct = proposal ? changeMagnitude(proposal.before, proposal.after) : 0;

  if (!block) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-400">
        Select a paragraph in the document to edit it with AI.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Selected {block.type}
        </div>
        <div className="max-h-28 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-2 text-sm text-neutral-700">
          {block.text}
        </div>
      </div>

      {!proposal && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                disabled={loading}
                onClick={() => onRun(p.id, p.instruction, !!p.kb)}
                className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 transition-colors hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 disabled:opacity-50"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="mt-1">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder={'Or type an instruction. e.g. "Change the client to City of Rolla" or "mention our 40 years of experience".'}
              rows={3}
              className="w-full resize-none rounded-md border border-neutral-200 p-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && instruction.trim()) {
                  onRun("custom", instruction.trim(), useKb);
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between">
              <label className="flex items-center gap-1.5 text-xs text-neutral-500">
                <input
                  type="checkbox"
                  checked={useKb}
                  onChange={(e) => setUseKb(e.target.checked)}
                  className="accent-sky-600"
                />
                Ground in knowledge base
              </label>
              <button
                disabled={loading || !instruction.trim()}
                onClick={() => onRun("custom", instruction.trim(), useKb)}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-40"
                title="Cmd/Ctrl + Enter"
              >
                {loading ? "Thinking..." : "Generate"}
              </button>
            </div>
          </div>
        </>
      )}

      {loading && !proposal && (
        <div className="animate-pulse rounded-md bg-neutral-100 p-3 text-sm text-neutral-400">
          Drafting a proposed edit…
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {proposal && (
        <div className="flex flex-1 flex-col gap-3">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                Proposed change
              </span>
              <span
                className={`text-[11px] font-medium ${
                  changedPct > 60 ? "text-amber-600" : "text-neutral-400"
                }`}
                title="Share of the paragraph the AI changed"
              >
                {changedPct}% changed
              </span>
            </div>
            <div className="max-h-[42vh] overflow-auto rounded-md border border-neutral-200 bg-white p-2 text-sm leading-relaxed">
              {wordDiff(proposal.before, proposal.after).map((part, i) =>
                part.added ? (
                  <span key={i} className="rounded bg-emerald-100 text-emerald-800">
                    {part.value}
                  </span>
                ) : part.removed ? (
                  <span key={i} className="rounded bg-red-100 text-red-700 line-through decoration-red-400">
                    {part.value}
                  </span>
                ) : (
                  <span key={i}>{part.value}</span>
                ),
              )}
            </div>
          </div>

          {proposal.rationale && (
            <p className="text-xs italic text-neutral-500">{proposal.rationale}</p>
          )}
          {proposal.usedFacts.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              <span className="font-semibold">Grounded in KB:</span>
              <ul className="ml-4 list-disc">
                {proposal.usedFacts.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="sticky bottom-0 -mx-4 -mb-4 mt-1 flex gap-2 border-t border-neutral-200 bg-white px-4 py-3">
            <button
              onClick={onAccept}
              title="Enter"
              className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
            >
              Apply change
            </button>
            <button
              onClick={onReject}
              title="Escape"
              className="rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
