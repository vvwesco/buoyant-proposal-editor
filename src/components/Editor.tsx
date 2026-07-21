"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { ParsedDoc, Block, EditRecord } from "@/lib/types";
import { parsePdf } from "@/lib/pdf";
import PdfPane from "./PdfPane";
import EditPanel, { type Proposal } from "./EditPanel";

export default function Editor() {
  const [doc, setDoc] = useState<ParsedDoc | null>(null);
  const [fileBuf, setFileBuf] = useState<ArrayBuffer | null>(null);
  const [parsing, setParsing] = useState<{ page: number; total: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<EditRecord[]>([]);
  const cache = useRef<Map<string, { doc: ParsedDoc; buf: ArrayBuffer }>>(new Map());

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
    const key = `${name}:${buf.byteLength}`;
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
    setLoading(true);
    setError(null);
    setProposal(null);
    const idx = doc.blocks.findIndex((b) => b.id === selectedBlock.id);
    const heading = [...doc.blocks.slice(0, idx)].reverse().find((b) => b.type === "heading")?.text;
    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          instruction,
          blockText: selectedBlock.text,
          heading,
          before: doc.blocks[idx - 1]?.text,
          after: doc.blocks[idx + 1]?.text,
          docMeta: doc.fileName.replace(/\.pdf$/, ""),
          useKb,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Edit failed.");
      setProposal({
        blockId: selectedBlock.id,
        before: selectedBlock.text,
        after: data.newText,
        rationale: data.rationale ?? "",
        usedFacts: data.usedFacts ?? [],
        action,
        instruction,
        kbUsed: data.kbUsed ?? 0,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Edit failed.");
    } finally {
      setLoading(false);
    }
  };

  const applyProposal = () => {
    if (!proposal || !doc) return;
    setDoc({
      ...doc,
      blocks: doc.blocks.map((b) =>
        b.id === proposal.blockId ? { ...b, text: proposal.after, edited: true } : b,
      ),
    });
    setHistory((h) => [
      ...h,
      {
        id: `e_${h.length}`,
        blockId: proposal.blockId,
        before: proposal.before,
        after: proposal.after,
        instruction: proposal.instruction,
        action: proposal.action,
        rationale: proposal.rationale,
        at: history.length,
      },
    ]);
    setProposal(null);
  };

  const undo = () => {
    if (!history.length || !doc) return;
    const last = history[history.length - 1];
    setDoc({
      ...doc,
      blocks: doc.blocks.map((b) => (b.id === last.blockId ? { ...b, text: last.before } : b)),
    });
    setHistory((h) => h.slice(0, -1));
    setProposal(null);
    setSelectedId(last.blockId);
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

  return (
    <div className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <Header
        docName={doc?.fileName}
        canUndo={history.length > 0}
        editCount={history.length}
        onUndo={undo}
        onExport={exportDoc}
        onUpload={onUpload}
      />

      {!doc && !parsing && <Landing onSample={loadSample} onUpload={onUpload} error={error} />}

      {parsing && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-neutral-500">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-sky-600" />
          <p className="text-sm">
            Recovering document structure
            {parsing.total ? ` — page ${parsing.page}/${parsing.total}` : "…"}
          </p>
        </div>
      )}

      {doc && fileBuf && (
        <div className="grid flex-1 grid-cols-[1fr_1.05fr_380px] overflow-hidden divide-x divide-neutral-200">
          <PdfPane fileBuf={fileBuf} />
          <DocPane
            doc={doc}
            selectedId={selectedId}
            editedIds={editedIds}
            onSelect={(id) => {
              setSelectedId(id);
              setProposal(null);
            }}
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
  return (
    <div className="h-full overflow-auto bg-white px-8 py-6">
      <div className="mx-auto max-w-2xl">
        <div className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Editable document
        </div>
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
  onUndo,
  onExport,
  onUpload,
}: {
  docName?: string;
  canUndo: boolean;
  editCount: number;
  onUndo: () => void;
  onExport: () => void;
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
            onClick={onUndo}
            disabled={!canUndo}
            className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-40"
          >
            ↶ Undo
          </button>
          <button
            onClick={onExport}
            className="rounded-md border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Export
          </button>
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
          your past work — then review every change before it lands.
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
