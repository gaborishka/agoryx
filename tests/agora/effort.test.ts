import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSwitch } from "../../ui/src/lib/effort.js";
import type { AgentModels } from "../../internal/agora/types.js";

const models: AgentModels = {
  claude: { models: [{ id: "opus", label: "Opus", efforts: ["low", "high", "max"] }, { id: "haiku", label: "Haiku", efforts: [] }], efforts: ["low", "medium", "high"] },
  codex: { models: [{ id: "gpt-5", label: "GPT-5" }], efforts: ["low", "medium", "high", "xhigh"] },
};

test("switching the model resets an effort the new model does not take, and keeps one it does", () => {
  assert.deepEqual(modelSwitch(models, { kind: "claude", effort: "max" }, "haiku"), { model: "haiku", effort: null }, "haiku takes no effort");
  assert.deepEqual(modelSwitch(models, { kind: "claude", effort: "max" }, null), { model: null, effort: null }, "the CLI's default takes the kind's levels");
  assert.deepEqual(modelSwitch(models, { kind: "claude", effort: "high" }, "opus"), { model: "opus" });
  assert.deepEqual(modelSwitch(models, { kind: "codex", effort: "xhigh" }, "gpt-5"), { model: "gpt-5" }, "a model without its own levels takes the kind's");
  assert.deepEqual(modelSwitch(models, { kind: "claude", effort: "max" }, "typed-model"), { model: "typed-model" }, "a model outside the list: nothing known, nothing reset");
  assert.deepEqual(modelSwitch(null, { kind: "claude", effort: "max" }, "haiku"), { model: "haiku" }, "no list yet");
  assert.deepEqual(modelSwitch(models, { kind: "claude" }, "haiku"), { model: "haiku" }, "no effort set");
});
