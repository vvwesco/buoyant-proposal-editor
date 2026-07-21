"use client";

import { useState } from "react";
import type { ParsedDoc } from "@/lib/types";
import type { Flag } from "@/lib/verify";
import { wordDiff } from "@/lib/diffWords";

interface Proposed {
  blockId: string;
  heading?: string;
  before: string;
  after: string;
  instruction: string;
  warnings: Flag[];
  accepted: boolean;
  error?: string;
}

type Change = { blockId: string; before: string; after: string };

// Describe a change spanning many paragraphs; the AI plans which paragraphs to
// touch, edits each through the same per-paragraph path (diff + verifier), and
// you review the batch before it lands as one undoable operation.
export default function ChatPanel({
  doc,
  docMeta,
  sessionKb,
  onApply,
  onSelectBlock,
}: {
  doc: ParsedDoc | null;
  docMeta?: string;
  sessionKb: { name: string; text: string }[];
  onApply: (changes: Change[], label: string) => void;
  onSelectBlock: (id: string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [edits, setEdits] = useState<Proposed[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const headingFor = (idx: number) =>
    doc ? [...doc.blocks.slice(0, idx)].reverse().find((b) => b.type === "heading")?.text : undefined;

  const run = async () => {
    if (!doc || !instruction.trim() || busy) return;
    setBusy(true);
    setError(null);
    setEdits([]);
    setPlanMsg(null);
    try {
      const planRes = await fetch("/api/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instruction,
          docMeta,
          blocks: doc.blocks.map((b, i) => ({ id: b.id, heading: headingFor(i), text: b.text })),
        }),
      });
      const plan = await planRes.json();
      if (!planRes.ok) throw new Error(plan.error || "Planning failed.");
      setPlanMsg(plan.message);
      if (!plan.edits?.length) return;

      const results = await Promise.all(
        (plan.edits as { blockId: string; instruction: string }[]).map(async (e) => {
          const idx = doc.blocks.findIndex((b) => b.id === e.blockId);
          const block = doc.blocks[idx];
          const heading = headingFor(idx);
          try {
            const r = await fetch("/api/edit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "chat",
                instruction: e.instruction,
                blockText: block.text,
                heading,
                before: doc.blocks[idx - 1]?.text,
                after: doc.blocks[idx + 1]?.text,
                docMeta,
                useKb: false,
                sessionKb,
              }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || "Edit failed.");
            return {
              blockId: e.blockId,
              heading,
              before: block.text,
              after: d.newText as string,
              instruction: e.instruction,
              warnings: (d.warnings ?? []) as Flag[],
              accepted: true,
            } satisfies Proposed;
          } catch (err) {
            return {
              blockId: e.blockId,
              heading,
              before: block.text,
              after: block.text,
              instruction: e.instruction,
              warnings: [],
              accepted: false,
              error: err instanceof Error ? err.message : "Edit failed.",
            } satisfies Proposed;
          }
        }),
      );
      setEdits(results.filter((r) => r.after !== r.before || r.error));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setEdits((es) => es.map((e) => (e.blockId === id ? { ...e, accepted: !e.accepted } : e)));

  const acceptedCount = edits.filter((e) => e.accepted && !e.error).length;

  const applyAll = () => {
    const changes = edits
      .filter((e) => e.accepted && !e.error)
      .map((e) => ({ blockId: e.blockId, before: e.before, after: e.after }));
    if (changes.length) onApply(changes, `chat: ${instruction.slice(0, 40)}`);
    setEdits([]);
    setPlanMsg(null);
    setInstruction("");
  };

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-400">
        Load a proposal to make document-wide edits.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 p-3">
        <div className="text-sm font-semibold text-neutral-800">Document-wide edit</div>
        <p className="mt-0.5 text-xs leading-snug text-neutral-500">
          Describe a change across many paragraphs. The AI plans which paragraphs to touch;
          you review each before applying.
        </p>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          placeholder={'e.g. "Make the whole document address the City of Rolla instead of Dixon and emphasize our local presence."'}
          className="mt-2 w-full resize-none rounded-md border border-neutral-200 p-2 text-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-neutral-400">Deterministic name swaps? Use Find &amp; replace.</span>
          <button
            onClick={run}
            disabled={busy || !instruction.trim()}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-40"
          >
            {busy ? "Planning..." : "Plan changes"}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</div>
        )}
        {planMsg && edits.length > 0 && (
          <p className="mb-2 text-xs italic text-neutral-500">{planMsg}</p>
        )}
        {busy && !edits.length && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-neutral-100" />
            ))}
          </div>
        )}
        {!busy && planMsg && edits.length === 0 && !error && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm leading-snug text-amber-800">
            {planMsg}
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {edits.map((e) => (
            <li key={e.blockId} className="rounded-md border border-neutral-200 bg-white p-2">
              <div className="mb-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={e.accepted && !e.error}
                  disabled={!!e.error}
                  onChange={() => toggle(e.blockId)}
                  className="accent-sky-600"
                />
                <button
                  onClick={() => onSelectBlock(e.blockId)}
                  className="truncate text-[11px] font-semibold uppercase tracking-wide text-neutral-400 hover:text-sky-600"
                  title="Jump to this paragraph"
                >
                  {e.heading ?? "Paragraph"}
                </button>
              </div>
              {e.error ? (
                <p className="text-xs text-red-600">Could not edit: {e.error}</p>
              ) : (
                <div className="rounded bg-neutral-50 p-1.5 text-xs leading-relaxed">
                  {wordDiff(e.before, e.after).map((p, i) =>
                    p.added ? (
                      <span key={i} className="rounded bg-emerald-100 text-emerald-800">{p.value}</span>
                    ) : p.removed ? (
                      <span key={i} className="rounded bg-red-100 text-red-700 line-through decoration-red-400">{p.value}</span>
                    ) : (
                      <span key={i}>{p.value}</span>
                    ),
                  )}
                </div>
              )}
              {e.warnings.length > 0 && (
                <p className="mt-1 text-[11px] text-red-700">
                  Verify: {e.warnings.map((w) => w.value).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>

      {edits.length > 0 && (
        <div className="border-t border-neutral-200 p-3">
          <button
            onClick={applyAll}
            disabled={acceptedCount === 0}
            className="w-full rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            Apply {acceptedCount} change{acceptedCount === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </div>
  );
}
