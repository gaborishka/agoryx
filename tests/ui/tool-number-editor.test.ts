import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToolNumberDraft, syncToolNumberEditor } from "../../ui/src/lib/tool-number-editor.js";

test("partial, empty, non-decimal and out-of-range drafts cannot produce scenario values", () => {
  for (const text of ["", "  ", "-", "+", ".", "1e", "1e-", "NaN", "Infinity", "0x10", "0b10", "1000", "4", "1e999"]) {
    assert.equal(parseToolNumberDraft(text, 5, 100), null, text);
  }
  assert.equal(parseToolNumberDraft("0.04", 0, 1), 0.04);
  assert.equal(parseToolNumberDraft("-0.04", -1, 1), -0.04);
  assert.equal(parseToolNumberDraft("1e-3", 0, 1), 0.001);
  assert.equal(parseToolNumberDraft("100", 5, 100), 100);
});

test("nonzero decimal underflow stays invalid while exact zeros and representable subnormals remain valid", () => {
  for (const text of ["1e-999", "-1e-999", "1e-324", "-1E-324", "+.0001e-999", `0.${"0".repeat(400)}1`]) {
    assert.equal(parseToolNumberDraft(text, -1, 1), null, text);
  }
  for (const text of ["0", "+0.000", "0e-999", "0E999", "000.000e-999", ".0e+999"]) {
    assert.equal(parseToolNumberDraft(text, -1, 1), 0, text);
  }
  assert.ok(Object.is(parseToolNumberDraft("-0e-999", -1, 1), -0));
  assert.equal(parseToolNumberDraft("5e-324", -1, 1), Number.MIN_VALUE);
  assert.equal(parseToolNumberDraft("-5e-324", -1, 1), -Number.MIN_VALUE);
  assert.equal(parseToolNumberDraft("1e-300", -1, 1), 1e-300);
  const editor = { text: "1e-999", value: 0.5, resetVersion: 0 };
  assert.deepEqual(syncToolNumberEditor(editor, 0.25, 0, 0, 1), { ...editor, value: 0.25 }, "remote values cannot erase an invalid underflow draft");
  assert.deepEqual(syncToolNumberEditor(editor, 0.25, 1, 0, 1), { text: "0.25", value: 0.25, resetVersion: 1 });
});

test("external saved scenarios do not erase invalid drafts without an explicit reset", () => {
  const editor = { text: "1000", value: 30, resetVersion: 0 };
  assert.equal(syncToolNumberEditor(editor, 30, 0, 5, 100), editor);
  assert.deepEqual(syncToolNumberEditor(editor, 40, 0, 5, 100), { ...editor, value: 40 });
  assert.deepEqual(syncToolNumberEditor(editor, 30, 1, 5, 100), { text: "30", value: 30, resetVersion: 1 });
  const empty = { text: "", value: 30, resetVersion: 0 };
  assert.deepEqual(syncToolNumberEditor(empty, 50, 0, 5, 100), { ...empty, value: 50 });
  assert.deepEqual(syncToolNumberEditor(empty, 50, 1, 5, 100), { text: "50", value: 50, resetVersion: 1 });
});

test("valid editors follow external values while in-progress decimal formatting remains stable", () => {
  const editor = { text: "30.0", value: 30, resetVersion: 0 };
  assert.equal(syncToolNumberEditor(editor, 30, 0, 5, 100), editor);
  assert.deepEqual(syncToolNumberEditor(editor, 40, 0, 5, 100), { text: "40", value: 40, resetVersion: 0 });
});
