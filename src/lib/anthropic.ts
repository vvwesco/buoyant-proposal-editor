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

// A structured tool field typed as an array can occasionally come back from the
// model as null, an object, or a single item. Coerce to an array before calling
// array methods, so a stray shape never throws ".filter is not a function".
export function asArray<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

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
    usedFacts: asArray<string>(input.usedFacts),
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
  const raw = asArray<Suggestion>((tool?.input as { suggestions?: Suggestion[] })?.suggestions);
  return raw
    .filter((s) => s.label?.trim() && s.instruction?.trim())
    .slice(0, 3)
    .map((s) => ({ label: s.label.trim(), instruction: s.instruction.trim() }));
}

// Multi-paragraph planning: turn one high-level request into a concrete set of
// per-paragraph edits. Each planned edit is then executed through the normal
// per-paragraph edit path (so it gets the same diff + verifier), and the user
// reviews the batch.
export interface PlanEdit {
  blockId: string;
  instruction: string;
}
export interface Plan {
  message: string;
  edits: PlanEdit[];
}

const PLAN_SYSTEM = `You turn a proposal writer's high-level request into a concrete set of per-paragraph edits across a civil-engineering Statement of Qualifications. You are given the request and a numbered list of the document's paragraphs, each with an id, its section heading, and its text. Decide which paragraphs actually need to change to satisfy the request, and for each write a single specific instruction an editor will apply to THAT paragraph only. Rules:
- Only include paragraphs that genuinely need changing. Do not touch paragraphs the request does not affect.
- Each per-paragraph instruction must be self-contained and faithful to the request; keep the change minimal.
- Never invent facts (names, numbers, licenses, projects).
- Also write one short sentence summarizing what you are about to change across the document.`;

export async function planEdits(
  instruction: string,
  blocks: { id: string; heading?: string; text: string }[],
  docMeta?: string,
  model: string = DEFAULT_MODEL,
): Promise<Plan> {
  const list = blocks
    .map((b) => `[${b.id}]${b.heading ? ` (${b.heading})` : ""} ${b.text.slice(0, 260)}`)
    .join("\n");
  const resp = await client.messages.create({
    model,
    max_tokens: 2000,
    system: PLAN_SYSTEM,
    tools: [
      {
        name: "plan_edits",
        description: "Return the per-paragraph edit plan.",
        input_schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "One-sentence summary of the plan." },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  blockId: { type: "string", description: "The id of the paragraph to edit." },
                  instruction: {
                    type: "string",
                    description: "Specific instruction for that paragraph.",
                  },
                },
                required: ["blockId", "instruction"],
              },
            },
          },
          required: ["message", "edits"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "plan_edits" },
    messages: [
      {
        role: "user",
        content: `Document: ${docMeta ?? "civil-engineering proposal"}
Request: ${instruction}

Paragraphs:
${list}

Call plan_edits with the paragraphs to change and a specific instruction for each.`,
      },
    ],
  });
  const tool = resp.content.find((b) => b.type === "tool_use") as
    | Anthropic.ToolUseBlock
    | undefined;
  const input = tool?.input as { message?: string; edits?: PlanEdit[] } | undefined;
  const valid = new Set(blocks.map((b) => b.id));
  const edits = asArray<PlanEdit>(input?.edits)
    .filter((e) => e.blockId && valid.has(e.blockId) && e.instruction?.trim())
    .map((e) => ({ blockId: e.blockId, instruction: e.instruction.trim() }));
  return { message: input?.message?.trim() || "Proposed changes:", edits };
}

// OCR cleanup: fix spacing/hyphenation artifacts from PDF extraction ("Proj ect"
// -> "Project") with the cheap fast model, in parallel batches. The caller
// applies a result only if it is a spacing-only change (isSpacingOnlyChange), so
// the model can never alter content - it can only re-space it.
const CLEANUP_SYSTEM = `You fix OCR extraction artifacts in text pulled from a PDF. For each paragraph, return the same text with ONLY spacing and hyphenation artifacts corrected:
- rejoin a single word split by a stray space ("Proj ect" -> "Project", "w ater" -> "water")
- separate two words wrongly glued together ("theproject" -> "the project")
- fix line-break hyphenation ("compre- hensive" -> "comprehensive")
- remove stray spaces before punctuation
Do NOT change, add, or remove any words, numbers, names, or punctuation, and do NOT rephrase or fix grammar. Only adjust spacing and hyphen line-breaks. If a paragraph has no such artifacts, return it exactly unchanged. Return every paragraph by its id.`;

async function cleanupBatch(
  batch: { id: string; text: string }[],
): Promise<{ id: string; text: string }[]> {
  const resp = await client.messages.create({
    model: SUGGEST_MODEL,
    max_tokens: 8000,
    system: CLEANUP_SYSTEM,
    tools: [
      {
        name: "cleanup",
        description: "Return each paragraph by id with spacing artifacts fixed.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  text: { type: "string" },
                },
                required: ["id", "text"],
              },
            },
          },
          required: ["items"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "cleanup" },
    messages: [
      {
        role: "user",
        content:
          "Paragraphs:\n" +
          batch.map((b) => `[${b.id}] ${b.text}`).join("\n\n") +
          "\n\nCall cleanup with each paragraph's corrected text.",
      },
    ],
  });
  const tool = resp.content.find((b) => b.type === "tool_use") as
    | Anthropic.ToolUseBlock
    | undefined;
  return asArray<{ id: string; text: string }>(
    (tool?.input as { items?: { id: string; text: string }[] })?.items,
  );
}

export async function cleanupBlocks(
  blocks: { id: string; text: string }[],
): Promise<{ id: string; text: string }[]> {
  // Batch by cumulative character count, not block count, so a batch of large
  // dense blocks (project lists on bio pages) never overflows the model's output
  // budget and silently drops blocks.
  const CHAR_BUDGET = 4000;
  const batches: { id: string; text: string }[][] = [];
  let cur: { id: string; text: string }[] = [];
  let curLen = 0;
  for (const b of blocks) {
    if (cur.length && curLen + b.text.length > CHAR_BUDGET) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(b);
    curLen += b.text.length;
  }
  if (cur.length) batches.push(cur);
  const results = await Promise.all(
    batches.map((b) => cleanupBatch(b).catch(() => [] as { id: string; text: string }[])),
  );
  return results.flat();
}
