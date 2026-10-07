import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultUIValues, parseIntelligentUI } from "../../internal/agora/intelligent-ui.js";
import { evaluateUIOutputs } from "../../internal/agora/intelligent-ui-evaluation.js";

const input = { input: "quantity" };
const times = (amount: number) => ({ op: "multiply", args: [amount, input] });
const composed = () => parseIntelligentUI({ version: 1, description: "Evaluate each view", inputs: [{ id: "quantity", label: "Quantity", type: "number", min: 0, max: 10, value: 2 }], root: { type: "stack", children: [
  { type: "input", id: "quantity" },
  { type: "metric", label: "Estimate", value: times(3), unit: "hours" },
  { type: "tabs", tabs: [
    { label: "Chart", children: [{ type: "chart", title: "Team effort", items: [{ label: "Build", value: times(4) }, { label: "Review", value: input }], unit: "hours" }] },
    { label: "Details", children: [{ type: "accordion", sections: [{ title: "Progress", children: [
      { type: "progress", label: "Completed", value: input, max: 10, unit: "tasks" },
      { type: "table", caption: "Capacity", columns: ["Task", "Hours"], rows: [["Build", times(4)], ["Review", input]] },
      { type: "comparison", columns: [{ title: "Plan A", items: [{ label: "Cost", value: times(10) }] }, { title: "Plan B", items: [{ label: "Cost", value: times(20) }] }] },
    ] }] }] },
  ] },
] } });

test("all value-bearing nodes are evaluated with stable paths and contextual labels, including closed views", () => {
  const spec = composed();
  const before = JSON.stringify(spec);
  const outputs = evaluateUIOutputs(spec, { quantity: 3 });
  assert.equal(outputs.length, 11);
  assert.deepEqual(outputs[0], { path: "ui.root.children[1].value", label: "Estimate", kind: "metric", value: 9, unit: "hours" });
  assert.deepEqual(outputs[1], { path: "ui.root.children[2].tabs[0].children[0].items[0].value", label: "Team effort · Build", kind: "chart", value: 12, unit: "hours" });
  assert.deepEqual(outputs.filter(output => output.kind === "progress").map(output => [output.label, output.value, output.path.split(".").at(-1)]), [["Completed · value", 3, "value"], ["Completed · maximum", 10, "max"]]);
  assert.equal(outputs.find(output => output.label === "Capacity · row 2 · Hours")!.value, 3);
  assert.equal(outputs.find(output => output.label === "Plan B · Cost")!.value, 60);
  assert.ok(outputs.every(output => !output.diagnostic));
  assert.equal(JSON.stringify(spec), before);
  const defaults = evaluateUIOutputs(spec, defaultUIValues(spec));
  assert.deepEqual(defaults.map(output => output.path), outputs.map(output => output.path));
  assert.notEqual(defaults[0]!.value, outputs[0]!.value);
});

test("complete input values are validated before calculations, without coercion or extra keys", () => {
  const spec = composed();
  for (const values of [{}, { quantity: "3" }, { quantity: 11 }, { quantity: NaN }, { quantity: 2, typo: 3 }]) assert.throws(() => evaluateUIOutputs(spec, values as never), /values/);
});

test("unavailable expression diagnostics explain nested errors and ignore an unselected invalid branch", () => {
  const divideByZero = { op: "divide", args: [3, 0] };
  const spec = parseIntelligentUI({ version: 1, description: "Calculation checks", inputs: [], root: { type: "stack", children: [
    { type: "metric", label: "Nested division", value: { op: "add", args: [1, divideByZero] } },
    { type: "metric", label: "Wrong type", value: { op: "multiply", args: [2, "3"] } },
    { type: "metric", label: "Length", value: { op: "length", args: [3] } },
    { type: "metric", label: "Condition", value: { op: "if", args: ["yes", 1, 2] } },
    { type: "metric", label: "Safe branch", value: { op: "if", args: [true, 8, divideByZero] } },
    { type: "chart", title: "Nonnumeric", items: [{ label: "Missing", value: "pending" }] },
    { type: "progress", label: "Bad maximum", value: 3, max: 0 },
  ] } });
  const outputs = evaluateUIOutputs(spec, {});
  assert.equal(outputs[0]!.value, null); assert.match(outputs[0]!.diagnostic!, /Division by zero/);
  assert.equal(outputs[1]!.value, null); assert.match(outputs[1]!.diagnostic!, /strings are not converted/);
  assert.match(outputs[2]!.diagnostic!, /requires a string/);
  assert.match(outputs[3]!.diagnostic!, /boolean condition/);
  assert.equal(outputs[4]!.value, 8); assert.equal(outputs[4]!.diagnostic, undefined);
  assert.equal(outputs[5]!.value, null); assert.match(outputs[5]!.diagnostic!, /numeric result/);
  assert.equal(outputs[6]!.value, null); assert.match(outputs[6]!.diagnostic!, /positive maximum/);
  assert.equal(outputs[7]!.value, null); assert.match(outputs[7]!.diagnostic!, /positive maximum/);
});

test("donut domain diagnostics preserve numeric legend values for negative, zero and overflow totals", () => {
  let huge: unknown = 1e12;
  for (let i = 0; i < 3; i++) huge = { op: "multiply", args: [huge, ...Array(7).fill(1e12)] };
  // 1e12 * (1e12)^21 = 1e264; an additional 1e44 creates a finite 1e308 part.
  huge = { op: "multiply", args: [huge, 1e12, 1e12, 1e12, 1e8] };
  const cases = [
    { values: [-2, 5], pattern: /negative/ },
    { values: [0, 0], pattern: /positive total/ },
    { values: [huge, huge], pattern: /not finite/ },
  ];
  for (const entry of cases) {
    const spec = parseIntelligentUI({ version: 1, description: "Part-to-whole", inputs: [], root: { type: "chart", title: "Budget", variant: "donut", items: entry.values.map((value, index) => ({ label: `Part ${index + 1}`, value })) } });
    const outputs = evaluateUIOutputs(spec, {});
    assert.ok(outputs.every(output => typeof output.value === "number" && Number.isFinite(output.value)));
    for (const output of outputs) assert.match(output.diagnostic!, entry.pattern);
  }
  const valid = parseIntelligentUI({ version: 1, description: "Valid chart", inputs: [], root: { type: "chart", title: "Parts", variant: "donut", items: [{ label: "A", value: 0 }, { label: "B", value: 3 }] } });
  assert.ok(evaluateUIOutputs(valid, {}).every(output => output.diagnostic === undefined));
});

test("unrenderable progress makes both outputs unavailable while out-of-range bars preserve actual values", () => {
  for (const [value, max] of [["pending", 10], [2, "unknown"], [2, 0], [2, -1]]) {
    const spec = parseIntelligentUI({ version: 1, description: "Progress", inputs: [], root: { type: "progress", label: "Tasks", value, max } });
    const outputs = evaluateUIOutputs(spec, {});
    assert.ok(outputs.every(output => output.value === null && output.diagnostic));
  }
  for (const value of [-1, 12]) {
    const spec = parseIntelligentUI({ version: 1, description: "Progress", inputs: [], root: { type: "progress", label: "Tasks", value, max: 10 } });
    const [amount, maximum] = evaluateUIOutputs(spec, {});
    assert.equal(amount!.value, value); assert.match(amount!.diagnostic!, /outside/);
    assert.equal(maximum!.value, 10); assert.equal(maximum!.diagnostic, undefined);
  }
});

test("long string results and boolean type errors retain clear unavailable diagnostics", () => {
  const spec = parseIntelligentUI({ version: 1, description: "Text model", inputs: [{ id: "note", label: "Note", type: "text", value: "", maxLength: 2000 }], root: { type: "stack", children: [
    { type: "input", id: "note" },
    { type: "metric", label: "Joined", value: { op: "concat", args: Array(5).fill({ input: "note" }) } },
    { type: "metric", label: "Boolean", value: { op: "and", args: [true, { input: "note" }] } },
  ] } });
  const outputs = evaluateUIOutputs(spec, { note: "a".repeat(2000) });
  assert.match(outputs[0]!.diagnostic!, /8000/);
  assert.match(outputs[1]!.diagnostic!, /boolean arguments/);
  assert.equal(evaluateUIOutputs(spec, { note: "" })[0]!.value, "");
});
