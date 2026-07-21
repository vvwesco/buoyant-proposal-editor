"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedDoc } from "@/lib/types";
import { parsePdf } from "@/lib/pdf";
import PdfPane from "./PdfPane";
import EditPanel, { type Proposal } from "./EditPanel";

// An undoable operation. An AI edit touches one block; find-replace touches many.
type Change = { blockId: string; before: string; after: string };
type Op = { id: string; label: string; changes: Change[] };

// Content hash so re-uploading the exact same bytes reuses the cached parse,
// while a different file that happens to share a name/size does not collide.
async function hashBuf(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function Editor() {
  const [doc, setDoc] = useState<ParsedDoc | null>(null);
  const [fileBuf, setFileBuf] = useState<ArrayBuffer | null>(null);
  const [parsing, setParsing] = useState<{ page: number; total: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Op[]>([]);
  const [showFR, setShowFR] = useState(false);
  const opSeq = useRef(0);
  const cache = useRef<Map<string, { doc: ParsedDoc; buf: ArrayBuffer }>>(new Map());
  // Monotonic id used to drop stale in-flight edit responses when the user
  // switches blocks or starts another edit before the previous one returns.
  const reqRef = useRef(0);

  const editedIds = useMemo(
    () => new Set((doc?.blocks ?? []).filter((b) => b.text !== b.original).map((b) => b.id)),
    [doc],
  );
  const selectedBlock = doc?.blocks.find((b) => b.id === selectedId) ?? null;

  const load = useCallback(async (buf: ArrayBuffer, name: string) => {
    setError(null);
    setProposal(null);
    setSelectedId(null);
    setHistory([]);
    const key = `${name}:${await hashBuf(buf)}`;
    const hit = cache.current.get(key);
    if (hit) {
      setFileBuf(hit.buf);
      setDoc(hit.doc);
      return;
    }
    setDoc(null);
    setParsing({ page: 0, total: 0 });
    try {
      const parsed = await parsePdf(buf, name, (page, total) => setParsing({ page, total }));
      cache.current.set(key, { doc: parsed, buf });
      setFileBuf(buf);
      setDoc(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse PDF.");
    } finally {
      setParsing(null);
    }
  }, []);

  const onUpload = async (file: File) => {
    if (file.type !== "application/pdf") return setError("Please upload a PDF.");
    await load(await file.arrayBuffer(), file.name);
  };

  const loadSample = async (which: "easy" | "hard") => {
    setError(null);
    const res = await fetch(`/fixtures/${which}.pdf`);
    await load(await res.arrayBuffer(), `${which}.pdf`);
  };

  const runEdit = async (action: string, instruction: string, useKb: boolean) => {
    if (!selectedBlock || !doc) return;
    const target = selectedBlock; // pin the block; selection may change mid-request
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    setProposal(null);
    const idx = doc.blocks.findIndex((b) => b.id === target.id);
    const heading = [...doc.blocks.slice(0, idx)].reverse().find((b) => b.type === "heading")?.text;
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          instruction,
          blockText: target.text,
          heading,
          before: doc.blocks[idx - 1]?.text,
          after: doc.blocks[idx + 1]?.text,
          docMeta: doc.fileName.replace(/\.pdf$/, ""),
          useKb,
        }),
      });
      const data = await res.json();
      if (reqRef.current !== myReq) return; // user moved on; discard stale result
      if (!res.ok) throw new Error(data.error || "Edit failed.");
      setProposal({
        blockId: target.id,
        before: target.text,
        after: data.newText,
        rationale: data.rationale ?? "",
        usedFacts: data.usedFacts ?? [],
        action,
        instruction,
        kbUsed: data.kbUsed ?? 0,
      });
    } catch (e) {
      if (reqRef.current !== myReq) return;
      setError(e instanceof Error ? e.message : "Edit failed.");
    } finally {
      if (reqRef.current === myReq) setLoading(false);
    }
  };

  // Apply a set of block changes as one undoable operation.
  const commit = (changes: Change[], label: string) => {
    if (!doc || !changes.length) return;
    const after = new Map(changes.map((c) => [c.blockId, c.after]));
    setDoc({
      ...doc,
      blocks: doc.blocks.map((b) =>
        after.has(b.id) ? { ...b, text: after.get(b.id)!, edited: true } : b,
      ),
    });
    setHistory((h) => [...h, { id: `op_${opSeq.current++}`, label, changes }]);
  };

  const applyProposal = () => {
    if (!proposal) return;
    commit(
      [{ blockId: proposal.blockId, before: proposal.before, after: proposal.after }],
      proposal.action,
    );
    setProposal(null);
  };

  const undo = () => {
    if (!history.length || !doc) return;
    const last = history[history.length - 1];
    const before = new Map(last.changes.map((c) => [c.blockId, c.before]));
    setDoc({
      ...doc,
      blocks: doc.blocks.map((b) =>
        before.has(b.id) ? { ...b, text: before.get(b.id)! } : b,
      ),
    });
    setHistory((h) => h.slice(0, -1));
    setProposal(null);
    if (last.changes.length === 1) setSelectedId(last.changes[0].blockId);
  };

  // Deterministic global find-replace. The most common real task (fixing a
  // client name across the doc) shouldn't cost an LLM call per paragraph, and a
  // literal string swap must never be a fabrication surface.
  const findReplace = (find: string, replace: string, ci: boolean): number => {
    if (!doc || !find) return 0;
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ci ? "gi" : "g");
    const changes: Change[] = [];
    for (const b of doc.blocks) {
      const next = b.text.replace(re, replace);
      if (next !== b.text) changes.push({ blockId: b.id, before: b.text, after: next });
    }
    commit(changes, `replace "${find}"`);
    return changes.length;
  };

  const exportDoc = () => {
    if (!doc) return;
    const md = doc.blocks
      .map((b) => (b.type === "heading" ? `## ${b.text}` : b.text))
      .join("\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = doc.fileName.replace(/\.pdf$/, "") + ".edited.md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Export the edited document as a clean, readable PDF. Not a pixel copy of the
  // original (the brief says that isn't the point) but a real, paginated PDF a
  // client could hand off: title, bold section headings, wrapped body, footer.
  const exportPdf = async () => {
    if (!doc) return;
    const { jsPDF } = await import("jspdf");
    const pdf = new jsPDF({ unit: "pt", format: "letter" });
    const margin = 64;
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const maxW = pageW - margin * 2;
    let y = margin;
    const ensure = (h: number) => {
      if (y + h > pageH - margin) {
        pdf.addPage();
        y = margin;
      }
    };
    const title = doc.fileName.replace(/\.pdf$/i, "");
    pdf.setFont("times", "bold").setFontSize(18);
    ensure(24);
    pdf.text(title, margin, y);
    y += 30;
    for (const b of doc.blocks) {
      if (b.type === "heading") {
        pdf.setFont("times", "bold").setFontSize(13);
        const lines = pdf.splitTextToSize(b.text, maxW) as string[];
        y += 8;
        ensure(lines.length * 16);
        pdf.text(lines, margin, y);
        y += lines.length * 16 + 3;
      } else {
        pdf.setFont("times", "normal").setFontSize(11);
        const lines = pdf.splitTextToSize(b.text, maxW) as string[];
        for (const line of lines) {
          ensure(15);
          pdf.text(line, margin, y);
          y += 15;
        }
        y += 7;
      }
    }
    // page numbers
    const pages = pdf.getNumberOfPages();
    pdf.setFont("times", "normal").setFontSize(9).setTextColor(150);
    for (let p = 1; p <= pages; p++) {
      pdf.setPage(p);
      pdf.text(`Page ${p} of ${pages}`, pageW / 2, pageH - margin / 2, { align: "center" });
    }
    pdf.save(title + ".edited.pdf");
  };

  // Shared selection used by both panes so clicking in one highlights the other.
  const select = (id: string) => {
    reqRef.current++; // invalidate any in-flight edit for the previously selected block
    setSelectedId(id);
    setProposal(null);
    setError(null);
    setLoading(false);
  };

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <Header
        docName={doc?.fileName}
        canUndo={history.length > 0}
        editCount={history.length}
        frActive={showFR}
        onFindReplace={() => setShowFR((v) => !v)}
        onUndo={undo}
        onExportPdf={exportPdf}
        onExportMd={exportDoc}
        onUpload={onUpload}
      />

      {doc && showFR && (
        <FindReplaceBar doc={doc} onReplace={findReplace} onClose={() => setShowFR(false)} />
      )}

      {!doc && !parsing && <Landing onSample={loadSample} onUpload={onUpload} error={error} />}

      {parsing && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-500">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-sky-600" />
          <p className="text-sm">
            Recovering document structure
            {parsing.total ? ` - page ${parsing.page}/${parsing.total}` : "..."}
          </p>
        </div>
      )}

      {doc && fileBuf && (
        <div className="grid flex-1 grid-cols-[1fr_1.05fr_380px] overflow-hidden divide-x divide-neutral-200">
          <PdfPane
            fileBuf={fileBuf}
            doc={doc}
            selectedId={selectedId}
            editedIds={editedIds}
            onSelect={select}
          />
          <DocPane
            doc={doc}
            selectedId={selectedId}
            editedIds={editedIds}
            onSelect={select}
          />
          <div className="bg-white">
            <EditPanel
              block={selectedBlock}
              proposal={proposal}
              loading={loading}
              error={error}
              onRun={runEdit}
              onAccept={applyProposal}
              onReject={() => setProposal(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FindReplaceBar({
  doc,
  onReplace,
  onClose,
}: {
  doc: ParsedDoc;
  onReplace: (find: string, replace: string, ci: boolean) => number;
  onClose: () => void;
}) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [ci, setCi] = useState(true);
  const [result, setResult] = useState<string | null>(null);

  const { blocks, occ } = useMemo(() => {
    if (!find) return { blocks: 0, occ: 0 };
    let b = 0;
    let o = 0;
    try {
      const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), ci ? "gi" : "g");
      for (const blk of doc.blocks) {
        const m = blk.text.match(re);
        if (m) {
          b++;
          o += m.length;
        }
      }
    } catch {
      /* invalid input mid-type */
    }
    return { blocks: b, occ: o };
  }, [find, ci, doc]);

  const run = () => {
    const n = onReplace(find, replace, ci);
    setResult(n ? `Replaced in ${n} paragraph${n === 1 ? "" : "s"}` : "No matches");
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm">
      <input
        autoFocus
        value={find}
        onChange={(e) => {
          setFind(e.target.value);
          setResult(null);
        }}
        placeholder="Find"
        className="w-40 rounded-md border border-neutral-300 px-2 py-1 outline-none focus:border-sky-400"
      />
      <input
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
        placeholder="Replace with"
        className="w-40 rounded-md border border-neutral-300 px-2 py-1 outline-none focus:border-sky-400"
        onKeyDown={(e) => e.key === "Enter" && find && occ > 0 && run()}
      />
      <label className="flex items-center gap-1 text-xs text-neutral-500">
        <input
          type="checkbox"
          checked={ci}
          onChange={(e) => setCi(e.target.checked)}
          className="accent-sky-600"
        />
        Ignore case
      </label>
      <span className="text-xs text-neutral-400">
        {find
          ? `${occ} match${occ === 1 ? "" : "es"} in ${blocks} paragraph${blocks === 1 ? "" : "s"}`
          : "Deterministic, no AI, instantly undoable"}
      </span>
      <button
        onClick={run}
        disabled={!find || occ === 0}
        className="rounded-md bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-40"
      >
        Replace all
      </button>
      {result && <span className="text-xs font-medium text-emerald-600">{result}</span>}
      <button
        onClick={onClose}
        className="ml-auto rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200"
      >
        Close
      </button>
    </div>
  );
}

function DocPane({
  doc,
  selectedId,
  editedIds,
  onSelect,
}: {
  doc: ParsedDoc;
  selectedId: string | null;
  editedIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  // Scroll to the selected block when the selection comes from the PDF pane.
  // "nearest" means a click inside this pane won't cause a jump.
  useEffect(() => {
    if (!selectedId) return;
    document
      .getElementById(`doc-${selectedId}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  return (
    <div className="h-full overflow-auto bg-white px-8 py-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Editable document
        </div>
        {doc.blocks.length === 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            No selectable text was found in this PDF. It may be scanned or
            image-only. The original is still viewable on the left, but
            paragraph editing needs a text layer (OCR support is on the roadmap).
          </div>
        )}
        {doc.blocks.map((b) => {
          const sel = b.id === selectedId;
          const edited = editedIds.has(b.id);
          const base =
            "block w-full cursor-pointer rounded-md px-2 py-1 text-left transition-colors";
          const tone = sel
            ? "bg-sky-50 ring-2 ring-sky-400"
            : edited
              ? "bg-emerald-50/70 hover:bg-emerald-50 ring-1 ring-emerald-200"
              : "hover:bg-neutral-100 ring-1 ring-transparent";
          return (
            <button
              key={b.id}
              id={`doc-${b.id}`}
              onClick={() => onSelect(b.id)}
              className={`${base} ${tone} ${
                b.type === "heading" ? "mt-4 text-base font-bold text-neutral-800" : "mb-1 text-[15px] leading-relaxed text-neutral-700"
              }`}
            >
              {b.text}
              {edited && (
                <span className="ml-2 align-middle text-[10px] font-semibold uppercase text-emerald-600">
                  edited
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Header({
  docName,
  canUndo,
  editCount,
  frActive,
  onFindReplace,
  onUndo,
  onExportPdf,
  onExportMd,
  onUpload,
}: {
  docName?: string;
  canUndo: boolean;
  editCount: number;
  frActive: boolean;
  onFindReplace: () => void;
  onUndo: () => void;
  onExportPdf: () => void;
  onExportMd: () => void;
  onUpload: (f: File) => void;
}) {
  return (
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-bold tracking-tight text-sky-700">Buoyant</span>
        <span className="text-sm text-neutral-400">Proposal Editor</span>
        {docName && <span className="ml-2 text-xs text-neutral-400">· {docName}</span>}
      </div>
      {docName && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">
            {editCount} edit{editCount === 1 ? "" : "s"}
          </span>
          <button
            onClick={onFindReplace}
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              frActive
                ? "border-sky-300 bg-sky-50 text-sky-700"
                : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
            }`}
          >
            Find &amp; replace
          </button>
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
          >
            Undo
          </button>
          <details className="relative [&_summary::-webkit-details-marker]:hidden">
            <summary className="cursor-pointer list-none rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50">
              Export
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg">
              <button
                onClick={(e) => {
                  onExportPdf();
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-sky-50"
              >
                PDF (edited proposal)
              </button>
              <button
                onClick={(e) => {
                  onExportMd();
                  e.currentTarget.closest("details")?.removeAttribute("open");
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-sky-50"
              >
                Markdown
              </button>
            </div>
          </details>
          <label className="cursor-pointer rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700">
            Upload
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
          </label>
        </div>
      )}
    </header>
  );
}

function Landing({
  onSample,
  onUpload,
  error,
}: {
  onSample: (w: "easy" | "hard") => void;
  onUpload: (f: File) => void;
  error: string | null;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-lg text-center">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-800">
          Edit a proposal, paragraph by paragraph
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500">
          Upload a proposal PDF. We recover its structure so you can select any
          paragraph and ask AI to rewrite, tighten, fix names, or ground it in
          your past work, then review every change before it lands.
        </p>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) onUpload(f);
          }}
          className={`mt-6 flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 transition-colors ${
            drag ? "border-sky-400 bg-sky-50" : "border-neutral-300 bg-white hover:border-sky-300"
          }`}
        >
          <span className="text-sm font-medium text-neutral-600">
            Drop a PDF here, or click to browse
          </span>
          <input
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
        </label>

        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          <span className="text-neutral-400">or try a sample:</span>
          <button
            onClick={() => onSample("easy")}
            className="rounded-md bg-sky-600 px-3 py-1.5 font-medium text-white hover:bg-sky-700"
          >
            easy.pdf (8pp)
          </button>
          <button
            onClick={() => onSample("hard")}
            className="rounded-md border border-neutral-300 px-3 py-1.5 font-medium text-neutral-700 hover:bg-neutral-50"
          >
            hard.pdf (19pp)
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
