import { NextRequest, NextResponse } from "next/server";
import { draftFix } from "@/lib/compliance";
import { retrieveKb } from "@/lib/kb";
import { unverifiedAdditions } from "@/lib/verify";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  if (!process.env.BUOYANT_PROXY_TOKEN) {
    return NextResponse.json({ error: "Server missing BUOYANT_PROXY_TOKEN." }, { status: 500 });
  }
  let body: {
    requirement?: string;
    category?: string;
    proposalText?: string;
    sessionKb?: { name: string; text: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.requirement?.trim()) {
    return NextResponse.json({ error: "requirement is required." }, { status: 400 });
  }
  try {
    const kbSnippets = retrieveKb(
      `${body.requirement} ${body.category ?? ""}`,
      5,
      body.sessionKb ?? [],
    ).map((c) => ({ project: c.project, text: c.text }));
    const draft = await draftFix(
      body.requirement,
      body.category ?? "",
      body.proposalText ?? "",
      kbSnippets,
    );
    // For a fresh paragraph, "unverified" = any number/name not grounded in the KB.
    const warnings = draft.text
      ? unverifiedAdditions("", draft.text, kbSnippets.map((s) => s.text))
      : [];
    return NextResponse.json({ ...draft, warnings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Draft failed.";
    console.error("[/api/draft-fix]", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
