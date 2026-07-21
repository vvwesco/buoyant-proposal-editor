"use client";

import { useEffect, useRef, useState } from "react";
import type { ParsedDoc } from "@/lib/types";
import { loadDocument } from "@/lib/pdf";

const SCALE = 1.35;

// Reference pane: the original PDF, rendered by us (pdfjs canvas) so we can lay
// transparent, positioned hit-boxes over every recovered block. That gives the
// two things the native viewer can't: clicking a paragraph in the editable
// document highlights and scrolls to the same paragraph on the page, and
// clicking on the page selects it. Edited paragraphs are tinted so you can see
// at a glance what changed and where.
export default function PdfPane({
  fileBuf,
  doc,
  selectedId,
  editedIds,
  onSelect,
}: {
  fileBuf: ArrayBuffer;
  doc: ParsedDoc;
  selectedId: string | null;
  editedIds: Set<string>;
  onSelect: (id: string) => void;
}) {
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const [rendered, setRendered] = useState(0);

  // Load once, render pages sequentially. Sequential + a per-page timeout keeps
  // one slow/stuck page from blocking the rest; if a page can't paint, its
  // overlay boxes still work over a blank page.
  useEffect(() => {
    let cancelled = false;
    setRendered(0);
    (async () => {
      let pdf: Awaited<ReturnType<typeof loadDocument>>;
      try {
        pdf = await loadDocument(fileBuf);
      } catch {
        return;
      }
      for (let p = 1; p <= doc.numPages; p++) {
        if (cancelled) return;
        const canvas = canvasRefs.current[p - 1];
        if (!canvas) continue;
        try {
          const page = await pdf.getPage(p);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: SCALE });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          const task = page.render({ canvasContext: ctx, viewport });
          await Promise.race([
            task.promise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("render-timeout")), 10000),
            ),
          ]).catch(() => {
            try {
              task.cancel();
            } catch {
              /* ignore */
            }
          });
          if (cancelled) return;
          setRendered((n) => Math.max(n, p));
        } catch {
          /* skip this page, keep going */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileBuf, doc.numPages]);

  // When selection changes (e.g. from the editable document), scroll the
  // matching box into view on the page.
  useEffect(() => {
    if (!selectedId) return;
    const el = document.getElementById(`pdfbox-${selectedId}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [selectedId]);

  return (
    <div className="relative h-full overflow-auto bg-neutral-200/60 px-4 py-4">
      {doc.pageSizes.map((ps, i) => (
        <div
          key={ps.page}
          className="relative mx-auto mb-4 rounded-sm bg-white shadow-md ring-1 ring-black/5"
          style={{ width: ps.width * SCALE, height: ps.height * SCALE }}
        >
          <canvas
            ref={(el) => {
              canvasRefs.current[i] = el;
            }}
            className="block"
          />
          {doc.blocks
            .filter((b) => b.page === ps.page && b.bbox.w > 0 && b.bbox.h > 0)
            .map((b) => {
              const sel = b.id === selectedId;
              const edited = editedIds.has(b.id);
              return (
                <button
                  key={b.id}
                  id={`pdfbox-${b.id}`}
                  onClick={() => onSelect(b.id)}
                  title={sel ? "Selected" : "Select this paragraph"}
                  className={[
                    "absolute cursor-pointer rounded-[2px] transition-colors",
                    sel
                      ? "bg-sky-400/25 ring-2 ring-sky-500"
                      : edited
                        ? "bg-emerald-300/25 ring-1 ring-emerald-500/60 hover:bg-emerald-300/35"
                        : "ring-1 ring-transparent hover:bg-sky-300/15 hover:ring-sky-300/50",
                  ].join(" ")}
                  style={{
                    left: b.bbox.x * SCALE - 2,
                    top: b.bbox.y * SCALE - 2,
                    width: b.bbox.w * SCALE + 4,
                    height: b.bbox.h * SCALE + 4,
                  }}
                />
              );
            })}
        </div>
      ))}
      <p className="py-1 text-center text-xs text-neutral-400">
        {rendered}/{doc.numPages} pages
      </p>
    </div>
  );
}
