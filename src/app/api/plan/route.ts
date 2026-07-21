import { NextRequest, NextResponse } from "next/server";
import { planEdits } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 45;

export async function POST(req: NextRequest) {
  if (!process.env.BUOYANT_PROXY_TOKEN) {
    return NextResponse.json({ error: "Server missing BUOYANT_PROXY_TOKEN." }, { status: 500 });
  }
  let body: {
    instruction?: string;
    blocks?: { id: string; heading?: string; text: string }[];
    docMeta?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.instruction?.trim() || !body.blocks?.length) {
    return NextResponse.json({ error: "instruction and blocks are required." }, { status: 400 });
  }
  try {
    const plan = await planEdits(body.instruction, body.blocks, body.docMeta);
    return NextResponse.json(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Planning failed.";
    console.error("[/api/plan]", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
