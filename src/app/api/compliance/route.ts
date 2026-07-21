import { NextRequest, NextResponse } from "next/server";
import {
  extractRequirements,
  checkCompliance,
  type Requirement,
  type Assessment,
} from "@/lib/compliance";

export const runtime = "nodejs";
// Extraction plus a few batched check calls can add up; give it headroom.
export const maxDuration = 60;

// One row of the compliance matrix: the requirement and its assessment merged.
type Row = Requirement & Assessment;

export async function POST(req: NextRequest) {
  if (!process.env.BUOYANT_PROXY_TOKEN) {
    return NextResponse.json(
      { error: "Server missing BUOYANT_PROXY_TOKEN." },
      { status: 500 },
    );
  }

  let body: { rfpText?: string; proposalText?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.rfpText?.trim()) {
    return NextResponse.json({ error: "rfpText is required." }, { status: 400 });
  }
  if (!body.proposalText?.trim()) {
    return NextResponse.json({ error: "proposalText is required." }, { status: 400 });
  }

  try {
    const requirements = await extractRequirements(body.rfpText);
    if (!requirements.length) {
      return NextResponse.json({
        requirements: [] as Row[],
        summary: { met: 0, partial: 0, missing: 0, total: 0 },
      });
    }

    const assessments = await checkCompliance(requirements, body.proposalText);

    // Merge requirement + assessment by id. Any requirement without a matching
    // assessment falls back to "missing" so every row is complete.
    const byId = new Map<string, Assessment>(assessments.map((a) => [a.id, a]));
    const rows: Row[] = requirements.map((r) => {
      const a = byId.get(r.id);
      return {
        ...r,
        status: a?.status ?? "missing",
        note: a?.note ?? "This requirement was not assessed.",
        evidence: a?.evidence ?? "",
      };
    });

    const summary = {
      met: rows.filter((r) => r.status === "met").length,
      partial: rows.filter((r) => r.status === "partial").length,
      missing: rows.filter((r) => r.status === "missing").length,
      total: rows.length,
    };

    return NextResponse.json({ requirements: rows, summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Compliance check failed.";
    console.error("[/api/compliance]", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
