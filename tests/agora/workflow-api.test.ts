import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type Server, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgoraDaemon, type DaemonOptions } from "../../internal/agora/daemon.js";
import type { RoomEngine } from "../../internal/agora/engine.js";
import type { RoomStore } from "../../internal/agora/store.js";
import type { AgentRunner } from "../../internal/agora/runners/types.js";
import { claudeProjectKey } from "../../internal/agora/native.js";
import { agentKey } from "../../internal/agora/actor.js";
import type { WorkflowExecutionInput, WorkflowRun } from "../../internal/agora/workflow-types.js";

async function fixture(execute: (input: WorkflowExecutionInput) => Promise<{ text: string }>, available = true, runners: Partial<Record<"codex" | "claude", AgentRunner>> = {}, capability?: DaemonOptions["workflowCapability"]) {
  const home = mkdtempSync(join(tmpdir(), "agoryx-workflow-api-"));
  const daemon = new AgoraDaemon({
    env: { ...process.env, AGORYX_HOME: home, AGORYX_JEV: "off", AGORYX_LIVE: "0", CODEX_HOME: join(home, "codex-home"), CLAUDE_CONFIG_DIR: join(home, "claude-config") },
    port: 0, advertise: false, watchDays: 0, runners,
    workflowExecutor: execute,
    workflowCapability: capability ?? (async () => ({ available, backend: "test", reason: available ? undefined : "Sandbox unavailable" })),
  });
  await daemon.start();
  const call = async (method: string, path: string, body?: unknown, token = daemon.token) => {
    const response = await fetch(`${daemon.url}/api/${path}`, {
      method, headers: { "x-agoryx-token": token, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  const created = await call("POST", "rooms", { name: "Workflow test", agents: [
    { id: "author", kind: "codex", label: "Author", model: "selected-model" },
    { id: "reviewer", kind: "claude", label: "Reviewer" },
  ] });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const room = created.data.room.id as string;
  const path = `rooms/${room}/workflow`;
  const start = { mode: "council", task: "Choose a greeting", criteria: ["Clear"], participantIds: ["author", "reviewer"] };
  return { home, daemon, call, room, workspace: created.data.room.workspace as string, path, start, async close() { await daemon.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("workflow API seals all early results, derives roster models, and excludes room agents", async () => {
  const captured: WorkflowExecutionInput[] = [];
  let release!: (value: { text: string }) => void;
  const delayed = new Promise<{ text: string }>((resolve) => { release = resolve; });
  const f = await fixture(async (input) => {
    captured.push(input);
    return input.participant.id === "author" ? { text: "SECRET-EARLY-ANSWER" } : delayed;
  });
  try {
    const started = await f.call("POST", `${f.path}/start`, { ...f.start, participants: [{ model: "injected" }] });
    assert.equal(started.status, 201, JSON.stringify(started.data));
    const run = started.data.workflow as WorkflowRun;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(captured.length, 2, "blind participants launched together");
    assert.equal(captured[0]!.participant.model, "selected-model");
    const state = await f.call("GET", f.path);
    assert.equal(state.data.capabilities.isolation.available, true);
    assert.ok(!JSON.stringify(state.data.workflow).includes("SECRET-EARLY-ANSWER"));
    const nativeSnapshot = await f.call("GET", `rooms/${f.room}`);
    assert.ok(!JSON.stringify(nativeSnapshot.data).includes("SECRET-EARLY-ANSWER"));
    assert.equal(nativeSnapshot.data.state.turns.length, 0);
    const token = agentKey(f.daemon.token, f.room, "author");
    const workspaceIndex = await f.call("GET", "workflows");
    assert.equal(workspaceIndex.status, 200);
    assert.equal(workspaceIndex.data.workflows[0].id, run.id);
    assert.equal(workspaceIndex.data.workflows[0].participants, 2);
    assert.deepEqual(Object.keys(workspaceIndex.data.workflows[0]).sort(), ["id","roomId","mode","status","phase","task","createdAt","updatedAt","roomName","participants"].sort());
    assert.ok(!JSON.stringify(workspaceIndex.data).includes("SECRET-EARLY-ANSWER"));
    assert.equal((await f.call("GET", "workflows", undefined, token)).status, 403);

    const summary = (await f.call("GET", "rooms")).data.rooms.find((item: { id: string }) => item.id === f.room);
    assert.equal(summary.workflow.id, run.id);
    assert.equal(summary.running, true);
    assert.ok(!JSON.stringify(summary).includes("SECRET-EARLY-ANSWER"));
    const agentSummary = (await f.call("GET", "rooms", undefined, token)).data.rooms.find((item: { id: string }) => item.id === f.room);
    assert.equal(agentSummary.workflow, undefined);
    assert.equal((await f.call("GET", f.path, undefined, token)).status, 403);
    assert.equal((await f.call("GET", `${f.path}/history`, undefined, token)).status, 403);
    assert.equal((await f.call("POST", `${f.path}/stop`, { runId: run.id }, token)).status, 403);
    for (const action of ["messages", "continue", "table-assist", "mode", "project", "agents"]) {
      assert.equal((await f.call("POST", `rooms/${f.room}/${action}`, { text: "start chat", mode: "work" })).status, 409);
    }
    assert.equal((await f.call("POST", `${f.path}/stop`, { runId: "stale" })).status, 400);
    assert.equal((await f.call("POST", `${f.path}/stop`, { runId: run.id })).data.workflow.status, "cancelled");
    release({ text: "LATE-ANSWER" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(!JSON.stringify((await f.call("GET", f.path)).data.workflow).includes("LATE-ANSWER"));
  } finally { release?.({ text: "cancelled" }); await f.close(); }
});

test("workflow materials are frozen shared copies; traversal, external symlinks, and binary inputs are refused", async () => {
  const prompts: string[] = [];
  const f = await fixture(async (input) => {
    prompts.push(input.prompt);
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { text: "late response" };
  });
  try {
    writeFileSync(join(f.workspace, "example.ts"), "export const shared = 42;");
    writeFileSync(join(f.workspace, "image.bin"), Buffer.from([0, 255]));
    const outside = join(f.home, "private.txt");
    writeFileSync(outside, "PRIVATE-HOST-CONTENT");
    symlinkSync(outside, join(f.workspace, "outside.txt"));
    mkdirSync(join(f.workspace, ".agoryx"), { recursive: true });
    writeFileSync(join(f.workspace, ".agoryx", "trace.txt"), "PRIVATE-ROOM-TRACE");
    symlinkSync(join(f.workspace, ".agoryx", "trace.txt"), join(f.workspace, "trace-alias.txt"));
    for (const contextPaths of [["../private.txt"], [outside], ["outside.txt"], ["image.bin"], [".agoryx/state.json"], ["trace-alias.txt"], ["example.ts", "example.ts"]]) {
      const result = await f.call("POST", `${f.path}/start`, { ...f.start, contextPaths });
      assert.equal(result.status, 400, JSON.stringify({ contextPaths, result }));
    }
    assert.equal(prompts.length, 0);
    const result = await f.call("POST", `${f.path}/start`, { ...f.start, contextPaths: ["example.ts"] });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    writeFileSync(join(f.workspace, "example.ts"), "later change");
    assert.equal(result.data.workflow.context[0].text, "export const shared = 42;");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every((prompt) => prompt.includes("export const shared = 42;") && !prompt.includes("later change")));
    const history = await f.call("GET", `${f.path}/history`);
    assert.equal(history.data.workflows[0].id, result.data.workflow.id);
    await f.call("POST", `${f.path}/stop`, { runId: result.data.workflow.id });
  } finally { await f.close(); }
});

for (const action of ["messages", "table-assist"]) test(`an in-flight slow ${action} POST cannot cross the workflow start gate`, async () => {
  const f = await fixture(async (input) => {
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { text: "stopped" };
  });
  let slow: ReturnType<typeof request> | undefined;
  try {
    const response = new Promise<{ status: number; text: string }>((resolve, reject) => {
      slow = request(`${f.daemon.url}/api/rooms/${f.room}/${action}`, { method: "POST", headers: {
        "x-agoryx-token": f.daemon.token, "content-type": "application/json", "transfer-encoding": "chunked",
      } }, (res) => {
        let text = "";
        res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      });
      slow.on("error", reject);
      slow.write('{"text":');
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const started = await f.call("POST", `${f.path}/start`, f.start);
    assert.equal(started.status, 201, JSON.stringify(started.data));
    slow!.end('"must not launch a native turn"}');
    const reply = await response;
    assert.equal(reply.status, 409, reply.text);
    const snapshot = await f.call("GET", `rooms/${f.room}`);
    assert.ok(!JSON.stringify(snapshot.data.state.messages).includes("must not launch"));
    await f.call("POST", `${f.path}/stop`, { runId: started.data.workflow.id });
  } finally { slow?.destroy(); await f.close(); }
});

test("workflow API fails closed without isolation and rejects malformed inputs", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return { text: "unused" }; }, false);
  try {
    assert.equal((await f.call("POST", `${f.path}/start`, f.start)).status, 409);
    assert.equal(calls, 0);
    assert.equal((await f.call("GET", f.path)).data.workflow, null);
    assert.equal((await f.call("POST", `${f.path}/start`, null)).status, 400);
  } finally { await f.close(); }
  const g = await fixture(async () => { calls++; return { text: "unused" }; });
  try {
    for (const body of [
      { ...g.start, participantIds: ["missing", "reviewer"] },
      { ...g.start, participantIds: ["author", "author"] },
      { ...g.start, mode: "not-a-mode" },
      { ...g.start, roles: "invalid" },
      { ...g.start, budget: { timeoutMs: -1 } },
      { ...g.start, criteria: "Clear" },
    ]) assert.equal((await g.call("POST", `${g.path}/start`, body)).status, 400, JSON.stringify(body));
    assert.equal(calls, 0);
    assert.equal((await g.call("GET", g.path)).data.workflow, null);
  } finally { await g.close(); }
});

test("the existing room stop action stops isolated work and remains human-only", async () => {
  let aborted = 0;
  const f = await fixture(async (input) => {
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => { aborted++; resolve(); }, { once: true }));
    return { text: "cancelled" };
  });
  try {
    assert.equal((await f.call("POST", `${f.path}/start`, f.start)).status, 201);
    const token = agentKey(f.daemon.token, f.room, "author");
    assert.equal((await f.call("POST", `rooms/${f.room}/stop`, {}, token)).status, 403);
    assert.equal((await f.call("POST", `rooms/${f.room}/stop`, {})).status, 200);
    assert.equal((await f.call("GET", f.path)).data.workflow.status, "cancelled");
    assert.equal(aborted, 2);
  } finally { await f.close(); }
});


/** Exercise the same daemon-owned engine entrypoints that background reporters/native watchers call. */
const handleOf = (daemon: AgoraDaemon, roomId: string) => (daemon as unknown as { rooms: Map<string, { engine: RoomEngine; store: RoomStore }> }).rooms.get(roomId)!;
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Expected asynchronous state was not reached");
};
const reportTo = (engine: RoomEngine) => engine.postThreadReport("Child work is ready", { code: "thread.reported", room: "child", run: "child-run", name: "Child", reason: "quiet", agents: ["author"], files: [], uncommitted: 0, items: [], wakes: "author" });
const councilReply = (input: WorkflowExecutionInput) => input.phase === "peer_review" ? JSON.stringify({ critique: "Independent critique" }) : input.phase === "dissent_audit" ? JSON.stringify({ summary: "Dissent preserved", missingDisagreements: [], unknowns: [] }) : "Clear response";
const nativeCounter = (onCall: () => void): AgentRunner => ({ kind: "codex", resumeCommand: () => "", run: async () => { onCall(); return { status: "ok", text: "[PASS]", sessionId: null }; } });

test("automatic thread and native-session wakes wait for private work, then dispatch after cleanup", async () => {
  for (const source of ["thread", "native"] as const) {
    let nativeCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = await fixture(async (input) => {
      if (input.phase === "answers") await Promise.race([gate, new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))]);
      return { text: councilReply(input) };
    }, true, { codex: nativeCounter(() => nativeCalls++) });
    try {
      assert.equal((await f.call("POST", `${f.path}/start`, f.start)).status, 201);
      const handle = handleOf(f.daemon, f.room);
      if (source === "thread") reportTo(handle.engine);
      else {
        const dir = join(f.home, "claude-config", "projects", claudeProjectKey(f.workspace));
        mkdirSync(dir, { recursive: true });
        handle.store.append({ type: "session.bound", agent: "reviewer", sessionId: "external-session" });
        writeFileSync(join(dir, "external-session.jsonl"), [
          { type: "user", uuid: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: "@author please inspect this native result" } },
          { type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "My result is ready." }] } },
        ].map((line) => JSON.stringify(line)).join("\n") + "\n");
        handle.engine.syncNative();
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(nativeCalls, 0, `${source}: no native worker may cross the workflow lease`);
      assert.equal(handle.store.state.turns.length, 0);
      release();
      await until(() => nativeCalls === 1);
      await handle.engine.waitIdle();
      assert.equal((await f.call("GET", f.path)).data.workflow.status, "completed");
      assert.equal(nativeCalls, 1, `${source}: queued wake resumes exactly once`);
    } finally { release(); await f.close(); }
  }
});

test("generic room Stop clears queued native wakes without dispatching them during private cleanup", async () => {
  let nativeCalls = 0;
  const f = await fixture(async (input) => {
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { text: "cancelled" };
  }, true, { codex: nativeCounter(() => nativeCalls++) });
  try {
    assert.equal((await f.call("POST", `${f.path}/start`, f.start)).status, 201);
    const handle = handleOf(f.daemon, f.room);
    reportTo(handle.engine);
    assert.equal((await f.call("POST", `rooms/${f.room}/stop`, {})).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(nativeCalls, 0);
    assert.equal(handle.store.state.runs.at(-1)!.status, "ended");
    assert.equal((await f.call("GET", f.path)).data.workflow.status, "cancelled");
  } finally { await f.close(); }
});

test("one damaged persisted workflow does not block healthy rooms on restart", async () => {
  const f = await fixture(async (input) => ({ text: councilReply(input) }));
  let recovered: AgoraDaemon | undefined;
  try {
    const healthy = (await f.call("POST", "rooms", { name: "Healthy room", mode: "chat" })).data.room.id as string;
    assert.equal((await f.call("POST", `${f.path}/start`, f.start)).status, 201);
    await until(async () => (await f.call("GET", f.path)).data.workflow.status === "completed");
    await f.daemon.close();
    writeFileSync(join(f.home, "workflows", f.room, "workflow", "state.json"), '{"PRIVATE-CONTENT":"broken');
    recovered = new AgoraDaemon({ env: { ...process.env, AGORYX_HOME: f.home, AGORYX_JEV: "off" }, port: 0, advertise: false, watchDays: 0, runners: {}, workflowCapability: async () => ({ available: true }) });
    await recovered.start();
    const call = async (path: string) => {
      const response = await fetch(`${recovered!.url}/api/${path}`, { headers: { "x-agoryx-token": recovered!.token } });
      return { status: response.status, data: await response.json() as Record<string, any> };
    };
    const listed = await call("rooms");
    assert.equal(listed.status, 200);
    assert.equal(listed.data.rooms.length, 2);
    assert.match(listed.data.rooms.find((r: { id: string }) => r.id === f.room).workflowError, /needs recovery/);
    assert.equal(listed.data.rooms.find((r: { id: string }) => r.id === healthy).workflowError, undefined);
    assert.equal((await call(`rooms/${healthy}`)).status, 200);
    const failed = await call(f.path);
    assert.equal(failed.status, 500, "affected workflow remains fail-closed");
    assert.ok(!JSON.stringify(listed.data).includes("PRIVATE-CONTENT"));
    assert.ok(!JSON.stringify(failed.data).includes("PRIVATE-CONTENT"));
  } finally { await recovered?.close(); await f.close(); }
});


test("a delayed capability probe cannot launch private work after shutdown begins", async () => {
  let probeStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const f = await fixture(async () => { calls++; return { text: "must not execute" }; }, true, {}, async () => {
    probeStarted = true;
    await gate;
    return { available: true };
  });
  try {
    const start = f.call("POST", `${f.path}/start`, f.start);
    await until(() => probeStarted);
    const stopping = f.daemon.close();
    release();
    const response = await start;
    assert.equal(response.status, 503, JSON.stringify(response.data));
    await stopping;
    assert.equal(calls, 0);
  } finally { release(); await f.close(); }
});

test("a delayed capability probe cannot continue on a replaced room engine", async () => {
  let probeStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const f = await fixture(async () => { calls++; return { text: "must not execute" }; }, true, {}, async () => {
    probeStarted = true;
    await gate;
    return { available: true };
  });
  try {
    const start = f.call("POST", `${f.path}/start`, f.start);
    await until(() => probeStarted);
    const switched = await f.call("POST", `rooms/${f.room}/mode`, { mode: "chat" });
    assert.equal(switched.status, 200, JSON.stringify(switched.data));
    release();
    const response = await start;
    assert.equal(response.status, 409, JSON.stringify(response.data));
    assert.equal(calls, 0);
  } finally { release(); await f.close(); }
});


test("a slow tournament-selection body cannot launch implementation after shutdown begins", async () => {
  let implementations = 0;
  const f = await fixture(async (input) => {
    if (input.phase === "implementation") implementations++;
    const text = input.phase === "evaluation"
      ? JSON.stringify({ ranking: [...input.prompt.matchAll(/^(Answer [A-H]):$/gm)].map((match) => match[1]), feedback: "Compared the common criteria" })
      : "Self-contained prototype";
    return { text };
  });
  let slow: ReturnType<typeof request> | undefined;
  const server = (f.daemon as unknown as { server: Server }).server;
  let bodyStarted!: () => void;
  const readingBody = new Promise<void>((resolve) => { bodyStarted = resolve; });
  const observe = (req: IncomingMessage) => {
    if (req.url !== `/api/${f.path}/action`) return;
    // Observe readBody attaching its reader without making the request flow before authentication.
    const readerAttached = (event: string | symbol) => {
      if (event !== "data") return;
      req.off("newListener", readerAttached);
      queueMicrotask(bodyStarted);
    };
    if (req.listenerCount("data")) queueMicrotask(bodyStarted);
    else req.on("newListener", readerAttached);
  };
  try {
    assert.equal((await f.call("POST", `rooms/${f.room}/agents`, { agent: { id: "judge", kind: "codex", label: "Judge" } })).status, 201);
    const started = await f.call("POST", `${f.path}/start`, { ...f.start, mode: "tournament", participantIds: ["author", "reviewer", "judge"] });
    assert.equal(started.status, 201, JSON.stringify(started.data));
    await until(async () => (await f.call("GET", f.path)).data.workflow.status === "waiting_user");
    const workflow = (await f.call("GET", f.path)).data.workflow as WorkflowRun;
    const body = JSON.stringify({ type: "select", runId: workflow.id, entryIds: [workflow.rounds[0]!.entries[0]!.id] });
    server.on("request", observe);
    const reply = new Promise<{ status: number; text: string }>((resolve, reject) => {
      slow = request(`${f.daemon.url}/api/${f.path}/action`, { method: "POST", headers: {
        "x-agoryx-token": f.daemon.token, "content-type": "application/json", "transfer-encoding": "chunked",
      } }, (response) => {
        let text = "";
        response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, text }));
      });
      slow.on("error", reject);
      slow.write(body.slice(0, -1));
    });
    await readingBody;
    const stopping = f.daemon.close();
    slow!.end(body.slice(-1));
    const result = await reply;
    assert.equal(result.status, 503, result.text);
    await stopping;
    assert.equal(implementations, 0, "the human decision must not start a worker after shutdown disposal");
  } finally { server.off("request", observe); slow?.destroy(); await f.close(); }
});

test("workspace index preserves earlier modes and contains no worker payloads", async () => {
  const f=await fixture(async(input)=>{
    await new Promise<void>(resolve=>{if(input.signal.aborted)resolve();else input.signal.addEventListener('abort',()=>resolve(),{once:true});});
    return {text:'PRIVATE-WORKER-PAYLOAD'};
  });
  try{
    const first=await f.call('POST',`${f.path}/start`,f.start);
    assert.equal(first.status,201);
    await f.call('POST',`${f.path}/stop`,{runId:first.data.workflow.id});
    // Cancellation drains the execution before another run can start.
    let second:{status:number;data:Record<string,any>}|undefined;
    for(let attempt=0;attempt<30;attempt++){
      second=await f.call('POST',`${f.path}/start`,{...f.start,mode:'verification',task:'Review the greeting',roles:{author:'author',reviewer:'reviewer'}});
      if(second.status===201)break;
      assert.match(String(second.data.error),/stopping/);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(second?.status,201,JSON.stringify(second));
    const index=await f.call('GET','workflows');
    assert.equal(index.status,200);
    assert.equal(index.data.workflows.length,2);
    assert.deepEqual(new Set(index.data.workflows.map((r:any)=>r.mode)),new Set(['council','verification']));
    assert.ok(index.data.workflows.every((r:any)=>r.roomId===f.room));
    assert.ok(!JSON.stringify(index.data).includes('PRIVATE-WORKER-PAYLOAD'));
    assert.ok(index.data.workflows.every((r:any)=>!('rounds' in r)&&!('context' in r)&&!('report' in r)));
  } finally {await f.close();}
});


test("workflow API resolves selected conversation messages itself and freezes them before private execution", async () => {
  const prompts: string[] = [];
  const f = await fixture(async input => {
    prompts.push(input.prompt);
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return { text: "stopped" };
  });
  try {
    const store = (f.daemon as unknown as { rooms: Map<string, { store: RoomStore }> }).rooms.get(f.room)!.store;
    store.append({ type: "message.posted", message: { id: "m1", author: "Human", kind: "human", text: "Selected conversation evidence", mentions: [], wakes: false } });
    store.append({ type: "message.posted", message: { id: "m2", author: "Human", kind: "human", text: "Unselected conversation secret", mentions: [], wakes: false } });
    assert.equal((await f.call("POST", `${f.path}/start`, { ...f.start, messageIds: ["not-here"] })).status, 400);
    const started = await f.call("POST", `${f.path}/start`, { ...f.start, messageIds: ["m1"] });
    assert.equal(started.status, 201, JSON.stringify(started.data));
    assert.match(started.data.workflow.context[0].text, /Selected conversation evidence/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every(prompt => prompt.includes("Selected conversation evidence") && !prompt.includes("Unselected conversation secret")));
    await f.call("POST", `${f.path}/stop`, { runId: started.data.workflow.id });
  } finally { await f.close(); }
});
