import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
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

/** The room's SSE frames, until `done` says so. */
const frames = (path: string, done: (frame: { event: string; data: any }) => boolean) => {
  const seen: Array<{ event: string; data: any }> = [];
  let req!: ReturnType<typeof request>;
  const until = new Promise<Array<{ event: string; data: any }>>((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`no such frame (got ${seen.map((frame) => frame.event).join(",")})`));
    }, 10_000);
    req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, "x-agoryx-token": daemon.token } }, (res) => {
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
          seen.push(frame);
          if (done(frame)) {
            clearTimeout(timer);
            req.destroy();
            resolve(seen);
          }
        }
      });
    });
    req.on("error", (error) => {
      if (!seen.length) reject(error);
    });
    req.end();
  });
  return { seen, until };
};

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-git-live-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  writeFileSync(join(home, "rules.json"), "[]");
  env = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_USER: "Ivan",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
    GIT_CEILING_DIRECTORIES: home,
  };
  daemon = new AgoraDaemon({
    env,
    port: 0,
    advertise: false,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });
  port = (await daemon.start()).port;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("git init in a room's folder reaches the open page at once: a step can then be committed without a reload", async () => {
  const folder = join(home, "plain");
  mkdirSync(folder);
  const created = await call("POST", "/api/rooms", { name: "Plain", dir: folder });
  assert.equal(created.status, 201, JSON.stringify(created.json()));
  const room = created.json().room as { id: string; workspace: string };
  assert.equal((await call("GET", `/api/rooms/${room.id}`)).json().gitRepo, false, "not a repository yet");
  const stream = frames(`/api/rooms/${room.id}/events`, (frame) => frame.event === "git");
  // The stream is open once its first presence frame is in.
  while (!stream.seen.some((frame) => frame.event === "presence")) await new Promise((resolve) => setTimeout(resolve, 20));
  execFileSync("git", ["init", "-q"], { cwd: room.workspace, env });
  const seen = await stream.until;
  assert.deepEqual(seen.at(-1), { event: "git", data: { gitRepo: true } });
  assert.equal((await call("GET", `/api/rooms/${room.id}`)).json().gitRepo, true);
});

test("a repository an agent makes around the folder during its turn is seen when the turn ends", async () => {
  const outer = join(home, "outer");
  const folder = join(outer, "app");
  mkdirSync(folder, { recursive: true });
  // No .git appears in the folder itself, so nothing there changes to watch: the turn's end asks.
  writeFileSync(join(home, "rules.json"), JSON.stringify([{ agent: "claude", match: "make it a repo", run: [["git", "init", "-q", outer]], reply: "done" }]));
  const created = await call("POST", "/api/rooms", { name: "Outer", dir: folder });
  assert.equal(created.status, 201, JSON.stringify(created.json()));
  const room = created.json().room as { id: string };
  assert.equal((await call("GET", `/api/rooms/${room.id}`)).json().gitRepo, false);
  const stream = frames(`/api/rooms/${room.id}/events`, (frame) => frame.event === "git");
  while (!stream.seen.some((frame) => frame.event === "presence")) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await call("POST", `/api/rooms/${room.id}/messages`, { text: "@claude make it a repo" })).status, 201);
  const seen = await stream.until;
  assert.deepEqual(seen.at(-1), { event: "git", data: { gitRepo: true } });
  const ended = seen.findIndex((frame) => frame.event === "room" && frame.data.event.type === "turn.ended");
  assert.ok(ended >= 0 && ended < seen.length - 1, "told after the turn ended");
});
