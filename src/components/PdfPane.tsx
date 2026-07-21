"use client";

import { useEffect, useState } from "react";

// Reference pane: the ORIGINAL pdf shown via the browser's native viewer.
//
// Design decision: we deliberately do NOT re-rasterize the PDF ourselves
// (pdfjs canvas). The native viewer gives perfect fidelity for free and is
// rock-solid across browsers; re-rendering bought us nothing but risk. All
// *interaction* (paragraph selection, edit highlighting) lives in the
// reconstructed document pane, which is the editable source of truth.
export default function PdfPane({ fileBuf }: { fileBuf: ArrayBuffer }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const blob = new Blob([fileBuf], { type: "application/pdf" });
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [fileBuf]);

  return (
    <div className="flex h-full flex-col bg-neutral-100">
      <div className="border-b border-neutral-200 bg-white px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        Original PDF
      </div>
      {url && (
        <iframe
          title="Original proposal PDF"
          src={`${url}#toolbar=1&view=FitH`}
          className="min-h-0 flex-1"
        />
      )}
    </div>
  );
}
