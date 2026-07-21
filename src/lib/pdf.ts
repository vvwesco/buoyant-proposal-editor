"use client";

// Client-side PDF structure recovery.
//
// PDFs expose glyphs at (x,y), not paragraphs. We rebuild structure with a
// deterministic, geometry-first pipeline (no LLM - fast, free, cacheable):
//   text items  ->  columns (detect vertical gutters)  ->  lines (cluster by y
//   within a column)  ->  paragraphs (split on vertical gaps / font changes)  ->
//   classify headings (font size and length).
// This is intentionally the cheap path; the LLM budget is spent on EDITS, not
// parsing. Works cleanly on the single-column easy fixture; recovers columns on
// complex multi-column layouts (see README "failure modes").
//
// Multi-column note: many SOQ resume/bio pages put a narrow sidebar list (office
// location, area of expertise, education, registrations) beside a wide body
// column. Sorting purely by y interleaves the two, so a sidebar heading like
// "AREA OF EXPERTISE/DESIGN" absorbs body text from the other column. Before line
// clustering we detect the vertical gutter(s) that separate columns, bucket items
// per column, run the existing line->paragraph pipeline independently per column,
// and emit blocks column-major (page, then column left-to-right, then y top down).
// If only one column is detected the behavior is byte-for-byte identical to the
// old single-pass code.

import type { ParsedDoc, Block, BlockType } from "./types";

// pdfjs is ESM and browser-only; import lazily so it never hits the server bundle.
async function getPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  // Worker is synced to /public by scripts/copy-pdf-worker.mjs (postinstall),
  // so it always matches the installed pdfjs-dist version.
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  return pdfjs;
}

export interface RawItem {
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

    // Collapse layered/drop-shadow duplicates before anything else. InDesign
    // cover pages render the same display text 2-3 times at nearly the same
    // position (fill + shadow/outline), which otherwise reads as
    // "Thank You Thank You Thank You".
    const clean = dedupeItems(items);

    // --- detect columns, then run the line->paragraph pipeline per column ---
    // Column-major ordering: process detected columns strictly left-to-right so
    // the blocks array ends up ordered (page, column, y). Single-column pages fall
    // through the else-branch and behave exactly like the original single pass.
    const columns = detectColumns(clean);
    if (columns && columns.length > 1) {
      const buckets = assignToColumns(clean, columns);
      for (let c = 0; c < buckets.length; c++) {
        processColumn(buckets[c], p, blocks);
      }
    } else {
      processColumn(clean, p, blocks);
    }

    onProgress?.(p, doc.numPages);
  }

  return { fileName, numPages: doc.numPages, blocks, pageSizes };
}

// Run the deterministic line-clustering + paragraph-grouping pipeline over one
// set of items (a single column, or the whole page when no columns are found)
// and append the resulting blocks. This is the exact logic the original parser
// ran once over every page item, so a single-column page produces identical
// output. Blocks are appended in top-to-bottom (y) order.
function processColumn(items: RawItem[], p: number, blocks: Block[]): void {
  if (!items.length) return;

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
      // l.y is the baseline (distance from page top); the glyphs rise above it by
      // roughly the font height. Use the glyph top as the box top so the overlay
      // hit-box sits ON the text, not shifted a line below it.
      const y0 = Math.min(...cur.map((l) => l.y - l.h));
      const y1 = Math.max(...cur.map((l) => l.y));
      const type = classify(text, fontSize, bodyFont);
      blocks.push({
        id: uid("b"),
        type,
        text,
        original: text,
        page: p,
        bbox: { page: p, x, y: y0, w: right - x, h: y1 - y0 },
        fontSize,
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
      // Many SOQ section headings ("OUR FIRM", "RELEVANT EXPERIENCE") are set
      // in the body font, so gap/font tests miss them. Split whenever a line
      // crosses the all-caps-heading boundary, so a heading never absorbs the
      // paragraph beneath it.
      const headingTransition = isCapsHeading(prev.text) !== isCapsHeading(ln.text);
      if (bigGap || fontJump || isHeadingLine || headingTransition) flush();
    }
    cur.push(ln);
  }
  flush();
}

// InDesign display type is often layered (a fill plus one or two shadow/outline
// copies) drawn at nearly the same position, so raw extraction repeats it and a
// title reads as "Thank You Thank You Thank You". Drop an item when an identical
// string already sits within a small, font-scaled distance. A coarse spatial
// hash keeps this O(n); genuine repeated words sit far more than one word apart,
// so they are never collapsed.
export function dedupeItems(items: RawItem[]): RawItem[] {
  const CELL = 8;
  const buckets = new Map<string, RawItem[]>();
  const kept: RawItem[] = [];
  for (const it of items) {
    const s = it.str.trim();
    const cx = Math.floor(it.x / CELL);
    const cy = Math.floor(it.y / CELL);
    const tol = Math.max(3, it.fontSize * 0.35);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++) {
      for (let dy = -1; dy <= 1 && !dup; dy++) {
        const b = buckets.get(`${cx + dx},${cy + dy}`);
        if (!b) continue;
        for (const k of b) {
          if (k.str.trim() === s && Math.abs(k.x - it.x) <= tol && Math.abs(k.y - it.y) <= tol) {
            dup = true;
            break;
          }
        }
      }
    }
    if (dup) continue;
    kept.push(it);
    const key = `${cx},${cy}`;
    const arr = buckets.get(key);
    if (arr) arr.push(it);
    else buckets.set(key, [it]);
  }
  return kept;
}

// A detected column band, in top-left page coordinates. lo/hi are the x extent
// of the text actually assigned to the column (not the raw bin edges).
interface Column {
  lo: number;
  hi: number;
}

// --- column detection via a vertical projection profile ---
//
// Idea (a one-level XY-cut): lay a coarse occupancy grid over the page, measure
// how many vertical rows each thin x-slice occupies, and look for wide x-bands
// that are essentially empty across the whole content height. Those are gutters.
// The populated bands between/around them are candidate columns. We only accept
// a split when at least two candidate columns each carry real content that spans
// most of the page height - so a centered heading with side margins, or a ragged
// right margin, never fakes a column.
//
// Returns the columns left-to-right, or null when the page is single-column (the
// caller then takes the original single-pass path, guaranteeing identical output).
export function detectColumns(items: RawItem[]): Column[] | null {
  // Too little text to reason about columns reliably.
  if (items.length < 12) return null;

  const mFont = medianFont(items) || 10;

  // Horizontal text extent of the page. We only hunt for gutters BETWEEN text,
  // never in the page margins (which are trivially empty on both outer sides).
  let minX = Infinity;
  let maxX = -Infinity;
  let contentTop = Infinity;
  let contentBottom = -Infinity;
  for (const it of items) {
    if (it.x < minX) minX = it.x;
    if (it.x + it.w > maxX) maxX = it.x + it.w;
    const top = it.y - it.h; // glyph rises from the baseline-ish y by ~one line
    if (top < contentTop) contentTop = top;
    if (it.y > contentBottom) contentBottom = it.y;
  }
  const spanX = maxX - minX;
  const contentHeight = contentBottom - contentTop;
  // Not enough horizontal room for two real columns plus a gutter.
  if (spanX < 120 || contentHeight <= 0) return null;

  // Grid resolution. xbin fine enough to locate a ~1-space gutter; ybin about a
  // line tall so each text line marks roughly one row.
  const xbin = Math.max(2, mFont * 0.35);
  const ybin = Math.max(4, mFont * 0.9);
  const nx = Math.max(1, Math.ceil(spanX / xbin));
  const ny = Math.max(1, Math.ceil(contentHeight / ybin));

  // occ[xb] = number of distinct y-rows that have any ink in this x-slice.
  // Using a per-slice Set of rows measures vertical coverage, which is what
  // "spans most of the page height" really means (immune to glyph item counts).
  const rowsByX: Array<Set<number>> = Array.from({ length: nx }, () => new Set<number>());
  for (const it of items) {
    const xa = Math.max(0, Math.floor((it.x - minX) / xbin));
    const xbEnd = Math.min(nx - 1, Math.floor((it.x + it.w - minX - 1e-6) / xbin));
    const yTopBin = Math.max(0, Math.floor((it.y - it.h - contentTop) / ybin));
    const yBotBin = Math.min(ny - 1, Math.floor((it.y - contentTop) / ybin));
    for (let xb = xa; xb <= xbEnd; xb++) {
      const rows = rowsByX[xb];
      for (let yb = yTopBin; yb <= yBotBin; yb++) rows.add(yb);
    }
  }
  const occ = rowsByX.map((s) => s.size);
  const maxOcc = Math.max(...occ);
  if (maxOcc <= 0) return null;

  // An x-slice counts as "gutter" when few rows touch it relative to the densest
  // column. This is a fraction rather than near-zero because two ragged text
  // columns (e.g. project lists with varying line lengths) leave a low VALLEY
  // between them, not an empty band. Interior low runs (we ignore the margins)
  // reliably mark a real gutter, and the per-column density scoring below rejects
  // a false split, so a generous threshold is safe.
  const emptyMax = Math.max(2, Math.floor(maxOcc * 0.25));
  const isEmpty = occ.map((v) => v <= emptyMax);

  // A gutter must be at least this wide to be believed (about 1.2 line-heights).
  // On the SOQ bio pages the real gutter is ~30pt; interior word-spacing rivers
  // are both narrower and not empty across the full height, so they do not match.
  const minGutterBins = Math.max(1, Math.ceil((mFont * 1.2) / xbin));

  // Collect interior empty runs wide enough to be gutters. We ignore empty runs
  // touching bin 0 or bin nx-1 (those are just the outer text margins).
  const gutters: Array<{ start: number; end: number }> = [];
  let run = -1;
  for (let xb = 0; xb < nx; xb++) {
    if (isEmpty[xb]) {
      if (run < 0) run = xb;
    } else if (run >= 0) {
      registerGutter(run, xb - 1);
      run = -1;
    }
  }
  if (run >= 0) registerGutter(run, nx - 1);
  function registerGutter(start: number, end: number) {
    if (start === 0 || end === nx - 1) return; // outer margin, not a gutter
    if (end - start + 1 >= minGutterBins) gutters.push({ start, end });
  }
  if (!gutters.length) return null;

  // Cut the content x-range at each gutter into candidate column segments.
  const cuts: Array<[number, number]> = []; // [startBin, endBin] inclusive, non-empty spans
  let segStart = 0;
  for (const g of gutters) {
    if (g.start - 1 >= segStart) cuts.push([segStart, g.start - 1]);
    segStart = g.end + 1;
  }
  if (segStart <= nx - 1) cuts.push([segStart, nx - 1]);

  // Score each candidate segment by the real items that fall inside it, and keep
  // only segments that carry meaningful content spanning most of the page height.
  const minItems = Math.max(3, Math.floor(items.length * 0.05));
  const minSpan = contentHeight * 0.45;
  const kept: Column[] = [];
  for (const [sb, eb] of cuts) {
    // Column bounds are the GUTTER-based cut edges, not the item extents. A
    // full-width line (a title or intro sentence) whose center sits in this cut
    // but which stretches across the gutter would otherwise inflate the bound and
    // make columns overlap, so the wrong column swallows the other's items.
    const loEdge = minX + sb * xbin;
    const hiEdge = minX + (eb + 1) * xbin;
    let cnt = 0;
    let top = Infinity;
    let bot = -Infinity;
    for (const it of items) {
      const cx = it.x + it.w / 2;
      if (cx < loEdge || cx >= hiEdge) continue;
      cnt++;
      if (it.y - it.h < top) top = it.y - it.h;
      if (it.y > bot) bot = it.y;
    }
    if (cnt >= minItems && bot - top >= minSpan) kept.push({ lo: loEdge, hi: hiEdge });
  }

  // Need at least two genuine columns for a split to be worthwhile; otherwise the
  // page is effectively single-column and must go down the identical path.
  if (kept.length < 2) return null;
  kept.sort((a, b) => a.lo - b.lo);
  return kept;
}

// Assign every item to exactly one detected column, so no glyph is dropped. An
// item goes to the column its center-x lands in; a straggler that falls inside a
// gutter (e.g. a full-width heading, or punctuation nudged past the edge) is
// attached to the nearest column by center distance.
function assignToColumns(items: RawItem[], columns: Column[]): RawItem[][] {
  const buckets: RawItem[][] = columns.map(() => []);
  for (const it of items) {
    const cx = it.x + it.w / 2;
    let idx = -1;
    for (let c = 0; c < columns.length; c++) {
      if (cx >= columns[c].lo && cx <= columns[c].hi) {
        idx = c;
        break;
      }
    }
    if (idx < 0) {
      // Nearest column by distance from its band.
      let best = Infinity;
      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        const d = cx < col.lo ? col.lo - cx : cx - col.hi;
        if (d < best) {
          best = d;
          idx = c;
        }
      }
    }
    buckets[idx].push(it);
  }
  return buckets;
}

// Some SOQ cover pages render display type with letter-spacing ("S t a t e m e n t").
// Collapse runs of single chars separated by spaces so headings read normally.
function joinLine(items: RawItem[]): string {
  let s = items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  s = s.replace(/(?:\b\w\s){3,}\w\b/g, (m) => m.replace(/\s+/g, ""));
  return s;
}

// A short, mostly-uppercase line - the shape of an SOQ section heading.
export function isCapsHeading(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (words.length > 7) return false;
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return false;
  const upper = (text.match(/[A-Z]/g) ?? []).length;
  return upper / letters.length > 0.8;
}

export function classify(text: string, fontSize: number, bodyFont: number): BlockType {
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

// Load the document once for rendering. Callers hold the proxy and render pages
// sequentially from it (see PdfPane). getDocument detaches the passed buffer, so
// hand it a copy and keep the master intact.
export async function loadDocument(data: ArrayBuffer) {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({ data: data.slice(0) }).promise;
}
