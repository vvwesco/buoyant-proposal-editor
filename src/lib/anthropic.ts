import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Suggestion } from "./types";
export type { Suggestion };

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
    // Generous headroom: a paragraph rewrite is short, but merged multi-column
    // blocks from a complex PDF can be long; we would rather pay tokens than
    // truncate. Truncation is still caught below via stop_reason.
    max_tokens: 4000,
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

  // If the model ran out of output budget, the tool JSON is truncated and
  // newText is silently cut off. Surface that instead of letting the user
  // Apply a paragraph that loses its tail.
  if (resp.stop_reason === "max_tokens") {
    throw new Error(
      "The edit was too long to complete in one response. Try a shorter paragraph or a more specific instruction.",
    );
  }

  const tool = resp.content.find((b) => b.type === "tool_use") as
    | Anthropic.ToolUseBlock
    | undefined;
  if (!tool) throw new Error("Model did not return an edit.");
  const input = tool.input as {
    newText: string;
    rationale?: string;
    usedFacts?: string[];
  };
  const newText = (input.newText ?? "").trim();
  if (!newText) throw new Error("The model returned an empty edit.");
  return {
    newText,
    rationale: input.rationale ?? "",
    usedFacts: input.usedFacts ?? [],
  };
}

// Suggestions are advisory and read constantly, so use the cheapest fast model.
const SUGGEST_MODEL = process.env.SUGGEST_MODEL ?? "claude-haiku-4-5-20251001";

const SUGGEST_SYSTEM = `You suggest 2-3 edit actions a proposal writer might want for ONE specific paragraph of a civil-engineering Statement of Qualifications. Tailor them to the actual content of the paragraph:
- If a sentence is long or rambling, suggest tightening it.
- If a client, city, or place name appears, suggest confirming or changing it.
- If it makes a general claim that a concrete project could support, suggest adding a specific example from past work.
- If the tone is weak or generic, suggest strengthening it for a selection committee.
Each suggestion has a short imperative button label (2-4 words, Title Case) and a one-sentence instruction the editor will follow. Prefer the 2-3 most useful and specific options for THIS text over generic ones. Never invent facts.`;

export async function suggestActions(ctx: {
  blockText: string;
  heading?: string;
  docMeta?: string;
}): Promise<Suggestion[]> {
  const resp = await client.messages.create({
    model: SUGGEST_MODEL,
    max_tokens: 500,
    temperature: 0.4,
    system: SUGGEST_SYSTEM,
    tools: [
      {
        name: "suggest_actions",
        description: "Return 2-3 tailored edit suggestions for the paragraph.",
        input_schema: {
          type: "object",
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  instruction: { type: "string" },
                },
                required: ["label", "instruction"],
              },
            },
          },
          required: ["suggestions"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "suggest_actions" },
    messages: [
      {
        role: "user",
        content: `Document: ${ctx.docMeta ?? "civil-engineering proposal"}
${ctx.heading ? `Section: ${ctx.heading}\n` : ""}Paragraph:
"""
${ctx.blockText}
"""
Suggest 2-3 tailored edit actions.`,
      },
    ],
  });
  const tool = resp.content.find((b) => b.type === "tool_use") as
    | Anthropic.ToolUseBlock
    | undefined;
  const raw = (tool?.input as { suggestions?: Suggestion[] })?.suggestions ?? [];
  return raw
    .filter((s) => s.label?.trim() && s.instruction?.trim())
    .slice(0, 3)
    .map((s) => ({ label: s.label.trim(), instruction: s.instruction.trim() }));
}
