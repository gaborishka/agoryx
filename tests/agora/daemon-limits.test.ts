import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { readLimits } from "../../internal/agora/limits-store.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import type { LimitSnapshot } from "../../internal/agora/types.js";
import type { RoomUsage } from "../../internal/agora/usage.js";
import { writeFakeBins } from "./helpers.js";

let home: string;
let env: NodeJS.ProcessEnv;
let daemon: AgoraDaemon;
let port: number;

const call = (method: string, path: string, body?: unknown): Promise<{ status: number; json: () => any }> =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          "x-agoryx-token": daemon.token,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });

/** SSE frames until the room's run ends. */
const untilRunEnds = (path: string) =>
  new Promise<Array<{ event: string; data: any }>>((resolve, reject) => {
    const frames: Array<{ event: string; data: any }> = [];
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`the run did not end (got ${frames.map((frame) => frame.event).join(",")})`));
    }, 20_000);
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, "x-agoryx-token": daemon.token } }, (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (!event || !data) continue;
          const frame = { event, data: JSON.parse(data) };
          frames.push(frame);
          if (event === "room" && frame.data.event.type === "run.ended") {
            clearTimeout(timer);
            req.destroy();
            resolve(frames);
          }
        }
      });
    });
    req.on("error", (error) => {
      if (!frames.length) reject(error);
    });
    req.end();
  });

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-daemon-limits-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  writeFileSync(join(home, "rules.json"), "[]");
  env = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_USER: "Ivan",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    FAKE_RATE_LIMITS: JSON.stringify({ used: 30, resetsAt: Math.floor(Date.now() / 1000) + 7200 }),
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  daemon = new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    opsPollMs: 50,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("the daemon keeps what each CLI said about its limits, streams it, and reads a room's wakes back", async () => {
  assert.deepEqual((await call("GET", "/api/limits")).json(), { limits: [] });
  const created = await call("POST", "/api/rooms", { name: "Limits" });
  assert.equal(created.status, 201);
  const room = created.json().room as { id: string };
  const frames = untilRunEnds(`/api/rooms/${room.id}/events?after=0`);
  assert.equal((await call("POST", `/api/rooms/${room.id}/messages`, { text: "Hello both" })).status, 201);
  const limitFrames = (await frames).filter((frame) => frame.event === "limits");
  assert.ok(limitFrames.length >= 1, "limits reach the open room's stream");

  const { limits } = (await call("GET", "/api/limits")).json() as { limits: LimitSnapshot[] };
  assert.deepEqual(limits.map((entry) => [entry.kind, entry.account]).sort(), [
    ["claude", env.CLAUDE_CONFIG_DIR],
    ["codex", env.CODEX_HOME],
  ]);
  assert.equal(limits.find((entry) => entry.kind === "claude")!.windows[0]!.usedPercent, 30);
  // Kept on disk: a daemon started again reads the same.
  assert.deepEqual(readLimits(env), limits);
  const snapshot = (await call("GET", `/api/rooms/${room.id}`)).json();
  assert.deepEqual(snapshot.limits, limits);

  const usage = (await call("GET", `/api/rooms/${room.id}/usage`)).json() as RoomUsage;
  const turns = snapshot.state.turns as Array<{ agent: string; status: string; durationMs: number }>;
  assert.equal(usage.total.turns, turns.length);
  for (const agent of usage.agents) {
    const own = turns.filter((turn) => turn.agent === agent.agent);
    assert.equal(agent.wakes, own.length);
    assert.equal(agent.outcomes.replied.turns, own.filter((turn) => turn.status === "ok").length);
    assert.equal(agent.outcomes.passed.turns, own.filter((turn) => turn.status === "pass").length);
    assert.equal(agent.total.ms, own.reduce((sum, turn) => sum + turn.durationMs, 0));
    assert.equal(agent.wokenBy.Ivan, 1);
  }
  assert.equal((await call("GET", "/api/rooms/nope/usage")).status, 404);
});
