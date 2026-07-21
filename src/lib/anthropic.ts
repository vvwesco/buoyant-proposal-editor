import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// Server-only Anthropic client, pointed at Buoyant's proxy. The token never
// reaches the browser — all edit calls go through /api/edit.
const client = new Anthropic({
  apiKey: process.env.BUOYANT_PROXY_TOKEN ?? "",
  baseURL: (process.env.BUOYANT_PROXY_BASE ?? "https://hiring-proxy.trybuoyant.ai") + "/anthropic",
});

// Default to Sonnet 5: fast, strong, cheap enough to keep the loop snappy.
// Opus is overkill for single-paragraph edits.
export const DEFAULT_MODEL = process.env.EDIT_MODEL ?? "claude-sonnet-5";

export interface EditContext {
  action: string; // preset id or "custom"
  instruction: string; // human instruction
  blockText: string; // the paragraph to edit
  heading?: string; // nearest heading above it
  before?: string; // previous block text
  after?: string; // next block text
  docMeta?: string; // e.g. "Statement of Qualifications for City of Dixon"
  kbSnippets?: { project: string; text: string }[];
}

export interface EditResult {
  newText: string;
  rationale: string;
  usedFacts: string[];
}

const SYSTEM = `You are an editing assistant embedded in a proposal editor used by civil-engineering and consulting firms (think Statements of Qualifications for municipal RFPs). You edit ONE selected paragraph at a time.

Hard rules:
- Return ONLY the revised version of the selected paragraph. Do not add headings, labels, or commentary in the text.
- Make the smallest change that satisfies the instruction. Preserve everything the instruction does not ask you to change — including the firm's voice, terminology, tense, and formatting conventions.
- NEVER invent verifiable facts: no fabricated names, titles, PE license numbers, dollar amounts, dates, project names, or statistics. If the instruction asks you to add specifics you were not given, either use only facts present in the provided context/knowledge base, or write a version that stays truthful and flag what is missing in your rationale. In procurement documents a fabricated fact is disqualifying.
- If knowledge-base excerpts are provided, you may ground additions in them, but only use facts actually stated there. List the specific facts you used in "usedFacts".
- Match the surrounding tone. This firm writes in a confident, client-centric, plain-professional voice.`;

export async function proposeEdit(
  ctx: EditContext,
  model: string = DEFAULT_MODEL,
): Promise<EditResult> {
  const kb = ctx.kbSnippets?.length
    ? "\n\nKNOWLEDGE BASE EXCERPTS (past proposals from the same firm — use only facts actually stated here):\n" +
      ctx.kbSnippets
        .map((s, i) => `[${i + 1}] (${s.project}) ${s.text}`)
        .join("\n")
    : "";

  const user = `Document: ${ctx.docMeta ?? "civil-engineering proposal"}
${ctx.heading ? `Section heading: ${ctx.heading}\n` : ""}${
    ctx.before ? `Previous paragraph: ${ctx.before}\n` : ""
  }${ctx.after ? `Next paragraph: ${ctx.after}\n` : ""}
SELECTED PARAGRAPH (edit this):
"""
${ctx.blockText}
"""

INSTRUCTION (${ctx.action}): ${ctx.instruction}${kb}

Call propose_edit with the revised paragraph.`;

  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    system: SYSTEM,
    tools: [
      {
        name: "propose_edit",
        description: "Return the revised paragraph and a one-line rationale.",
        input_schema: {
          type: "object",
          properties: {
            newText: {
              type: "string",
              description: "The full revised paragraph, ready to drop in.",
            },
            rationale: {
              type: "string",
              description:
                "One sentence: what you changed and any fact you could not verify.",
            },
            usedFacts: {
              type: "array",
              items: { type: "string" },
              description: "Specific facts taken from the knowledge base, if any.",
            },
          },
          required: ["newText", "rationale"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "propose_edit" },
    messages: [{ role: "user", content: user }],
  });

  const tool = resp.content.find((b) => b.type === "tool_use") as
    | Anthropic.ToolUseBlock
    | undefined;
  if (!tool) throw new Error("Model did not return an edit.");
  const input = tool.input as {
    newText: string;
    rationale?: string;
    usedFacts?: string[];
  };
  return {
    newText: (input.newText ?? "").trim(),
    rationale: input.rationale ?? "",
    usedFacts: input.usedFacts ?? [],
  };
}
