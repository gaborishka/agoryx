import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIntelligentUI } from "../../internal/agora/intelligent-ui.js";
import { acknowledgedScenario, safeInputSnapshot, safePreviousDrafts, safeScenarios, type ToolDraftStorage } from "../../ui/src/lib/tool-session.js";

const spec = parseIntelligentUI({ version: 1, description: "A model", inputs: [{ id: "people", type: "number", label: "People", min: 1, max: 10, value: 3 }], root: { type: "input", id: "people" } });
const scenario = (seq = 4, values: unknown = { people: 3 }) => ({ seq, revision: 1, name: "Baseline", by: "Ivan", values });
const storage = (entries: Record<string, string>): ToolDraftStorage => ({ length: Object.keys(entries).length, key: i => Object.keys(entries)[i] ?? null, getItem: key => entries[key] ?? null });
const draft = (extra = {}) => JSON.stringify({ version: 1, baseSeq: 3, name: "My exploration", values: { old_input: "  preserved text  " }, ...extra });

test("saved snapshot validation rejects wrong ranges and corruption before renderer use", () => {
  assert.deepEqual(safeInputSnapshot(spec, undefined), { snapshot: null, invalid: false });
  const raw = { by: "Ivan", seq: 4, values: { people: 5 } };
  assert.deepEqual(safeInputSnapshot(spec, raw), { snapshot: raw, invalid: false });
  for (const bad of [[], {}, { ...raw, seq: NaN }, { ...raw, by: null }, { ...raw, values: null }, { ...raw, values: { people: 20 } }, { ...raw, values: { people: "5" } }, { ...raw, values: { people: 5, other: true } }]) {
    assert.deepEqual(safeInputSnapshot(spec, bad), { snapshot: null, invalid: true });
  }
  const sanitized = safeInputSnapshot(spec, raw).snapshot!;
  sanitized.values.people = 6;
  assert.equal(raw.values.people, 5);
});

test("history preserves old-model scalars and filters invalid names, values and identities", () => {
  const old = scenario(2, { previous_model_text: "", flag: false });
  const current = scenario(8);
  const result = safeScenarios([old, null, { ...current, values: null }, { ...current, name: null }, { ...current, by: {} }, { ...current, revision: 9 }, { ...current, values: { constructor: 1 } }, { ...current, values: { x: Infinity } }, { ...current, values: { x: {} } }, current]);
  assert.deepEqual(result, { scenarios: [old, current], invalid: true });
  assert.deepEqual(safeScenarios(undefined), { scenarios: [], invalid: false });
  assert.deepEqual(safeScenarios({}), { scenarios: [], invalid: true });
  assert.deepEqual(safeScenarios([current, current]), { scenarios: [current], invalid: true });
  result.scenarios[1]!.values.people = 9;
  assert.deepEqual(current.values, { people: 3 });
});

test("history count and serialized size are bounded while recent valid scenarios survive", () => {
  const many = safeScenarios(Array.from({ length: 40 }, (_, i) => scenario(i + 2)));
  assert.equal(many.invalid, true);
  assert.equal(many.scenarios.length, 24);
  assert.equal(many.scenarios.at(-1)!.seq, 41);
  const largeValues = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`value_${i}`, "\u0001".repeat(2000)]));
  const large = safeScenarios(Array.from({ length: 24 }, (_, i) => scenario(i + 2, largeValues)));
  assert.equal(large.invalid, true);
  assert.ok(large.scenarios.length > 0);
  assert.ok(JSON.stringify(large.scenarios).length <= 256_000);
  assert.equal(large.scenarios.at(-1)!.seq, 25);
});

test("history at the exact server size limit stays valid without losing a scenario", () => {
  const sizedScenario = (seq: number, size: number) => {
    const item = { seq, revision: 1, by: "Ivan", name: "Boundary", values: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`value_${i}`, "\u0000".repeat(1300)])) };
    let remaining = size - JSON.stringify(item).length;
    for (const key of Object.keys(item.values)) {
      const added = Math.min(remaining, 2000 - item.values[key]!.length);
      item.values[key] += "x".repeat(added);
      remaining -= added;
    }
    assert.equal(remaining, 0, "fixture must fit valid input limits and its requested serialized size");
    return item;
  };
  const history = [sizedScenario(2, 127_998), sizedScenario(3, 127_999)];
  assert.equal(JSON.stringify(history).length, 256_000);
  assert.deepEqual(safeScenarios(history), { scenarios: history, invalid: false });
  const oversized = structuredClone(history);
  oversized[0]!.name += "x";
  assert.equal(JSON.stringify(oversized).length, 256_001);
  assert.deepEqual(safeScenarios(oversized), { scenarios: [oversized[1]!], invalid: true });
});

test("SSE acknowledgement requires the exact authoritative nonce, actor, component and revision", () => {
  const expected = { nonce: "save-123", target: "W1", revision: 2, by: "Ivan" };
  const event = { seq: 5, op: { op: "component-input", inputSeq: 3, ...expected, values: { people: 4 } } };
  assert.equal(acknowledgedScenario([event], expected), 5);
  for (const altered of [{ nonce: "save-old" }, { target: "W2" }, { revision: 1 }, { by: "codex" }, { op: "component" }, { inputSeq: 5 }]) assert.equal(acknowledgedScenario([{ ...event, op: { ...event.op, ...altered } }], expected), null);
  assert.equal(acknowledgedScenario([{ ...event, seq: 2 }], expected), null);
  assert.equal(acknowledgedScenario([null, {}, { op: null }], expected), null);
  assert.equal(acknowledgedScenario([event], { ...expected, nonce: "" }), null);
  assert.equal(acknowledgedScenario(null, expected), null);
});

test("previous draft recovery is read-only, revision-scoped and never reinterprets prior model inputs", () => {
  const prefix = "agoryx.tool-draft.room-a.W1.";
  const entries = {
    [`${prefix}1`]: draft(), [`${prefix}2`]: draft(), [`${prefix}3`]: draft({ saveNonce: "save-123" }), [`${prefix}4`]: draft(), [`${prefix}5`]: draft(),
    [`${prefix}6`]: draft(), [`${prefix}99`]: draft(), [`${prefix}04`]: draft(), [`${prefix}4.other`]: draft(),
    "agoryx.tool-draft.room-b.W1.4": draft(), "agoryx.tool-draft.room-a.W10.4": draft(),
  };
  const before = JSON.stringify(entries);
  const result = safePreviousDrafts(prefix, `${prefix}6`, storage(entries));
  assert.deepEqual(result.map(item => item.revision), [5, 4, 3]);
  assert.equal(result[0]!.draft.values.old_input, "  preserved text  ");
  assert.equal((result[2]!.draft as { saveNonce?: string }).saveNonce, "save-123");
  assert.equal(JSON.stringify(entries), before);
  assert.deepEqual(safePreviousDrafts(prefix, "agoryx.tool-draft.room-b.W1.6", storage(entries)), []);
  assert.deepEqual(safePreviousDrafts("", `${prefix}6`, storage(entries)), []);
});

test("corrupted drafts and inaccessible browser storage fail locally without losing valid older drafts", () => {
  const prefix = "agoryx.tool-draft.room-a.W1.";
  const badDrafts = ["{", "null", draft({ name: null }), draft({ baseSeq: -1 }), draft({ values: null }), draft({ values: { x: [1] } }), draft({ values: { x: "x".repeat(2001) } }), draft({ saveNonce: "invalid nonce" }), " ".repeat(200_001)];
  const entries = Object.fromEntries(badDrafts.map((value, i) => [`${prefix}${i + 2}`, value]));
  entries[`${prefix}1`] = draft();
  assert.deepEqual(safePreviousDrafts(prefix, `${prefix}20`, storage(entries)).map(item => item.revision), [1]);
  const inaccessible: ToolDraftStorage = { get length() { throw new Error("storage unavailable"); }, key: () => null, getItem: () => null };
  assert.deepEqual(safePreviousDrafts(prefix, `${prefix}20`, inaccessible), []);
});
