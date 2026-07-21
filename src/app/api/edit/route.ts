import { NextRequest, NextResponse } from "next/server";
import { proposeEdit, type EditContext } from "@/lib/anthropic";
import { retrieveKb } from "@/lib/kb";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body extends Omit<EditContext, "kbSnippets"> {
  useKb?: boolean;
  model?: string;
  sessionKb?: { name: string; text: string }[];
}

export async function POST(req: NextRequest) {
  if (!process.env.BUOYANT_PROXY_TOKEN) {
    return NextResponse.json(
      { error: "Server missing BUOYANT_PROXY_TOKEN." },
      { status: 500 },
    );
  }
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  if (!body.blockText?.trim() || !body.instruction?.trim()) {
    return NextResponse.json(
      { error: "blockText and instruction are required." },
      { status: 400 },
    );
  }

  const kbSnippets = body.useKb
    ? retrieveKb(
        `${body.instruction} ${body.heading ?? ""} ${body.blockText}`,
        4,
        body.sessionKb ?? [],
      ).map((c) => ({ project: c.project, text: c.text }))
    : undefined;

  try {
    const result = await proposeEdit(
      { ...body, kbSnippets },
      body.model || undefined,
    );
    return NextResponse.json({ ...result, kbUsed: kbSnippets?.length ?? 0 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Edit failed.";
    console.error("[/api/edit]", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
