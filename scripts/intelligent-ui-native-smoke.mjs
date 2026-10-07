#!/usr/bin/env node
/** Opt-in integration check. Uses actual signed-in native providers on synthetic, disposable context only. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgoraDaemon } from "../dist/internal/agora/daemon.js";
import { defaultRunners } from "../dist/internal/agora/service.js";
import { RoomStore } from "../dist/internal/agora/store.js";
import { prepareTableOp } from "../dist/internal/agora/table.js";
import { tableAssistRequests } from "../dist/internal/agora/table-assist.js";
import { defaultUIValues, evaluateUI, parseIntelligentUI } from "../dist/internal/agora/intelligent-ui.js";
import { DEFAULT_SETTINGS } from "../dist/internal/agora/types.js";
import { BRIEFING_VERSION } from "../dist/internal/agora/prompts.js";

if (!process.argv.includes("--run")) {
  console.log("Opt-in real-provider check: node scripts/intelligent-ui-native-smoke.mjs --run [--provider codex|claude] [--one-shot]. Default: persistent native runtime. Uses your native sign-ins and model quota, synthetic context, isolated state. Does not publish a release.");
  process.exit(0);
}
const requested = process.argv[process.argv.indexOf("--provider") + 1];
const providers = process.argv.includes("--provider") ? [requested] : ["codex", "claude"];
assert.ok(providers.every(p => ["codex", "claude"].includes(p)), "provider must be codex or claude");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "agoryx-native-ui-"));
const env = { ...process.env, AGORYX_HOME: home, AGORYX_USER: "Smoke tester", AGORYX_LIVE: process.argv.includes("--one-shot") ? "0" : "1", AGORYX_UPDATE_CHECK: "off" };
// Do not inherit a surrounding room's identity, ops destination or execution workspace.
for (const key of Object.keys(env)) if (key.startsWith("AGORYX_") && !["AGORYX_HOME", "AGORYX_USER", "AGORYX_LIVE", "AGORYX_UPDATE_CHECK", "AGORYX_CODEX_BIN", "AGORYX_CLAUDE_BIN"].includes(key)) delete env[key];
const results = [];
const transport = Object.fromEntries(providers.map(provider => [provider, { liveProcesses: 0, liveTurns: 0, oneShotTurns: 0 }]));
const native = defaultRunners(env);
const runners = Object.fromEntries(providers.map(provider => [provider, {
  kind: provider, resumeCommand: (...args) => native[provider].resumeCommand(...args),
  run: (...args) => { transport[provider].oneShotTurns++; return native[provider].run(...args); },
  liveFingerprint: request => native[provider].liveFingerprint(request),
  openLive: request => {
    transport[provider].liveProcesses++;
    const proc = native[provider].openLive(request);
    return { get fingerprint() { return proc.fingerprint; }, get sessionId() { return proc.sessionId; }, get alive() { return proc.alive; },
      runTurn: (...args) => { transport[provider].liveTurns++; return proc.runTurn(...args); }, close: () => proc.close() };
  },
}]));
let daemon, base;
const start = async () => {
  daemon = new AgoraDaemon({ port: 0, advertise: false, env, runners, webDir: join(root, "ui/dist"), opsPollMs: 30 });
  const { port } = await daemon.start(); base = `http://127.0.0.1:${port}`;
};
const call = async (path, body) => {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "x-agoryx-token": daemon.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error ?? "request failed"}`);
  return data;
};
const request = async (roomId, provider, guidance, target, phase) => {
  const nonce = `native-${provider}-${phase}-${Date.now()}`;
  await call(`/api/rooms/${roomId}/table-assist`, { kind: "tool", agent: provider, nonce, guidance, ...(target ? { target } : {}) });
  const deadline = Date.now() + 300_000;
  let nextProgress = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await call(`/api/rooms/${roomId}`);
    const receipt = tableAssistRequests(snapshot.state, snapshot.ops).find(item => item.nonce === nonce);
    if (receipt && !["queued", "running"].includes(receipt.status)) {
      assert.equal(receipt.status, "ready", `${provider} ${phase}: ${receipt.status}`);
      const tool = snapshot.state.table.components.find(component => receipt.refs.includes(component.id) && component.kind === "interactive");
      assert.ok(tool?.ui, "request must publish a real interactive component");
      parseIntelligentUI(tool.ui, tool.refs);
      const turn = snapshot.state.turns.find(turn => turn.id === receipt.turnId);
      console.log(`${provider}: ${phase} ready (${tool.id}, resumed=${!!turn?.resume})`);
      return { snapshot, tool, turn };
    }
    if (Date.now() > nextProgress) { console.log(`${provider}: ${phase} ${receipt?.status ?? "waiting"}`); nextProgress = Date.now() + 30_000; }
    await delay(500);
  }
  await call(`/api/rooms/${roomId}/stop`, {});
  throw new Error(`${provider} ${phase}: deadline exceeded`);
};
const hasReactiveEstimate = (ui) => {
  const values = defaultUIValues(ui);
  const probes = [{ work_units: 48, capacity: 8, expected: 6 }, { work_units: 60, capacity: 12, expected: 5 }, { work_units: 48, capacity: 12, expected: 4 }];
  const metrics = [];
  const visit = node => {
    if (node.type === "metric") metrics.push(node);
    if (node.children) node.children.forEach(visit);
    if (node.tabs) node.tabs.forEach(tab => tab.children.forEach(visit));
    if (node.sections) node.sections.forEach(section => section.children.forEach(visit));
  };
  visit(ui.root);
  return metrics.some(metric => probes.every(probe => evaluateUI(metric.value, { ...values, work_units: probe.work_units, capacity: probe.capacity }) === probe.expected));
};
console.log(`Native UI smoke · synthetic context only · evidence ${home}`);
try {
  for (const provider of providers) {
    const workspace = join(home, `${provider}-workspace`); mkdirSync(workspace);
    const store = RoomStore.create(join(home, "rooms"), { name: `Native Intelligent UI smoke · ${provider}`, mode: "chat", workspace, createdWorkspace: false, human: "Smoke tester", agents: [{ id: provider, kind: provider, label: provider, profile: false }], settings: { ...DEFAULT_SETTINGS, budget: 1, network: false, turnTimeoutMs: 240_000 } });
    store.append({ type: "table.op", op: prepareTableOp(store.state.table, { op: "fact", text: "Synthetic scenario, not real delivery evidence: work_units=48, capacity=8 units/day; estimated days=work_units/capacity, assuming perfect parallelism. Only this disposable workspace is in scope. No external research or personal files are needed." }, "Smoke tester", true) });
    await start();
    const first = await request(store.id, provider, "Create a useful native interactive delivery explorer from F1. Use number input IDs work_units (12..120, default48) and capacity (2..16, default8). Include a metric for estimated days = work_units/capacity, a chart and an assumptions view. Design it clearly; cite F1. All content is synthetic. Use the CLI preflight before publishing. Do not inspect files outside this disposable workspace.", undefined, "create");
    assert.equal(first.tool.by, provider);
    const values = { ...defaultUIValues(first.tool.ui), work_units: 60, capacity: 10 };
    assert.ok(hasReactiveEstimate(first.tool.ui), "the same generated metric must react correctly across three distinct input probes");
    const saved = await call(`/api/rooms/${store.id}/table`, { op: "component-input", target: first.tool.id, revision: first.tool.contentSeq, inputSeq: 0, values, name: "Saved smoke scenario", nonce: `native-save-${provider}` });
    assert.equal(saved.table.components.find(c => c.id === first.tool.id).inputSnapshot.by, "Smoke tester");
    const refined = await request(store.id, provider, `Read ${first.tool.id} and its saved scenario. Refine this same tool in place: carry the saved work_units=60 and capacity=10 into the new defaults, retain their IDs, add a timeline or progress section, and clearly explain the model assumptions. Keep the estimated-days metric. Do not make a decision or claim real evidence.`, first.tool.id, "refine");
    assert.equal(refined.tool.id, first.tool.id); assert.ok(refined.tool.contentSeq > first.tool.contentSeq);
    assert.equal(refined.turn?.resume, true, "ordinary refinement must exercise a resumed native session");
    assert.ok(hasReactiveEstimate(refined.tool.ui), "refinement must preserve the reactive estimate");
    assert.equal(defaultUIValues(refined.tool.ui).work_units, 60); assert.equal(defaultUIValues(refined.tool.ui).capacity, 10);
    assert.ok(refined.tool.scenarios.some(scenario => scenario.name === "Saved smoke scenario"));
    const binding = refined.snapshot.state.sessions[provider];
    assert.ok(binding?.sessionId, "provider must establish a resumable native session");
    await daemon.close(); daemon = undefined;
    // Simulate an existing pre-feature binding only after our daemon has released the room.
    const old = RoomStore.open(join(home, "rooms"), store.id);
    old.append({ type: "session.bound", agent: provider, sessionId: binding.sessionId, briefingVersion: 3 });
    await start();
    const migrated = await request(store.id, provider, `Refine ${first.tool.id} in place. Preserve the current input defaults and the estimated-days metric; add a short callout explaining that saved scenario history preserves previous model versions. This is synthetic UI smoke validation only.`, first.tool.id, "legacy-upgrade");
    assert.equal(migrated.tool.id, first.tool.id);
    assert.equal(migrated.snapshot.state.sessions[provider].briefingVersion, BRIEFING_VERSION);
    assert.equal(migrated.turn?.resume, false, "an old briefing must receive a fresh native context");
    if (env.AGORYX_LIVE === "1") {
      assert.equal(transport[provider].oneShotTurns, 0, "the default runtime must not silently fall back to one-shot execution");
      assert.equal(transport[provider].liveTurns, 3);
      assert.equal(transport[provider].liveProcesses, 2, "create and ordinary refinement must reuse a process; migration starts another");
    }
    writeFileSync(join(home, `${provider}-generated-tool.json`), JSON.stringify(migrated.tool.ui, null, 2));
    results.push({ provider, transport: transport[provider], create: "passed", reactiveMetric: "passed", save: "passed", refine: "passed", resumed: !!refined.turn?.resume, legacyUpgrade: "passed", briefingVersion: BRIEFING_VERSION });
    await daemon.close(); daemon = undefined;
  }
  writeFileSync(join(home, "report.json"), JSON.stringify({ results, synthetic: true }, null, 2));
  console.log(JSON.stringify({ results, evidence: home }));
} catch (error) {
  writeFileSync(join(home, "report.json"), JSON.stringify({ results, error: error instanceof Error ? error.message : String(error), synthetic: true }, null, 2));
  console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
} finally { if (daemon) await daemon.close(); }
