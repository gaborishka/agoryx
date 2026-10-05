import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentKey } from "../../internal/agora/actor.js";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import type { WorkflowRun } from "../../internal/agora/workflow-types.js";

const PHONE = "preview-phone.example.test";
const artifact = (marker: string) => `Artifact: index.html\n\`\`\`\n<!doctype html><button id="counter">0</button><script>document.getElementById("counter").onclick=function(){this.textContent=String(Number(this.textContent)+1)};</script><p>${marker}</p>\n\`\`\``;

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "agoryx-workflow-preview-"));
  const webDir = join(home, "web"); mkdirSync(webDir); writeFileSync(join(webDir, "index.html"), "<!doctype html><p>HOST_APPLICATION</p>");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const daemon = new AgoraDaemon({
    env: { ...process.env, AGORYX_HOME: join(home, "state"), AGORYX_JEV: "off", AGORYX_LIVE: "0" },
    webDir, port: 0, advertise: false, watchDays: 0, runners: {}, hosts: [PHONE],
    workflowCapability: async () => ({ available: true, backend: "test" }),
    workflowExecutor: async (input) => {
      if (input.phase === "answers") {
        if (input.participant.id === "reviewer") await Promise.race([gate, new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))]);
        return { text: artifact(input.prompt.includes("Second run") ? "SECOND_RUN_ARTIFACT" : "FIRST_RUN_ARTIFACT") };
      }
      if (input.phase === "peer_review") return { text: JSON.stringify({ critique: "Independent review" }) };
      if (input.phase === "dissent_audit") return { text: JSON.stringify({ summary: "All differences retained", missingDisagreements: [], unknowns: [] }) };
      return { text: "Plain text synthesis" };
    },
  });
  await daemon.start();
  const call = (path: string, options: { method?: string; token?: string | null; cookie?: string; host?: string; origin?: string; body?: unknown } = {}) => new Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined>; json(): any }>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body), token = options.token === undefined ? daemon.token : options.token;
    const req = request({ host: "127.0.0.1", port: daemon.port, path, method: options.method ?? "GET", headers: {
      host: options.host ?? `127.0.0.1:${daemon.port}`, ...(token ? { "x-agoryx-token": token } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.origin ? { origin: options.origin } : {}),
      ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
    } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers, json: () => JSON.parse(text) }));
    });
    req.on("error", reject); req.end(payload);
  });
  const created = await call("/api/rooms", { method: "POST", body: { name: "Preview test", mode: "chat", agents: [{ id: "author", kind: "codex", label: "Author" }, { id: "reviewer", kind: "claude", label: "Reviewer" }] } });
  assert.equal(created.status, 201); const room = created.json().room.id as string, path = `/api/rooms/${room}/workflow`;
  const start = async (task = "First run") => {
    const response = await call(`${path}/start`, { method: "POST", body: { mode: "council", task, criteria: ["Clear"], participantIds: ["author", "reviewer"] } });
    assert.equal(response.status, 201); return response.json().workflow as WorkflowRun;
  };
  const state = async () => (await call(path)).json().workflow as WorkflowRun;
  const wait = async (predicate: (run: WorkflowRun) => boolean) => {
    for (let n = 0; n < 200; n++) { const run = await state(); if (predicate(run)) return run; await new Promise((resolve) => setTimeout(resolve, 5)); }
    throw new Error("Preview fixture did not reach expected workflow state");
  };
  const preview = (runId: string, entryId: string) => `${path}/preview?${new URLSearchParams({ runId, entryId })}`;
  return { daemon, room, path, call, start, state, wait, preview, release, async close() { release(); await daemon.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("artifact documents require human auth and an atomically revealed visual entry", async () => {
  const f = await fixture();
  try {
    await f.start(); const sealed = await f.wait((run) => run.rounds.some((round) => round.entries.some((entry) => entry.participantId === "author" && entry.status === "complete")));
    const entryId = sealed.rounds[0]!.entries.find((entry) => entry.participantId === "author")!.id, url = f.preview(sealed.id, entryId);
    assert.equal((await f.call(url, { token: null })).status, 401);
    assert.equal((await f.call(url, { token: agentKey(f.daemon.token, f.room, "author") })).status, 403);
    const hidden = await f.call(url); assert.equal(hidden.status, 404); assert(!hidden.text.includes("FIRST_RUN_ARTIFACT"));
    assert.equal((await f.call(`${f.path}/preview`)).status, 400);
    assert.equal((await f.call(f.preview("unknown-run", entryId))).status, 404);
    assert.equal((await f.call(url, { method: "POST", body: {} })).status, 405);
    f.release(); const complete = await f.wait((run) => run.status === "completed");
    const visible = await f.call(url);
    assert.equal(visible.status, 200); assert.match(visible.headers["content-type"] as string, /^text\/html/);
    assert.equal(visible.headers["cache-control"], "no-store"); assert.equal(visible.headers["x-content-type-options"], "nosniff");
    const csp = visible.headers["content-security-policy"] as string;
    for (const rule of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data:", "font-src data:", "frame-src about:", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'", "sandbox allow-scripts"]) assert(csp.includes(rule), rule);
    assert(!csp.includes("allow-same-origin")); assert(!csp.includes("default-src 'self'"));
    assert(visible.text.includes("FIRST_RUN_ARTIFACT") && visible.text.includes("onclick=function()"));
    assert(visible.text.includes('sandbox="allow-scripts"') && visible.text.includes("srcdoc="));
    const synthesis = complete.rounds.find((round) => round.phase === "synthesis")!.entries[0]!;
    assert.equal((await f.call(f.preview(complete.id, synthesis.id))).status, 404, "plain text is not an executable document");
    assert.equal((await f.call(f.preview(complete.id, "unknown-entry"))).status, 404);
    const application = await f.call("/", { token: null });
    assert.match(application.headers["content-security-policy"] as string, /^default-src 'self'/);
    assert(!(application.headers["content-security-policy"] as string).includes("script-src 'unsafe-inline'"));
  } finally { await f.close(); }
});

test("preview URLs retain the selected history run and never cross room identity", async () => {
  const f = await fixture();
  try {
    f.release(); await f.start(); const first = await f.wait((run) => run.status === "completed");
    await f.start("Second run"); const second = await f.wait((run) => run.status === "completed");
    const previous = await f.call(f.preview(first.id, first.rounds[0]!.entries[0]!.id));
    assert.equal(previous.status, 200); assert(previous.text.includes("FIRST_RUN_ARTIFACT")); assert(!previous.text.includes("SECOND_RUN_ARTIFACT"));
    // Entry IDs are phase/participant identities and can repeat between runs. The
    // runId must select the right payload even when that entryId is identical.
    const current = await f.call(f.preview(second.id, first.rounds[0]!.entries[0]!.id));
    assert.equal(current.status, 200); assert(current.text.includes("SECOND_RUN_ARTIFACT")); assert(!current.text.includes("FIRST_RUN_ARTIFACT"));
    const other = await f.call("/api/rooms", { method: "POST", body: { name: "Other room", mode: "chat" } }); assert.equal(other.status, 201);
    const otherUrl = `/api/rooms/${other.json().room.id}/workflow/preview?${new URLSearchParams({ runId: first.id, entryId: first.rounds[0]!.entries[0]!.id })}`;
    assert.equal((await f.call(otherUrl)).status, 404);
  } finally { await f.close(); }
});

test("paired humans can preview revealed artifacts with scoped cookies until revoked", async () => {
  const f = await fixture();
  try {
    f.release(); await f.start(); const complete = await f.wait((run) => run.status === "completed"), url = f.preview(complete.id, complete.rounds[0]!.entries[0]!.id);
    const { code } = f.daemon.devices.createCode();
    const claim = await f.call("/api/pair/claim", { method: "POST", token: null, host: PHONE, origin: `https://${PHONE}`, body: { code } });
    assert.equal(claim.status, 201); const cookie = (claim.headers["set-cookie"] as string[])[0]!.split(";", 1)[0]!;
    const device = claim.json().device;
    assert.equal((await f.call(url, { token: null, host: PHONE, cookie })).status, 200);
    assert.equal((await f.call(url, { token: null, host: PHONE, cookie, origin: "https://other.example" })).status, 403);
    assert.equal((await f.call(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" })).status, 200);
    assert.equal((await f.call(url, { token: null, host: PHONE, cookie })).status, 401);
  } finally { await f.close(); }
});
