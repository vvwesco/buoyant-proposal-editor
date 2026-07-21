"use client";

// Client-side PDF structure recovery.
//
// PDFs expose glyphs at (x,y), not paragraphs. We rebuild structure with a
// deterministic, geometry-first pipeline (no LLM — fast, free, cacheable):
//   text items  ->  lines (cluster by y)  ->  paragraphs (split on vertical
//   gaps / font changes)  ->  classify headings (font size & length).
// This is intentionally the cheap path; the LLM budget is spent on EDITS, not
// parsing. Works cleanly on the single-column easy fixture; degrades gracefully
// on complex layouts (see README "failure modes").

import type { ParsedDoc, Block, BlockType } from "./types";

// pdfjs is ESM and browser-only; import lazily so it never hits the server bundle.
async function getPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  // Worker is copied to /public by the build; see scripts/postinstall.
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return pdfjs;
}

interface RawItem {
  str: string;
  x: number;
  y: number; // normalized: top-left origin (0 = top of page)
  w: number;
  h: number;
  fontSize: number;
}

let _uid = 0;
const uid = (p: string) => `${p}_${_uid++}`;

export async function parsePdf(
  data: ArrayBuffer,
  fileName: string,
  onProgress?: (page: number, total: number) => void,
): Promise<ParsedDoc> {
  const pdfjs = await getPdfjs();
  // getDocument detaches the passed ArrayBuffer; hand it a copy so callers keep
  // the master buffer intact for later rendering.
  const doc = await pdfjs.getDocument({ data: data.slice(0) }).promise;
  const blocks: Block[] = [];
  const pageSizes: ParsedDoc["pageSizes"] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    pageSizes.push({ page: p, width: viewport.width, height: viewport.height });
    const content = await page.getTextContent();

    const items: RawItem[] = [];
    for (const it of content.items as any[]) {
      const str: string = it.str ?? "";
      if (!str.trim()) continue;
      const tr = it.transform as number[]; // [a,b,c,d,e,f]
      const x = tr[4];
      const fontSize = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || 10;
      // Convert PDF (origin bottom-left) to top-left origin.
      const yTop = viewport.height - tr[5];
      items.push({ str, x, y: yTop, w: it.width ?? 0, h: it.height ?? fontSize, fontSize });
    }
    if (!items.length) {
      onProgress?.(p, doc.numPages);
      continue;
    }

    // --- cluster items into lines by y proximity ---
    items.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: RawItem[][] = [];
    const yTol = Math.max(3, medianFont(items) * 0.6);
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0].y - it.y) <= yTol) last.push(it);
      else lines.push([it]);
    }

    // Build line records: joined text, x-range, font, y.
    const lineRecs = lines.map((ln) => {
      ln.sort((a, b) => a.x - b.x);
      const text = joinLine(ln);
      const fontSize = median(ln.map((i) => i.fontSize));
      const x = Math.min(...ln.map((i) => i.x));
      const right = Math.max(...ln.map((i) => i.x + i.w));
      const y = median(ln.map((i) => i.y));
      const h = Math.max(...ln.map((i) => i.h));
      return { text, fontSize, x, right, y, h };
    });

    const bodyFont = medianLineFont(lineRecs);

    // --- group lines into paragraphs ---
    let cur: typeof lineRecs = [];
    const flush = () => {
      if (!cur.length) return;
      const text = cur
        .map((l) => l.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        const fontSize = median(cur.map((l) => l.fontSize));
        const x = Math.min(...cur.map((l) => l.x));
        const right = Math.max(...cur.map((l) => l.right));
        const y0 = Math.min(...cur.map((l) => l.y));
        const y1 = Math.max(...cur.map((l) => l.y + l.h));
        const type = classify(text, fontSize, bodyFont);
        blocks.push({
          id: uid("b"),
          type,
          text,
          original: text,
          page: p,
          bbox: { page: p, x, y: y0, w: right - x, h: y1 - y0 },
          fontSize,
          edited: false,
        });
      }
      cur = [];
    };

    for (let i = 0; i < lineRecs.length; i++) {
      const ln = lineRecs[i];
      const prev = lineRecs[i - 1];
      if (prev) {
        const gap = ln.y - prev.y;
        const bigGap = gap > prev.h * 1.8;
        const fontJump = Math.abs(ln.fontSize - prev.fontSize) > bodyFont * 0.25;
        const isHeadingLine = ln.fontSize > bodyFont * 1.25;
        if (bigGap || fontJump || isHeadingLine) flush();
      }
      cur.push(ln);
    }
    flush();
    onProgress?.(p, doc.numPages);
  }

  return { fileName, numPages: doc.numPages, blocks, pageSizes };
}

// Some SOQ cover pages render display type with letter-spacing ("S t a t e m e n t").
// Collapse runs of single chars separated by spaces so headings read normally.
function joinLine(items: RawItem[]): string {
  let s = items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  s = s.replace(/(?:\b\w\s){3,}\w\b/g, (m) => m.replace(/\s+/g, ""));
  return s;
}

function classify(text: string, fontSize: number, bodyFont: number): BlockType {
  const words = text.split(/\s+/).length;
  if (fontSize >= bodyFont * 1.2 && words <= 12) return "heading";
  if (/^[•\-•▪]/.test(text) || /^[A-Z][a-z]+,\s(MO|IL)\b/.test(text))
    return "list-item";
  if (words <= 6 && text === text.toUpperCase() && /[A-Z]/.test(text)) return "heading";
  return "paragraph";
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
const medianFont = (items: RawItem[]) => median(items.map((i) => i.fontSize));
const medianLineFont = (lns: { fontSize: number }[]) => median(lns.map((l) => l.fontSize));

// Note: we intentionally don't rasterize pages ourselves — the reference pane
// uses the browser's native PDF viewer (see PdfPane). pdfjs here is parse-only.
