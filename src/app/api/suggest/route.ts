import { NextRequest, NextResponse } from "next/server";
import { suggestActions } from "@/lib/anthropic";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!process.env.BUOYANT_PROXY_TOKEN) {
    return NextResponse.json({ suggestions: [] });
  }
  let body: { blockText?: string; heading?: string; docMeta?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.blockText?.trim()) {
    return NextResponse.json({ suggestions: [] });
  }
  try {
    const suggestions = await suggestActions({
      blockText: body.blockText,
      heading: body.heading,
      docMeta: body.docMeta,
    });
    return NextResponse.json({ suggestions });
  } catch (err) {
    // Suggestions are a nicety; never surface a hard error, just fall back to
    // the fixed presets on the client.
    console.error("[/api/suggest]", err instanceof Error ? err.message : err);
    return NextResponse.json({ suggestions: [] });
  }
}
