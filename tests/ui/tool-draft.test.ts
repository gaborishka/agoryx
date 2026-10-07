import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIntelligentUI } from "../../internal/agora/intelligent-ui.js";
import { parseToolDraft, readToolDraft, writeToolDraft, type ToolDraft } from "../../ui/src/lib/tool-draft.js";

const spec = parseIntelligentUI({ version: 1, description: "Draft validation", inputs: [
  { id: "people", label: "People", type: "number", min: 1, max: 10, value: 3 },
  { id: "notes", label: "Notes", type: "textarea", maxLength: 20, value: "" },
  { id: "ready", label: "Ready", type: "toggle", value: false },
  { id: "plan", label: "Plan", type: "select", options: ["Basic", "Extended"], value: "Basic" },
], root: { type: "stack", children: ["people", "notes", "ready", "plan"].map(id => ({ type: "input", id })) } });
const draft = (extra = {}): ToolDraft => ({ version: 1, baseSeq: 23, name: "Working scenario", values: { people: 5, notes: " \n  ", ready: true, plan: "Extended" }, ...extra });

test("draft restoration preserves unsaved values and their original concurrency base", () => {
  const saved = draft();
  const restored = parseToolDraft(spec, JSON.stringify(saved));
  assert.deepEqual(restored, saved);
  assert.equal(restored!.values.notes, " \n  ");
  assert.equal(restored!.baseSeq, 23);
  const newerServerSeq = 99;
  assert.notEqual(restored!.baseSeq, newerServerSeq, "a stale restored draft must remain distinguishable from current server inputs");
  assert.equal(parseToolDraft(spec, JSON.stringify(draft({ baseSeq: 0, name: "" })))!.baseSeq, 0);
});

test("untrusted draft metadata, oversized storage and malformed JSON fail closed", () => {
  for (const raw of [null, "", "{", "null", "[]", "false", "1", "x".repeat(250_001)]) assert.equal(parseToolDraft(spec, raw), null);
  for (const extra of [
    { version: 2 }, { version: "1" }, { baseSeq: -1 }, { baseSeq: 0.5 }, { baseSeq: "23" },
    { baseSeq: Number.MAX_SAFE_INTEGER + 1 }, { baseSeq: null }, { name: 4 }, { name: null }, { name: "x".repeat(81) },
  ]) assert.equal(parseToolDraft(spec, JSON.stringify(draft(extra))), null);
  assert.notEqual(parseToolDraft(spec, JSON.stringify(draft({ name: "x".repeat(80) }))), null);
});

test("restored drafts must fit the current model's exact input keys, types and limits", () => {
  for (const values of [
    {}, { ...draft().values, injected: "extra" }, { ...draft().values, people: "5" },
    { ...draft().values, people: 11 }, { ...draft().values, ready: 1 },
    { ...draft().values, notes: "x".repeat(21) }, { ...draft().values, plan: "Enterprise" },
  ]) assert.equal(parseToolDraft(spec, JSON.stringify(draft({ values }))), null);
  const changedSpec = parseIntelligentUI({ ...spec, inputs: spec.inputs.map(input => input.type === "number" ? { ...input, max: 4 } : input) });
  assert.equal(parseToolDraft(changedSpec, JSON.stringify(draft())), null, "a draft cannot bypass a tightened model's numeric bounds");
  const hostile = JSON.stringify(draft()).replace('"values":{', '"values":{"__proto__":{"polluted":true},');
  assert.equal(parseToolDraft(spec, hostile), null);
  assert.equal(({} as any).polluted, undefined);
});

test("storage adapter round-trips only its own key and explicitly reports unavailable storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const store = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    } });
    const key = "agoryx.tool-draft.room-a.W1.7";
    const other = "agoryx.tool-draft.room-b.W1.7";
    assert.equal(writeToolDraft(key, draft()), true);
    assert.equal(writeToolDraft(other, draft({ name: "Other room" })), true);
    assert.equal(writeToolDraft(key, draft({ values: { notes: "x".repeat(250_001) } })), false);
    assert.deepEqual(readToolDraft(key, spec), draft());
    assert.equal(readToolDraft("agoryx.tool-draft.room-a.W1.8", spec), null, "different content revisions cannot accidentally share a draft");
    assert.equal(writeToolDraft(key, null), true);
    assert.equal(readToolDraft(key, spec), null);
    assert.equal(readToolDraft(other, spec)!.name, "Other room");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("Storage denied"); } });
    assert.equal(readToolDraft(key, spec), null);
    assert.equal(writeToolDraft(key, draft()), false);
    assert.equal(writeToolDraft(key, null), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("maximum valid multiline drafts survive serialization expansion and remount parsing", () => {
  const inputs = Array.from({ length: 16 }, (_, i) => ({ id: `notes${i}`, label: `Notes ${i}`, type: "textarea", value: "", maxLength: 2000 }));
  const model = parseIntelligentUI({ version: 1, description: "Maximum bounded input draft", inputs, root: { type: "stack", children: inputs.map(input => ({ type: "input", id: input.id })) } });
  const values = Object.fromEntries(inputs.map(input => [input.id, "\u0000".repeat(2000)]));
  const pending = draft({ values, name: "\u0000".repeat(80) });
  const serialized = JSON.stringify(pending);
  assert.ok(serialized.length > 190_000, "JSON escaping expands otherwise valid 32,000-character values");
  assert.deepEqual(parseToolDraft(model, serialized), pending);
});
