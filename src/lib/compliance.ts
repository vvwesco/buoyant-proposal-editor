import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// Server-only Anthropic client for the RFP compliance matrix. Same Buoyant proxy
// wiring as anthropic.ts - the token never reaches the browser; all compliance
// calls go through /api/compliance.
const client = new Anthropic({
  apiKey: process.env.BUOYANT_PROXY_TOKEN ?? "",
  baseURL: (process.env.BUOYANT_PROXY_BASE ?? "https://hiring-proxy.trybuoyant.ai") + "/anthropic",
});

// Sonnet 5 by default: this is a judgment task over long-ish text, so the cheap
// haiku tier is too weak, and opus is overkill. Overridable via env.
const DEFAULT_MODEL = process.env.COMPLIANCE_MODEL ?? "claude-sonnet-5";

// Input caps. RFPs and proposals can run to tens of thousands of characters; we
// truncate to keep each call bounded and cost-aware. The extraction prompt only
// needs the requirement-bearing front matter (scope, submittals, evaluation),
// which almost always sits in the first several pages, so a 16k cap is generous.
const RFP_CHAR_CAP = 16000;
// The proposal is the thing we judge against; give it more room, but still cap.
const PROPOSAL_CHAR_CAP = 24000;
// Requirements are checked in batches so no single response has to emit a huge
// JSON array. Small batches keep each judgment focused and output bounded.
const CHECK_BATCH_SIZE = 12;
// Hard ceiling on extracted requirements so a pathological RFP cannot fan out
// into dozens of check calls.
const MAX_REQUIREMENTS = 60;

export interface Requirement {
  id: string;
  text: string; // the concrete, checkable requirement, in one sentence
  category: string; // e.g. "Submission", "Qualifications", "Scope", "Forms"
  mandatory: boolean; // true for "shall/must", false for "should/preferred"
}

export interface Assessment {
  id: string; // matches Requirement.id
  status: "met" | "partial" | "missing";
  note: string; // one short sentence explaining the call
  evidence: string; // short verbatim quote from the proposal, or "" if missing
}

const EXTRACT_SYSTEM = `You read civil-engineering RFPs (Requests for Proposals) for municipal and public-agency work, and pull out the concrete, checkable requirements a responding firm must satisfy. Focus on things a reviewer can verify against a submitted proposal:
- submission criteria (page limits, required sections, format, copies, deadlines)
- required forms, certifications, and attachments (e.g. signed cover letter, non-collusion affidavit, DBE forms, insurance certificates)
- firm and staff qualifications (licenses, years of experience, key-personnel roles, references)
- scope items the proposal must address (specific services, deliverables, tasks)

Rules:
- Extract only requirements that are actually stated or clearly implied by the RFP text. Do not invent boilerplate that is not there.
- One requirement per item, phrased as a single checkable sentence.
- Mark mandatory=true for "shall/must/required" items and mandatory=false for "should/preferred/may" items.
- Choose a short category label for each (Submission, Forms, Qualifications, Scope, or similar).
- Skip pure narrative background that a proposal cannot be checked against.`;

export async function extractRequirements(rfpText: string): Promise<Requirement[]> {
  const text = (rfpText ?? "").slice(0, RFP_CHAR_CAP);
  if (!text.trim()) return [];
  const truncated = (rfpText ?? "").length > RFP_CHAR_CAP;

  const resp = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4000,
    system: EXTRACT_SYSTEM,
    tools: [
      {
        name: "extract_requirements",
        description: "Return the list of concrete, checkable RFP requirements.",
        input_schema: {
          type: "object",
          properties: {
            requirements: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: {
                    type: "string",
                    description: "The requirement as one checkable sentence.",
                  },
                  category: {
                    type: "string",
                    description: "Short label, e.g. Submission, Forms, Qualifications, Scope.",
                  },
                  mandatory: {
                    type: "boolean",
                    description: "true for shall/must/required; false for should/preferred/may.",
                  },
                },
                required: ["text", "category", "mandatory"],
              },
            },
          },
          required: ["requirements"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "extract_requirements" },
    messages: [
      {
        role: "user",
        content: `RFP text${truncated ? " (truncated to the first part of the document)" : ""}:
"""
${text}
"""

Call extract_requirements with the concrete, checkable requirements.`,
      },
    ],
  });

  // A truncated tool call yields an incomplete JSON array; surface it rather
  // than silently returning a half-parsed list.
  if (resp.stop_reason === "max_tokens") {
    throw new Error("The RFP produced too many requirements to list in one response. Try a shorter RFP.");
  }

  const tool = resp.content.find((b) => b.type === "tool_use") as
    | Anthropic.ToolUseBlock
    | undefined;
  const raw = (tool?.input as { requirements?: Omit<Requirement, "id">[] })?.requirements ?? [];

  // Assign our own stable ids (r1, r2, ...) so the merge in checkCompliance is
  // guaranteed unique regardless of what the model returned.
  return raw
    .filter((r) => r.text?.trim())
    .slice(0, MAX_REQUIREMENTS)
    .map((r, i) => ({
      id: `r${i + 1}`,
      text: r.text.trim(),
      category: (r.category ?? "General").trim() || "General",
      mandatory: !!r.mandatory,
    }));
}

const CHECK_SYSTEM = `You are a proposal reviewer. Given a set of RFP requirements and the current draft of a civil-engineering proposal, judge how well the draft satisfies each requirement. For every requirement return:
- status: "met" (the proposal clearly and fully satisfies it), "partial" (the proposal addresses it but is incomplete, vague, or unconfirmed), or "missing" (the proposal does not address it at all).
- note: one short sentence explaining the call. Be specific and honest; do not give credit the text does not support.
- evidence: a short verbatim quote (a phrase or sentence) copied from the PROPOSAL that supports a met/partial call. Use "" when the requirement is missing or nothing in the proposal supports it. Never quote from the requirement; quote only from the proposal.

Judge only against the provided proposal text. Do not assume facts that are not written there.`;

async function checkBatch(
  batch: Requirement[],
  proposalText: string,
  truncated: boolean,
): Promise<Assessment[]> {
  const reqList = batch
    .map((r) => `${r.id}. [${r.mandatory ? "mandatory" : "optional"}] ${r.text}`)
    .join("\n");

  const resp = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 3000,
    system: CHECK_SYSTEM,
    tools: [
      {
        name: "report_compliance",
        description: "Return one assessment per requirement id.",
        input_schema: {
          type: "object",
          properties: {
            assessments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "The requirement id being assessed." },
                  status: { type: "string", enum: ["met", "partial", "missing"] },
                  note: { type: "string", description: "One short sentence explaining the call." },
                  evidence: {
                    type: "string",
                    description: "Short verbatim quote from the proposal, or empty string.",
                  },
                },
                required: ["id", "status", "note", "evidence"],
              },
            },
          },
          required: ["assessments"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "report_compliance" },
    messages: [
      {
        role: "user",
        content: `REQUIREMENTS:
${reqList}

PROPOSAL DRAFT${truncated ? " (truncated)" : ""}:
"""
${proposalText}
"""

Call report_compliance with exactly one assessment for each requirement id above.`,
      },
    ],
  });

  const tool = resp.content.find((b) => b.type === "tool_use") as
    | Anthropic.ToolUseBlock
    | undefined;
  const raw = (tool?.input as { assessments?: Assessment[] })?.assessments ?? [];
  const byId = new Map<string, Assessment>();
  for (const a of raw) {
    if (!a?.id) continue;
    byId.set(a.id, {
      id: a.id,
      status: a.status === "met" || a.status === "partial" ? a.status : "missing",
      note: (a.note ?? "").trim(),
      evidence: (a.evidence ?? "").trim(),
    });
  }

  // Guarantee one assessment per requirement even if the model dropped some.
  return batch.map(
    (r) =>
      byId.get(r.id) ?? {
        id: r.id,
        status: "missing" as const,
        note: "This requirement was not assessed.",
        evidence: "",
      },
  );
}

export async function checkCompliance(
  requirements: Requirement[],
  proposalText: string,
): Promise<Assessment[]> {
  if (!requirements.length) return [];
  const text = (proposalText ?? "").slice(0, PROPOSAL_CHAR_CAP);
  const truncated = (proposalText ?? "").length > PROPOSAL_CHAR_CAP;

  const results: Assessment[] = [];
  for (let i = 0; i < requirements.length; i += CHECK_BATCH_SIZE) {
    const batch = requirements.slice(i, i + CHECK_BATCH_SIZE);
    results.push(...(await checkBatch(batch, text, truncated)));
  }
  return results;
}
