export interface ToolNumberEditor { text: string; value: number; resetVersion: number; }

/** Empty, partial and non-decimal drafts must never become a saved numeric value. */
export function parseToolNumberDraft(text: string, min: number, max: number): number | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) return null;
  const value = Number(text);
  // Keep a typed nonzero value from silently becoming a saved zero after floating-point underflow.
  if (value === 0 && /[1-9]/.test(text.trim().split(/[eE]/, 1)[0]!)) return null;
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** Explicit reset wins; ordinary remote values cannot discard unfinished editing. */
export function syncToolNumberEditor(editor: ToolNumberEditor, value: number, resetVersion: number, min: number, max: number): ToolNumberEditor {
  if (editor.resetVersion !== resetVersion) return { text: String(value), value, resetVersion };
  if (Object.is(editor.value, value)) return editor;
  return { text: parseToolNumberDraft(editor.text, min, max) === null ? editor.text : String(value), value, resetVersion };
}
