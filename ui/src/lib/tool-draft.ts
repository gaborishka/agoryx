import { validateUIValues, type IntelligentUI, type UIValue } from "../../../internal/agora/intelligent-ui.js";

export const MAX_TOOL_DRAFT_CHARS = 200_000;
export interface ToolDraft { version: 1; baseSeq: number; values: Record<string, UIValue>; name: string; saveNonce?: string; }
/** Per-tab drafts cannot overwrite another browser tab's exploration. Treat storage as untrusted. */
export function parseToolDraft(spec: IntelligentUI, raw: string | null): ToolDraft | null {
  if (!raw || raw.length > MAX_TOOL_DRAFT_CHARS) return null;
  try {
    const input = JSON.parse(raw);
    if (input?.version !== 1 || !Number.isSafeInteger(input.baseSeq) || input.baseSeq < 0 || typeof input.name !== "string" || input.name.length > 80) return null;
    if (input.saveNonce !== undefined && (typeof input.saveNonce !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(input.saveNonce))) return null;
    return { version: 1, baseSeq: input.baseSeq, name: input.name, values: validateUIValues(spec, input.values), ...(input.saveNonce ? { saveNonce: input.saveNonce } : {}) };
  } catch { return null; }
}
export const readToolDraft = (key: string, spec: IntelligentUI) => {
  try { return parseToolDraft(spec, sessionStorage.getItem(key)); } catch { return null; }
};
export const writeToolDraft = (key: string, draft: ToolDraft | null): boolean => {
  try {
    if (draft) {
      const encoded = JSON.stringify(draft);
      if (encoded.length > MAX_TOOL_DRAFT_CHARS) return false;
      sessionStorage.setItem(key, encoded);
    } else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
};
