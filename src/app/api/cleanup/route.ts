import { NextRequest, NextResponse } from "next/server";
import { cleanupBlocks } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Cleanup is a best-effort nicety; if the token is missing, just no-op so the
  // document still loads.
  if (!process.env.BUOYANT_PROXY_TOKEN) {
    return NextResponse.json({ items: [] });
  }
  let body: { blocks?: { id: string; text: string }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const blocks = (body.blocks ?? []).filter((b) => b?.id && b?.text?.trim());
  if (!blocks.length) return NextResponse.json({ items: [] });
  try {
    const items = await cleanupBlocks(blocks);
    return NextResponse.json({ items });
  } catch (err) {
    console.error("[/api/cleanup]", err instanceof Error ? err.message : err);
    return NextResponse.json({ items: [] });
  }
}
