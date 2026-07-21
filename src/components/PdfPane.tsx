"use client";

import { useEffect, useRef, useState } from "react";
import type { ParsedDoc } from "@/lib/types";
import { renderPage } from "@/lib/pdf";

const SCALE = 1.4;

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
  const [rendered, setRendered] = useState(0);

  return (
    <div className="h-full overflow-auto bg-neutral-200/60 px-4 py-4">
      {doc.pageSizes.map((ps) => (
        <PageCanvas
          key={ps.page}
          fileBuf={fileBuf}
          pageNum={ps.page}
          blocks={doc.blocks.filter((b) => b.page === ps.page)}
          selectedId={selectedId}
          editedIds={editedIds}
          onSelect={onSelect}
          onRendered={() => setRendered((n) => n + 1)}
        />
      ))}
      <p className="py-2 text-center text-xs text-neutral-400">
        {rendered}/{doc.numPages} pages rendered
      </p>
    </div>
  );
}

function PageCanvas({
  fileBuf,
  pageNum,
  blocks,
  selectedId,
  editedIds,
  onSelect,
  onRendered,
}: {
  fileBuf: ArrayBuffer;
  pageNum: number;
  blocks: ParsedDoc["blocks"];
  selectedId: string | null;
  editedIds: Set<string>;
  onSelect: (id: string) => void;
  onRendered: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!canvasRef.current) return;
      try {
        const { width, height } = await renderPage(
          fileBuf,
          pageNum,
          canvasRef.current,
          SCALE,
        );
        if (!cancelled) {
          setSize({ w: width, h: height });
          onRendered();
        }
      } catch {
        /* page render failure is non-fatal; overlay still works */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileBuf, pageNum]);

  return (
    <div
      className="relative mx-auto mb-4 w-fit rounded-sm bg-white shadow-md ring-1 ring-black/5"
      style={size ? { width: size.w, height: size.h } : undefined}
    >
      <canvas ref={canvasRef} className="block" />
      {size &&
        blocks.map((b) => {
          const sel = b.id === selectedId;
          const edited = editedIds.has(b.id);
          return (
            <button
              key={b.id}
              onClick={() => onSelect(b.id)}
              title={b.type}
              className={[
                "absolute cursor-pointer rounded-[2px] transition-colors",
                sel
                  ? "bg-sky-400/25 ring-2 ring-sky-500"
                  : edited
                    ? "bg-emerald-300/20 ring-1 ring-emerald-500/60 hover:bg-emerald-300/30"
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
  );
}
