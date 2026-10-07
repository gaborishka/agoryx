import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
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
