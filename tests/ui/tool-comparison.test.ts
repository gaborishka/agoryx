import assert from "node:assert/strict";
import { test } from "node:test";
import { parseIntelligentUI } from "../../internal/agora/intelligent-ui.js";
import { compareToolValues } from "../../ui/src/lib/tool-comparison.js";

const spec = parseIntelligentUI({ version: 1, description: "Illustrative capacity model", inputs: [{ id: "capacity", label: "Capacity", type: "number", min: 0, max: 12, value: 3 }], root: { type: "stack", children: [
  { type: "input", id: "capacity" },
  { type: "metric", label: "Days", value: { op: "divide", args: [24, { input: "capacity" }] }, unit: "days" },
  { type: "metric", label: "Days", value: { op: "multiply", args: [2, { input: "capacity" }] }, unit: "days" },
] } });

test("scenario comparison evaluates both sides in the same model and keeps duplicate labels distinct", () => {
  const left = { capacity: 3 }, right = { capacity: 6 };
  const comparison = compareToolValues(spec, left, right);
  assert.deepEqual(comparison.inputs.map(row => [row.left, row.right, row.delta]), [[3, 6, 3]]);
  assert.deepEqual(comparison.outputs.map(row => [row.left, row.right, row.delta]), [[8, 4, -4], [6, 12, 6]]);
  assert.equal(new Set(comparison.outputs.map(row => row.id)).size, 2);
  assert.equal(comparison.changed, 3);
  assert.deepEqual(left, { capacity: 3 }); assert.deepEqual(right, { capacity: 6 });
});

test("unknown results remain unknown, including when both scenarios cannot be evaluated", () => {
  const comparison = compareToolValues(spec, { capacity: 0 }, { capacity: 0 });
  assert.equal(comparison.changed, 0); assert.equal(comparison.unavailable, 1);
  assert.equal(comparison.outputs[0]!.left, null); assert.equal(comparison.outputs[0]!.delta, null);
});

test("wrong, incomplete or out-of-range scenario inputs are never silently compared", () => {
  for (const invalid of [{}, { capacity: "3" }, { capacity: 13 }, { capacity: 3, extra: true }]) {
    assert.throws(() => compareToolValues(spec, invalid, { capacity: 6 }));
    assert.throws(() => compareToolValues(spec, { capacity: 6 }, invalid));
  }
});

test("invalid visual domains retain diagnostics instead of claiming meaningful deltas", () => {
  const invalid = parseIntelligentUI({ version: 1, description: "Invalid progress model", inputs: [], root: { type: "progress", label: "Completed", value: 3, max: 0 } });
  const comparison = compareToolValues(invalid, {}, {});
  assert.equal(comparison.unavailable, 2);
  assert.equal(comparison.warnings, 2);
  assert.ok(comparison.outputs.every(row => row.delta === null && row.leftDiagnostic && row.rightDiagnostic));
});
