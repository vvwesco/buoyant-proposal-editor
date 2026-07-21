"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedDoc, Suggestion } from "@/lib/types";
import { parsePdf } from "@/lib/pdf";
import { literalReplaceAll, countMatches } from "@/lib/replace";
import { respaceWithOriginalChars } from "@/lib/verify";
import PdfPane from "./PdfPane";
import EditPanel, { type Proposal } from "./EditPanel";
import CompliancePanel from "./CompliancePanel";
import ChatPanel from "./ChatPanel";

// An undoable operation. An AI edit touches one block; find-replace touches many.
type Change = { blockId: string; before: string; after: string };
type Op = { id: string; label: string; changes: Change[] };

const EMPTY_SET: Set<string> = new Set();

// Best-effort OCR cleanup: ask a cheap model to fix spacing/hyphenation artifacts
// in the body paragraphs, and apply a result only when it is a spacing-only change
// (so content can never be altered). Runs once at load so these typos never show
// up later as suggested edits. On any failure it returns the doc unchanged.
async function cleanupDoc(parsed: ParsedDoc): Promise<ParsedDoc> {
  // Include headings and short section titles too - OCR splits like
  // "Proj ect Experience" often land in those. Skip only trivially short tokens.
  const candidates = parsed.blocks.filter((b) => b.text.trim().length >= 10);
  if (!candidates.length) return parsed;
  try {
    const res = await fetch("/api/cleanup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blocks: candidates.map((b) => ({ id: b.id, text: b.text })) }),
    });
    const data = await res.json();
    const map = new Map<string, string>(
      ((data.items ?? []) as { id: string; text: string }[]).map((i) => [i.id, i.text]),
    );
    let changed = 0;
    const blocks = parsed.blocks.map((b) => {
      const c = map.get(b.id);
      // Keep the model's spacing but the original characters (content-safe).
      const fixed = c ? respaceWithOriginalChars(b.text, c) : null;
      if (fixed && fixed !== b.text) {
        changed++;
        return { ...b, text: fixed, original: fixed }; // cleaned text is the new baseline
      }
      return b;
    });
    return changed ? { ...parsed, blocks } : parsed;
  } catch {
    return parsed;
  }
}

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
  const [cleaning, setCleaning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Op[]>([]);
  const [showFR, setShowFR] = useState(false);
  const [showCompliance, setShowCompliance] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [trackChanges, setTrackChanges] = useState(true);
  const [sessionKb, setSessionKb] = useState<{ name: string; text: string }[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const suggestCache = useRef<Map<string, Suggestion[]>>(new Map());
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

  // Fetch content-tailored suggestions when a substantial paragraph is selected
  // (not while a proposal is open, and not for tiny headings/labels). Cached per
  // block+text and cancelled on change so stale results never land.
  useEffect(() => {
    const block = selectedBlock;
    if (!block || proposal || block.text.trim().length < 40) {
      setSuggestions([]);
      setSuggesting(false);
      return;
    }
    const key = `${block.id}:${block.text.length}`;
    const cached = suggestCache.current.get(key);
    if (cached) {
      setSuggestions(cached);
      return;
    }
    let cancelled = false;
    setSuggestions([]);
    setSuggesting(true);
    const idx = doc ? doc.blocks.findIndex((b) => b.id === block.id) : -1;
    const heading = doc
      ? [...doc.blocks.slice(0, idx)].reverse().find((b) => b.type === "heading")?.text
      : undefined;
    fetch("/api/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        blockText: block.text,
        heading,
        docMeta: doc?.fileName.replace(/\.pdf$/, ""),
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const s = (d.suggestions ?? []) as Suggestion[];
        suggestCache.current.set(key, s);
        setSuggestions(s);
      })
      .catch(() => !cancelled && setSuggestions([]))
      .finally(() => !cancelled && setSuggesting(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, proposal, selectedBlock?.text]);

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
      setParsing(null);
      setCleaning(true);
      const cleaned = await cleanupDoc(parsed); // best-effort OCR spacing fixes
      cache.current.set(key, { doc: cleaned, buf });
      setFileBuf(buf);
      setDoc(cleaned);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse PDF.");
    } finally {
      setParsing(null);
      setCleaning(false);
    }
  }, []);

  const isPdf = (f: File) =>
    f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");

  const onUpload = async (file: File) => {
    if (!isPdf(file)) return setError("Please choose a PDF.");
    await load(await file.arrayBuffer(), file.name);
  };

  // Add supplementary reference PDFs (past proposals, resumes) to this session's
  // knowledge base. Their text grounds "Add from past work" edits. Session-only:
  // parsed in the browser, never uploaded or persisted.
  const onAddKb = async (files: FileList | File[]) => {
    const pdfs = Array.from(files).filter(isPdf);
    for (const f of pdfs) {
      try {
        const parsed = await parsePdf(await f.arrayBuffer(), f.name);
        const text = parsed.blocks.map((b) => b.text).join("\n");
        setSessionKb((prev) => [...prev.filter((k) => k.name !== f.name), { name: f.name, text }]);
      } catch {
        setError(`Could not read ${f.name}.`);
      }
    }
  };

  const removeKb = (name: string) =>
    setSessionKb((prev) => prev.filter((k) => k.name !== name));

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
          sessionKb,
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
        warnings: data.warnings ?? [],
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
        after.has(b.id) ? { ...b, text: after.get(b.id)! } : b,
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
    const changes: Change[] = [];
    for (const b of doc.blocks) {
      const next = literalReplaceAll(b.text, find, replace, ci);
      if (next !== b.text) changes.push({ blockId: b.id, before: b.text, after: next });
    }
    commit(changes, `replace "${find}"`);
    return changes.length;
  };

  // Return to the start screen. Confirm first if there are unsaved edits.
  const goHome = () => {
    if (history.length && !window.confirm("Discard your edits and return to the start screen?"))
      return;
    setDoc(null);
    setFileBuf(null);
    setSelectedId(null);
    setProposal(null);
    setHistory([]);
    setShowFR(false);
    setError(null);
    setSessionKb([]);
  };

  // Revert every edited paragraph back to its originally parsed text.
  const revertAll = () => {
    if (!doc || !history.length) return;
    if (!window.confirm("Revert all edits back to the original text?")) return;
    setDoc({ ...doc, blocks: doc.blocks.map((b) => ({ ...b, text: b.original })) });
    setHistory([]);
    setProposal(null);
  };

  const exportBase = () => (doc ? doc.fileName.replace(/\.pdf$/i, "") + " - edited" : "proposal");

  const exportMd = (name: string) => {
    if (!doc) return;
    const md = doc.blocks
      .map((b) => (b.type === "heading" ? `## ${b.text}` : b.text))
      .join("\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".md";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Export the edited document as a clean, readable PDF. Not a pixel copy of the
  // original (the brief says that isn't the point) but a real, paginated PDF a
  // client could hand off: title, bold section headings, wrapped body, footer.
  const exportPdf = async (name: string) => {
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
    pdf.setFont("times", "bold").setFontSize(18);
    ensure(24);
    pdf.text(name, margin, y);
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
    pdf.save(name + ".pdf");
  };

  // Export as a Word document - the surface AEC proposal writers actually live
  // in and round-trip through. Headings map to Word heading styles.
  const exportDocx = async (name: string) => {
    if (!doc) return;
    const { Document, Packer, Paragraph, HeadingLevel } = await import("docx");
    const children = [
      new Paragraph({ text: name, heading: HeadingLevel.TITLE }),
      ...doc.blocks.map((b) =>
        b.type === "heading"
          ? new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_2 })
          : new Paragraph({ text: b.text }),
      ),
    ];
    const blob = await Packer.toBlob(new Document({ sections: [{ children }] }));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + ".docx";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Dispatch export by format with a user-chosen filename (sanitized).
  const runExport = (rawName: string, format: "docx" | "pdf" | "md") => {
    const name = (rawName.trim() || exportBase()).replace(/[\\/:*?"<>|]+/g, "").replace(/\.(docx|pdf|md)$/i, "");
    if (format === "md") exportMd(name);
    else if (format === "pdf") exportPdf(name);
    else exportDocx(name);
    setExportOpen(false);
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
        complianceActive={showCompliance}
        chatActive={showChat}
        trackChanges={trackChanges}
        sessionKb={sessionKb}
        onHome={goHome}
        onToggleCompliance={() => {
          setShowCompliance((v) => !v);
          setShowChat(false);
        }}
        onToggleChat={() => {
          setShowChat((v) => !v);
          setShowCompliance(false);
        }}
        onToggleTrack={() => setTrackChanges((v) => !v)}
        onRevertAll={revertAll}
        onFindReplace={() => setShowFR((v) => !v)}
        onUndo={undo}
        onExport={() => setExportOpen(true)}
        onAddKb={onAddKb}
        onRemoveKb={removeKb}
        onReplaceDoc={onUpload}
      />

      {doc && showFR && (
        <FindReplaceBar doc={doc} onReplace={findReplace} onClose={() => setShowFR(false)} />
      )}

      {!doc && !parsing && !cleaning && (
        <Landing onSample={loadSample} onUpload={onUpload} error={error} />
      )}

      {(parsing || cleaning) && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-500">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-sky-600" />
          <p className="text-sm">
            {parsing
              ? `Recovering document structure${parsing.total ? ` - page ${parsing.page}/${parsing.total}` : "..."}`
              : "Cleaning up extracted text..."}
          </p>
        </div>
      )}

      {doc && fileBuf && (
        <div className="grid flex-1 grid-cols-[1fr_1.05fr_380px] overflow-hidden divide-x divide-neutral-200">
          <PdfPane
            fileBuf={fileBuf}
            doc={doc}
            selectedId={selectedId}
            editedIds={trackChanges ? editedIds : EMPTY_SET}
            onSelect={select}
          />
          <DocPane
            doc={doc}
            selectedId={selectedId}
            editedIds={editedIds}
            trackChanges={trackChanges}
            onSelect={select}
          />
          <div className="min-h-0 overflow-hidden bg-white">
            {showChat ? (
              <ChatPanel
                doc={doc}
                docMeta={doc.fileName.replace(/\.pdf$/, "")}
                sessionKb={sessionKb}
                onApply={(changes, label) => commit(changes, label)}
                onSelectBlock={select}
              />
            ) : showCompliance ? (
              <CompliancePanel doc={doc} onSelectBlock={select} />
            ) : (
              <EditPanel
                block={selectedBlock}
                proposal={proposal}
                loading={loading}
                error={error}
                suggestions={suggestions}
                suggesting={suggesting}
                onRun={runEdit}
                onAccept={applyProposal}
                onReject={() => setProposal(null)}
              />
            )}
          </div>
        </div>
      )}

      {exportOpen && doc && (
        <ExportDialog
          defaultName={exportBase()}
          onExport={runExport}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

function ExportDialog({
  defaultName,
  onExport,
  onClose,
}: {
  defaultName: string;
  onExport: (name: string, format: "docx" | "pdf" | "md") => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [format, setFormat] = useState<"docx" | "pdf" | "md">("docx");
  const ext = { docx: ".docx", pdf: ".pdf", md: ".md" }[format];
  const formats: { id: "docx" | "pdf" | "md"; label: string }[] = [
    { id: "docx", label: "Word (.docx)" },
    { id: "pdf", label: "PDF" },
    { id: "md", label: "Markdown" },
  ];
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold text-neutral-800">Export document</div>
        <label className="mb-1 block text-xs font-medium text-neutral-500">File name</label>
        <div className="flex items-center rounded-md border border-neutral-300 focus-within:border-sky-400 focus-within:ring-2 focus-within:ring-sky-100">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onExport(name, format)}
            className="min-w-0 flex-1 rounded-l-md px-2 py-1.5 text-sm outline-none"
          />
          <span className="px-2 text-xs text-neutral-400">{ext}</span>
        </div>
        <div className="mb-4 mt-3">
          <div className="mb-1 text-xs font-medium text-neutral-500">Format</div>
          <div className="flex gap-1.5">
            {formats.map((f) => (
              <button
                key={f.id}
                onClick={() => setFormat(f.id)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                  format === f.id
                    ? "border-sky-400 bg-sky-50 text-sky-700"
                    : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onExport(name, format)}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Download
          </button>
        </div>
      </div>
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
    for (const blk of doc.blocks) {
      const c = countMatches(blk.text, find, ci);
      if (c) {
        b++;
        o += c;
      }
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
  trackChanges,
  onSelect,
}: {
  doc: ParsedDoc;
  selectedId: string | null;
  editedIds: Set<string>;
  trackChanges: boolean;
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
          const marked = editedIds.has(b.id) && trackChanges; // track-changes marking
          const base =
            "block w-full cursor-pointer rounded-md px-2 py-1 text-left transition-colors";
          const tone = sel
            ? "bg-sky-50 ring-2 ring-sky-400"
            : marked
              ? "border-l-[3px] border-amber-400 bg-amber-50/50 hover:bg-amber-50 rounded-l-none"
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
              {marked && (
                <span className="ml-2 align-middle text-[10px] font-semibold uppercase text-amber-600">
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
  complianceActive,
  chatActive,
  trackChanges,
  sessionKb,
  onHome,
  onToggleCompliance,
  onToggleChat,
  onToggleTrack,
  onRevertAll,
  onFindReplace,
  onUndo,
  onExport,
  onAddKb,
  onRemoveKb,
  onReplaceDoc,
}: {
  docName?: string;
  canUndo: boolean;
  editCount: number;
  frActive: boolean;
  complianceActive: boolean;
  chatActive: boolean;
  trackChanges: boolean;
  sessionKb: { name: string; text: string }[];
  onHome: () => void;
  onToggleCompliance: () => void;
  onToggleChat: () => void;
  onToggleTrack: () => void;
  onRevertAll: () => void;
  onFindReplace: () => void;
  onUndo: () => void;
  onExport: () => void;
  onAddKb: (files: FileList) => void;
  onRemoveKb: (name: string) => void;
  onReplaceDoc: (f: File) => void;
}) {
  const btn =
    "rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50";
  return (
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2.5">
      <button
        onClick={onHome}
        title={docName ? "Back to start" : undefined}
        className="flex items-baseline gap-2 rounded-md px-1 py-0.5 hover:bg-neutral-100"
      >
        <span className="text-sm font-bold tracking-tight text-sky-700">Buoyant</span>
        <span className="text-sm text-neutral-400">Proposal Editor</span>
        {docName && <span className="ml-1 text-xs text-neutral-400">· {docName}</span>}
      </button>
      {docName && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">
            {editCount} edit{editCount === 1 ? "" : "s"}
          </span>
          <button
            onClick={onToggleTrack}
            title="Show or hide markers on edited paragraphs"
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              trackChanges
                ? "border-amber-300 bg-amber-50 text-amber-700"
                : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
            }`}
          >
            Track changes
          </button>
          <button onClick={onRevertAll} disabled={!canUndo} className={`${btn} disabled:opacity-40`}>
            Revert all
          </button>
          <span className="mx-1 h-4 w-px bg-neutral-200" />
          <button
            onClick={onToggleCompliance}
            title="Check the draft against an RFP"
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              complianceActive
                ? "border-sky-300 bg-sky-50 text-sky-700"
                : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
            }`}
          >
            Compliance
          </button>
          <button
            onClick={onToggleChat}
            title="Make a change across many paragraphs at once"
            className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
              chatActive
                ? "border-sky-300 bg-sky-50 text-sky-700"
                : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
            }`}
          >
            Document edit
          </button>
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
          <button onClick={onUndo} disabled={!canUndo} className={`${btn} disabled:opacity-40`}>
            Undo
          </button>

          {/* Reference files (session knowledge base) */}
          <details className="relative [&_summary::-webkit-details-marker]:hidden">
            <summary className={`${btn} cursor-pointer list-none`}>
              Reference files{sessionKb.length ? ` (${sessionKb.length})` : ""}
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-neutral-200 bg-white p-2 shadow-lg">
              <p className="px-1 pb-2 text-[11px] leading-snug text-neutral-500">
                Add past proposals or resumes to ground &quot;Add from past work&quot; edits.
                Session only; parsed in your browser, never uploaded.
              </p>
              {sessionKb.map((k) => (
                <div key={k.name} className="flex items-center justify-between gap-2 px-1 py-0.5 text-xs">
                  <span className="truncate text-neutral-700">{k.name}</span>
                  <button
                    onClick={() => onRemoveKb(k.name)}
                    className="shrink-0 text-neutral-400 hover:text-red-600"
                  >
                    remove
                  </button>
                </div>
              ))}
              <label className="mt-2 block cursor-pointer rounded-md border border-dashed border-neutral-300 px-3 py-2 text-center text-xs text-neutral-600 hover:border-sky-300 hover:bg-sky-50">
                Add reference PDFs
                <input
                  type="file"
                  accept="application/pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) onAddKb(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </details>

          <button onClick={onExport} className={btn}>
            Export
          </button>

          <label className="cursor-pointer rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700">
            Open PDF
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onReplaceDoc(e.target.files[0])}
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
