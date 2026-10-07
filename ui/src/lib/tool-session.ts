import { validateUIValues, type IntelligentUI, type UIInputSnapshot, type UIValue } from "../../../internal/agora/intelligent-ui.js";
import type { TableScenario } from "../../../internal/agora/types.js";
import { MAX_TOOL_DRAFT_CHARS, type ToolDraft } from "./tool-draft.js";

const object = (raw: unknown): Record<string, unknown> | null => raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
const sequence = (raw: unknown, minimum = 1): raw is number => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= minimum;
const label = (raw: unknown, max: number): raw is string => typeof raw === "string" && raw.trim().length > 0 && raw.length <= max;
const nonce = (raw: unknown): raw is string => typeof raw === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(raw);

/** Old model values are inspectable data; never validate/reinterpret them against the current model. */
function safeValues(raw: unknown): Record<string, UIValue> | null {
  const value = object(raw);
  if (!value) return null;
  const entries = Object.entries(value);
  if (entries.length > 16) return null;
  const result: Record<string, UIValue> = {};
  for (const [key, item] of entries) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || ["constructor", "prototype", "__proto__"].includes(key)) return null;
    if (typeof item !== "boolean" && !(typeof item === "string" && item.length <= 2000) && !(typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 1e12)) return null;
    result[key] = item as UIValue;
  }
  return result;
}

export function safeInputSnapshot(spec: IntelligentUI, raw: unknown): { snapshot: UIInputSnapshot | null; invalid: boolean } {
  if (raw === undefined || raw === null) return { snapshot: null, invalid: false };
  try {
    const source = object(raw);
    if (!source || !sequence(source.seq) || !label(source.by, 500)) return { snapshot: null, invalid: true };
    return { snapshot: { seq: source.seq, by: source.by, values: validateUIValues(spec, source.values) }, invalid: false };
  } catch { return { snapshot: null, invalid: true }; }
}

/** Keep the newest valid history, in chronological order, without allowing corruption to break rendering. */
export function safeScenarios(raw: unknown): { scenarios: TableScenario[]; invalid: boolean } {
  if (raw === undefined || raw === null) return { scenarios: [], invalid: false };
  if (!Array.isArray(raw)) return { scenarios: [], invalid: true };
  const scenarios: TableScenario[] = [];
  const seen = new Set<number>();
  let invalid = raw.length > 24, chars = 2;
  for (const item of raw.slice(-24).reverse()) {
    try {
      const source = object(item);
      const values = source && safeValues(source.values);
      if (!source || !values || !sequence(source.seq) || !sequence(source.revision) || source.revision >= source.seq || !label(source.by, 500) || !label(source.name, 80) || seen.has(source.seq)) { invalid = true; continue; }
      const scenario: TableScenario = { seq: source.seq, revision: source.revision, by: source.by, name: source.name, values };
      const size = JSON.stringify(scenario).length + (scenarios.length ? 1 : 0);
      if (chars + size > 256_000) { invalid = true; continue; }
      chars += size; seen.add(source.seq); scenarios.push(scenario);
    } catch { invalid = true; }
  }
  return { scenarios: scenarios.sort((a, b) => a.seq - b.seq), invalid };
}

/** Only the server-attributed event can confirm a pending save; a matching value alone proves nothing. */
export function acknowledgedScenario(ops: unknown, expected: { nonce: string; target: string; revision: number; by: string }): number | null {
  if (!Array.isArray(ops) || !nonce(expected.nonce) || !/^W[1-9]\d*$/.test(expected.target) || !sequence(expected.revision) || !label(expected.by, 500)) return null;
  for (let i = ops.length - 1; i >= 0; i--) {
    const entry = object(ops[i]), op = object(entry?.op);
    if (entry && op && sequence(entry.seq) && entry.seq > expected.revision && op.op === "component-input" && op.nonce === expected.nonce && op.target === expected.target && op.revision === expected.revision && op.by === expected.by && sequence(op.inputSeq, 0) && op.inputSeq < entry.seq) return entry.seq;
  }
  return null;
}

export interface ToolDraftStorage { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; }
export interface PreviousToolDraft { key: string; revision: number; draft: ToolDraft; }

/** Read only the exact room/component namespace, and return old drafts for export, never automatic application. */
export function safePreviousDrafts(prefix: string, currentKey: string, storage?: ToolDraftStorage): PreviousToolDraft[] {
  try {
    if (!prefix.startsWith("agoryx.tool-draft.") || !/\.W[1-9]\d*\.$/.test(prefix) || !currentKey.startsWith(prefix)) return [];
    const currentSuffix = currentKey.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(currentSuffix) || !sequence(Number(currentSuffix))) return [];
    const currentRevision = Number(currentSuffix);
    const source = storage ?? sessionStorage;
    const candidates: { key: string; revision: number }[] = [];
    for (let i = 0; i < source.length; i++) {
      const key = source.key(i);
      if (!key?.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      if (!/^[1-9]\d*$/.test(suffix)) continue;
      const revision = Number(suffix);
      if (sequence(revision) && revision < currentRevision) candidates.push({ key, revision });
    }
    const result: PreviousToolDraft[] = [];
    for (const candidate of candidates.sort((a, b) => b.revision - a.revision)) {
      const raw = source.getItem(candidate.key);
      if (!raw || raw.length > MAX_TOOL_DRAFT_CHARS) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const item = object(parsed), values = item && safeValues(item.values);
      if (!item || !values || item.version !== 1 || !sequence(item.baseSeq, 0) || typeof item.name !== "string" || item.name.length > 80 || (item.saveNonce !== undefined && !nonce(item.saveNonce))) continue;
      result.push({ ...candidate, draft: { version: 1, baseSeq: item.baseSeq, name: item.name, values, ...(item.saveNonce === undefined ? {} : { saveNonce: item.saveNonce }) } });
      if (result.length === 3) break;
    }
    return result;
  } catch { return []; }
}
