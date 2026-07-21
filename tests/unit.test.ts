import { describe, it, expect } from "vitest";
import { wordDiff, retainedFraction } from "@/lib/diffWords";
import { retrieveKb } from "@/lib/kb";
import { isCapsHeading, classify, detectColumns, type RawItem } from "@/lib/pdf";

describe("wordDiff / retainedFraction", () => {
  it("marks only the changed words", () => {
    const parts = wordDiff("City of Dixon, MO", "City of Rolla, MO");
    expect(parts.some((p) => p.removed && p.value.includes("Dixon"))).toBe(true);
    expect(parts.some((p) => p.added && p.value.includes("Rolla"))).toBe(true);
    expect(parts.some((p) => !p.added && !p.removed && p.value.includes("City"))).toBe(true);
  });

  it("retains ~everything for a one-word swap and nothing for a full rewrite", () => {
    expect(retainedFraction("the quick brown fox", "the quick brown fox")).toBe(1);
    expect(retainedFraction("alpha beta", "totally different words")).toBeLessThan(0.2);
    expect(retainedFraction("the City of Dixon MO", "the City of Rolla MO")).toBeGreaterThan(0.7);
  });
});

describe("retrieveKb", () => {
  it("finds a relevant chunk from the bundled corpus", () => {
    const hits = retrieveKb("bridge replacement over a river");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.text).join(" ").toLowerCase()).toContain("bridge");
  });

  it("includes session-uploaded reference text and can rank it first", () => {
    const extra = [
      {
        name: "solar.pdf",
        text: "MECO completed the Fulton Solar Microgrid, a 2.5 MW community solar array with battery storage.",
      },
    ];
    const hits = retrieveKb("solar microgrid battery storage array", 4, extra);
    expect(hits[0].text.toLowerCase()).toContain("solar microgrid");
  });

  it("returns nothing for an empty query", () => {
    expect(retrieveKb("")).toEqual([]);
  });
});

describe("heading heuristics", () => {
  it("recognizes short all-caps section headings", () => {
    expect(isCapsHeading("OUR FIRM")).toBe(true);
    expect(isCapsHeading("RELEVANT EXPERIENCE")).toBe(true);
    expect(isCapsHeading("AREA OF EXPERTISE/DESIGN")).toBe(true);
  });
  it("rejects ordinary sentences", () => {
    expect(isCapsHeading("MECO Engineering is pleased to present its qualifications.")).toBe(false);
    expect(isCapsHeading("City of Dixon, MO")).toBe(false);
  });
  it("classify separates headings from body by size and length", () => {
    expect(classify("OUR FIRM", 10, 10)).toBe("heading");
    expect(classify("Section Title", 16, 10)).toBe("heading");
    expect(
      classify("This is a normal body paragraph that runs on for a while.", 10, 10),
    ).toBe("paragraph");
  });
});

// Build synthetic text items for N columns of `rows` lines each.
function makeItems(columns: { x: number; w: number }[], rows: number): RawItem[] {
  const items: RawItem[] = [];
  for (const col of columns) {
    for (let r = 0; r < rows; r++) {
      items.push({ str: "word", x: col.x, y: 60 + r * 14, w: col.w, h: 10, fontSize: 10 });
    }
  }
  return items;
}

describe("detectColumns", () => {
  it("returns null for a single-column page (identical old path)", () => {
    const items = makeItems([{ x: 72, w: 400 }], 40);
    expect(detectColumns(items)).toBeNull();
  });

  it("detects two columns separated by a wide gutter", () => {
    // left column ~72..250, a ~40pt empty gutter, right column ~300..520
    const items = makeItems([{ x: 72, w: 170 }, { x: 300, w: 220 }], 40);
    const cols = detectColumns(items);
    expect(cols).not.toBeNull();
    expect(cols!.length).toBe(2);
    expect(cols![0].lo).toBeLessThan(cols![1].lo);
  });

  it("does not split when the 'gap' is only word spacing", () => {
    const items = makeItems([{ x: 72, w: 120 }, { x: 200, w: 120 }], 40);
    // 8pt gap between 192 and 200 is not a real gutter
    expect(detectColumns(items)).toBeNull();
  });
});
