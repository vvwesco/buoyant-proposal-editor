// Core document model. A parsed PDF becomes an ordered list of Blocks — the
// editable source of truth. The original PDF is kept only for reference/rendering.

export type BlockType = "heading" | "paragraph" | "list-item" | "other";

export interface BBox {
  page: number; // 1-indexed
  x: number; // top-left, in PDF points (origin top-left after our normalization)
  y: number;
  w: number;
  h: number;
}

export interface Block {
  id: string;
  type: BlockType;
  text: string; // current text (may have been edited)
  original: string; // text as first parsed — never mutated; used for diffing/eval
  page: number;
  bbox: BBox;
  fontSize: number;
  edited: boolean;
}

export interface ParsedDoc {
  fileName: string;
  numPages: number;
  blocks: Block[];
  pageSizes: { page: number; width: number; height: number }[];
}

// A single applied edit, for the undo stack and audit trail.
export interface EditRecord {
  id: string;
  blockId: string;
  before: string;
  after: string;
  instruction: string;
  action: string;
  rationale?: string;
  at: number;
}

// A content-tailored edit suggestion offered when a paragraph is selected.
export interface Suggestion {
  label: string; // short button text
  instruction: string; // what the edit will do if clicked
}

export interface EditProposal {
  newText: string;
  rationale: string;
  // Facts the model claims it used from the KB, for transparency (grounding).
  usedFacts?: string[];
}
