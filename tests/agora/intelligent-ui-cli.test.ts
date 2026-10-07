import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runIntelligentUICommand } from "../../internal/agora/intelligent-ui-cli.js";
import { INTELLIGENT_UI_EXAMPLE } from "../../internal/agora/intelligent-ui-guide.js";

const run = (args: string[]) => { const output: string[] = []; const code = runIntelligentUICommand(args, line => output.push(line)); return { code, text: output.join("\n") }; };
test("UI preflight validates a real tool and reports its default calculations without a room", () => {
  const result = run(["check", "--file", "docs/examples/delivery-explorer.json"]);
  assert.equal(result.code, 0); assert.match(result.text, /Delivery window: 15 days/); assert.match(result.text, /Inputs: 3/);
  assert.equal(run(["check", "--body", JSON.stringify(INTELLIGENT_UI_EXAMPLE)]).code, 0);
  const guide = run(["guide"]); assert.equal(guide.code, 0); assert.match(guide.text, /accordion/); assert.match(guide.text, /ui check/);
});
test("preflight refuses mixed sources, malformed arguments and unknown grammar with actionable errors", () => {
  for (const args of [["check", "--file", "a", "--body", "{}"], ["check", "--body"], ["check", "--unknown", "yes"], ["guide", "extra"], ["check", "--body", "not JSON"], ["check", "--body", "{}", "--ref", "not-a-reference"]]) assert.notEqual(run(args).code, 0);
  const invalid = run(["check", "--body", JSON.stringify({ ...INTELLIGENT_UI_EXAMPLE, root: { type: "script" } })]);
  assert.match(invalid.text, /ui.root/); assert.match(invalid.text, /unknown node/);
});
test("preflight sources require declared refs but do not claim existence outside the room", () => {
  const spec = { version: 1, description: "Source browser", inputs: [], root: { type: "sources", refs: ["F1", "Q2"] } };
  assert.equal(run(["check", "--body", JSON.stringify(spec)]).code, 1);
  const result = run(["check", "--body", JSON.stringify(spec), "--ref", "#f1", "--ref", "Q2"]);
  assert.equal(result.code, 0); assert.match(result.text, /existence is checked when publishing/);
});
test("agent shim delegates preflight to the full CLI without requiring an Agoryx workspace", () => {
  const shim = readFileSync("bin/agoryx-agent.mjs", "utf8");
  assert.match(shim, /agoryx ui guide/);
  assert.ok(shim.indexOf('command !== "table"') < shim.indexOf('const agoryxDir = findAgoryxDir()'));
});

test("JSON preflight evaluates partial scenario overrides across all expression-bearing outputs", () => {
  const result = run(["check", "--file", "docs/examples/delivery-explorer.json", "--values", '{"team":6}', "--json"]);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.text);
  assert.equal(report.valid, true);
  assert.equal(report.values.team, 6);
  assert.equal(report.values.scope, 36, "unsupplied inputs retain authored defaults");
  assert.equal(report.outputs.find((item: { label: string }) => item.label === "Delivery window").value, 9);
  assert.ok(report.outputs.some((item: { kind: string }) => item.kind === "chart"));
  assert.ok(report.outputs.some((item: { kind: string }) => item.kind === "table"));
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.referenceCheck, "on-publication");
  assert.match(run(["check", "--file", "docs/examples/delivery-explorer.json", "--values", '{"team":6}']).text, /Scenario values:\n  Delivery window: 9 days/);
});

test("invalid overrides fail with machine-readable errors instead of coercion or silently ignored keys", () => {
  for (const values of ["not json", "null", "[]", '{"people":"3"}', '{"people":0}', '{"typo":4}', '{"__proto__":{"polluted":true}}']) {
    const result = run(["check", "--body", JSON.stringify(INTELLIGENT_UI_EXAMPLE), "--values", values, "--json"]);
    assert.equal(result.code, 1, values);
    assert.equal(JSON.parse(result.text).valid, false);
    assert.equal(typeof JSON.parse(result.text).error, "string");
  }
  assert.equal(run(["check", "--body", JSON.stringify(INTELLIGENT_UI_EXAMPLE), "--values", "{}", "--values-file", "inputs.json", "--json"]).code, 1);
  assert.equal(run(["check", "-", "--values-file", "-", "--json"]).code, 1);
});

test("values files work locally and oversized files are bounded before JSON parsing", () => {
  const home = mkdtempSync(join(tmpdir(), "agoryx-ui-values-"));
  try {
    const values = join(home, "values.json");
    writeFileSync(values, '{"people":5}');
    const result = run(["check", "--body", JSON.stringify(INTELLIGENT_UI_EXAMPLE), "--values-file", values, "--json"]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.text).outputs[0].value, 6);
    writeFileSync(values, " ".repeat(800_001));
    const tooLarge = run(["check", "--body", JSON.stringify(INTELLIGENT_UI_EXAMPLE), "--values-file", values, "--json"]);
    assert.equal(tooLarge.code, 1); assert.match(JSON.parse(tooLarge.text).error, /exceeds 200,000/);
    writeFileSync(values, " ".repeat(192_001));
    const largeSpec = run(["check", "--file", values, "--json"]);
    assert.equal(largeSpec.code, 1); assert.match(JSON.parse(largeSpec.text).error, /exceeds 48,000/);
  } finally { rmSync(home, { force: true, recursive: true }); }
});

test("preflight distinguishes valid structure from unavailable calculations with paths and causes", () => {
  const spec = { version: 1, description: "Unknown calculation", inputs: [], root: { type: "table", caption: "Forecast", columns: ["Days"], rows: [[{ op: "divide", args: [2, 0] }]] } };
  const result = run(["check", "--body", JSON.stringify(spec), "--json"]);
  assert.equal(result.code, 0, "Unavailable is an inspectable model result, not invalid JSON grammar");
  const report = JSON.parse(result.text);
  assert.deepEqual(report.diagnostics, [{ path: "ui.root.rows[0][0]", label: "Forecast · row 1 · Days", message: "Division by zero." }]);
  assert.match(run(["check", "--body", JSON.stringify(spec)]).text, /Calculation diagnostics:\n  ui.root.rows\[0\]\[0\].*Division by zero/);
});
