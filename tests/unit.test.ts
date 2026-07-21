import { describe, it, expect } from "vitest";
import { wordDiff, retainedFraction } from "@/lib/diffWords";
import { retrieveKb } from "@/lib/kb";
import { isCapsHeading, classify, detectColumns, dedupeItems, type RawItem } from "@/lib/pdf";
import { unverifiedAdditions } from "@/lib/verify";
import { literalReplaceAll, countMatches } from "@/lib/replace";

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

describe("literalReplaceAll / countMatches", () => {
  it("inserts a replacement containing $ verbatim (no special patterns)", () => {
    expect(literalReplaceAll("cost is TBD here", "TBD", "$5,000", false)).toBe("cost is $5,000 here");
    // $& would otherwise duplicate the match; ensure it does not
    expect(literalReplaceAll("A TBD B", "TBD", "$&x", false)).toBe("A $&x B");
  });
  it("is case-insensitive when asked, and counts matches", () => {
    expect(literalReplaceAll("Dixon and DIXON", "dixon", "Rolla", true)).toBe("Rolla and Rolla");
    expect(countMatches("Dixon and DIXON and dixon", "dixon", true)).toBe(3);
    expect(countMatches("Dixon and DIXON", "Dixon", false)).toBe(1);
  });
  it("treats the search term literally (regex chars escaped)", () => {
    expect(countMatches("a.b a.b axb", "a.b", false)).toBe(2);
  });
});

describe("unverifiedAdditions (verifier)", () => {
  it("flags a fabricated number and project name not in the source", () => {
    const before = "MECO provides civil engineering services to municipalities.";
    const after =
      "MECO provides civil engineering services to municipalities, including the $12 million Fulton Water Plant.";
    const flags = unverifiedAdditions(before, after, []);
    expect(flags.some((f) => f.kind === "number" && f.value === "12")).toBe(true);
    expect(flags.some((f) => f.kind === "name" && /Fulton Water Plant/.test(f.value))).toBe(true);
  });

  it("does not flag facts that appear in the KB snippets", () => {
    const before = "MECO has strong bridge experience.";
    const after = "MECO has strong bridge experience, such as the County Road 372 Bridge.";
    const kb = ["Lewis County: County Road 372 Bridge over Little Fabius River."];
    expect(unverifiedAdditions(before, after, kb)).toHaveLength(0);
  });

  it("flags nothing for a pure tightening that keeps the same facts", () => {
    const before = "MECO Engineering is celebrating its 40th anniversary this year.";
    const after = "MECO Engineering celebrates its 40th anniversary this year.";
    expect(unverifiedAdditions(before, after, [])).toHaveLength(0);
  });
});

describe("dedupeItems", () => {
  const item = (str: string, x: number, y: number, fontSize = 12): RawItem => ({
    str, x, y, w: str.length * fontSize * 0.5, h: fontSize, fontSize,
  });
  it("collapses layered drop-shadow copies at nearly the same spot", () => {
    const items = [
      item("Thank You", 100, 200, 40),
      item("Thank You", 101.5, 201, 40), // shadow copy, ~1.5pt offset
      item("Thank You", 99, 199, 40), // outline copy
    ];
    const out = dedupeItems(items);
    expect(out).toHaveLength(1);
  });
  it("keeps genuinely repeated words that are far apart", () => {
    const items = [item("MO", 100, 200), item("MO", 300, 200), item("MO", 100, 260)];
    expect(dedupeItems(items)).toHaveLength(3);
  });
});

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
