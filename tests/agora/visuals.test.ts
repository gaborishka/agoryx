import assert from "node:assert/strict";
import test from "node:test";
import { buildBriefing } from "../../internal/agora/prompts.js";
import { buildClaudeSettings } from "../../internal/agora/runners/claude.js";
import { DEFAULT_SETTINGS } from "../../internal/agora/types.js";
import { parseViz, VIZ_GUIDE, VIZ_KINDS, vizBlocks, vizDecisionReply, vizText, type VizSpec } from "../../internal/agora/visuals.js";
import { createTestRoom } from "./helpers.js";

const ok = (spec: unknown): VizSpec => {
  const result = parseViz(JSON.stringify(spec));
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.spec;
};
const error = (spec: unknown): string => {
  const result = parseViz(typeof spec === "string" ? spec : JSON.stringify(spec));
  assert.equal(result.ok, false, "the spec should not parse");
  return result.ok ? "" : result.error;
};

test("every kind in the guide parses as the guide writes it", () => {
  const examples = [...VIZ_GUIDE.matchAll(/(\{"kind":.*\})(?:\s|$)/gm)].map((m) => m[1]!);
  assert.deepEqual(examples.map((e) => JSON.parse(e).kind).sort(), [...VIZ_KINDS].sort(), "one example per kind");
  for (const example of examples) assert.ok(vizText(ok(JSON.parse(example))).length > 0, "an agent can copy the example as it stands");
});

test("claims keep their tree, tone, confidence and author; a bare string is a claim", () => {
  const spec = ok({ kind: "claims", title: "Why cache", claims: ["Plain claim", { text: "Cuts p95 by 40%", tone: "pro", confidence: 0.8, by: "@codex", detail: "Measured on **staging**", children: [{ text: "Hit rate 92%", tone: "good" }] }] });
  assert.equal(spec.kind, "claims");
  if (spec.kind !== "claims") return;
  assert.equal(spec.claims[0]!.text, "Plain claim");
  assert.equal(spec.claims[1]!.children?.[0]?.text, "Hit rate 92%");
  assert.equal(vizText(spec), "Why cache\n1. Plain claim\n2. + Cuts p95 by 40% (@codex, 80%)\n  2.1. ✓ Hit rate 92%");
});

test("errors name the exact field and what to do", () => {
  assert.match(error("{nope"), /not valid JSON/);
  assert.match(error([1]), /the spec must be an object/);
  assert.match(error({ kind: "pie" }), /kind must be one of claims, compare/);
  assert.match(error({ kind: "claims", claims: [] }), /claims needs at least 1 item/);
  assert.match(error({ kind: "claims", claims: [{ text: "x".repeat(201) }] }), /claims\[0\]\.text must be at most 200 characters \(it has 201\)/);
  assert.match(error({ kind: "claims", claims: [{ text: "a", confidence: 80 }] }), /claims\[0\]\.confidence must be a number from 0 to 1/);
  assert.match(error({ kind: "claims", claims: [{ text: "a", tone: "great" }] }), /claims\[0\]\.tone must be one of/);
  const deep = { text: "1", children: [{ text: "2", children: [{ text: "3", children: [{ text: "4" }] }] }] };
  assert.match(error({ kind: "claims", claims: [deep] }), /deeper than 3 levels/);
  assert.match(error({ kind: "compare", columns: ["A", "B"], rows: [{ label: "x", values: [1] }] }), /rows\[0\]\.values has 1 values; it needs exactly 2, one per column/);
  assert.match(error({ kind: "compare", columns: ["A", "A"], rows: [{ label: "x", values: [1, 2] }] }), /columns repeats "A"/);
  assert.match(error({ kind: "compare", columns: ["A", "B"], rows: [{ label: "x", values: [1, 2] }], pick: "C" }), /pick must name one of the columns/);
  assert.match(error({ kind: "chart", labels: ["a", "b"], series: [{ name: "s", values: [1, "2"] }] }), /series\[0\]\.values\[1\] must be a number/);
  assert.match(error({ kind: "chart", type: "stacked", labels: ["a"], series: [{ name: "s", values: [-1] }] }), /must not be negative in a stacked chart/);
  assert.match(error({ kind: "stance", left: "L", right: "R", items: [{ label: "x", value: 2 }] }), /from -1 \(left\) to 1 \(right\)/);
  assert.match(error({ kind: "decision", question: "Q?", options: ["One"] }), /options needs at least 2 items/);
  assert.match(error({ kind: "decision", question: "Q?", options: [{ label: "A", recommended: true }, { label: "B", recommended: true }] }), /recommend one option at most/);
  assert.match(error({ kind: "steps", steps: Array.from({ length: 17 }, (_, i) => `s${i}`) }), /has 17 items; at most 16/);
  assert.match(error("x".repeat(16_001)), /at most 16000/);
});

test("a chart defaults to bars and a one-series chart may leave its series unnamed", () => {
  const spec = ok({ kind: "chart", labels: ["Mon", "Tue"], series: [{ values: [3, 4] }], unit: "ms" });
  assert.equal(spec.kind === "chart" && spec.type, "bar");
  assert.equal(vizText(spec), "Value: Mon 3ms, Tue 4ms");
});

test("compare, stats, steps, stance, tradeoff and decision read as text with every value they show", () => {
  assert.equal(vizText(ok({ kind: "compare", columns: ["A", "B"], rows: [{ label: "Offline", values: [true, false] }, { label: "Cost", values: [1, null] }], pick: "A" })), "| | A (pick) | B |\n| Offline | yes | no |\n| Cost | 1 | — |");
  assert.equal(vizText(ok({ kind: "stats", items: [{ label: "Tests", value: 412, delta: "+12", tone: "good" }] })), "Tests: 412 (+12)");
  assert.equal(vizText(ok({ kind: "steps", steps: ["Plan", { title: "Build", status: "doing", by: "@codex" }] })), "1. [todo] Plan\n2. [doing] Build — @codex");
  assert.equal(vizText(ok({ kind: "stance", left: "Rewrite", right: "Patch", items: [{ label: "@claude", value: -0.5, note: "debt" }] })), "Rewrite ←→ Patch\n@claude: -0.50 — debt");
  assert.equal(vizText(ok({ kind: "tradeoff", options: [{ name: "SQLite", pros: ["simple"], cons: ["one writer"], verdict: "fine for now" }] })), "SQLite:\n  + simple\n  − one writer\n  → fine for now");
  assert.equal(vizText(ok({ kind: "decision", question: "Ship?", options: [{ label: "Now", recommended: true }, "Later"] })), "Ship?\n  ○ Now (recommended)\n  ○ Later");
  assert.equal(vizDecisionReply("Ship?", "Now"), "> Ship?\n\n**Now**");
});

test("viz fences are found in markdown, other fences are not", () => {
  const md = 'Intro\n\n```viz\n{"kind":"stats","items":[{"label":"a","value":"1"}]}\n```\n\n```json\n{"kind":"claims"}\n```\n\n~~~viz\n{"kind":"x"}\n~~~\n';
  assert.deepEqual(vizBlocks(md), ['{"kind":"stats","items":[{"label":"a","value":"1"}]}', '{"kind":"x"}']);
});

test("the briefing asks for visual-first replies, lists every kind and how to check a block", async () => {
  const room = createTestRoom({});
  try {
    const { state } = room.store;
    const text = buildBriefing({ state, agent: state.agents[0]!, agentCli: { command: "agoryx" } });
    assert.match(text, /Lead with the answer/);
    assert.match(text, /```viz claims block/);
    for (const kind of VIZ_KINDS) assert.match(text, new RegExp(`- ${kind} — `));
    assert.match(text, /agoryx viz check --body/);
    assert.match(text, /--agoryx-background/, "html pages learn the theme variables");
    assert.doesNotMatch(text, /plain text is still the default/);
  } finally {
    await room.cleanup();
  }
});

test("checking a block is one of the room's own tools", () => {
  const settings = buildClaudeSettings({ settings: DEFAULT_SETTINGS, env: {} });
  assert.ok(JSON.stringify(settings.permissions).includes("Bash(agoryx viz *)"));
});
