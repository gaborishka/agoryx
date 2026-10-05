import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgoraDaemon } from "../../internal/agora/daemon.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { writeFakeBins } from "./helpers.js";

let home: string;
let daemon: AgoraDaemon;
let url: string;

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "x-agoryx-token": daemon.token, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

const snapshot = async (room: string) => (await call("GET", `/api/rooms/${room}`)).body.state;

const waitFor = async <T>(check: () => Promise<T | undefined | null | false>, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const got = await check();
    if (got) return got;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition not met in time");
};

const quiet = (room: string) =>
  waitFor(async () => {
    const state = await snapshot(room);
    return state.turns.length > 0 && state.runs.every((run: any) => run.status === "ended") && !state.turns.some((turn: any) => turn.status === "running");
  });

before(async () => {
  home = mkdtempSync(join(tmpdir(), "agora-overview-"));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  const env = {
    ...process.env,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_USER: "Ivan",
    AGORYX_LIVE: "0",
    AGORYX_ACK_MS: "60000",
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  writeFileSync(join(home, "rules.json"), "[]");
  daemon = new AgoraDaemon({ env, port: 0, opsPollMs: 50, runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) } });
  url = (await daemon.start()).url;
});

after(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

test("a project's overview: its library by path, its threads with their reports, and its rooms' usage summed", async () => {
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  // A chart an agent plotted outside the folder, and one that is gone by now.
  mkdirSync(join(home, "out"));
  const chart = join(home, "out", "chart.png");
  writeFileSync(chart, "png");
  const gone = join(home, "out", "gone.svg");
  writeFileSync(
    join(home, "rules.json"),
    JSON.stringify([
      { agent: "claude", match: "OVERVIEW-GO", write: [{ path: "PLAN.md", content: "# Plan\n" }], reply: `Plotted it: ![chart](${chart})\nOld one: ![old](${gone})` },
      { agent: "claude", match: "SIDE-BRIEF", reply: "Side done." },
    ]),
  );
  const upload = (await call("POST", "/api/uploads", { name: "notes.txt", data: Buffer.from("notes").toString("base64") })).body.path as string;
  const parent = (await call("POST", "/api/rooms", { name: "Main", dir: repo, mode: "work", doc: "PLAN.md", agents: [{ kind: "claude" }], text: `See [notes.txt](${upload}) OVERVIEW-GO` })).body.room;
  await quiet(parent.id);
  const thread = (await call("POST", "/api/rooms", { name: "Side", from: parent.id, text: "SIDE-BRIEF" })).body.room;
  await waitFor(async () => (await snapshot(parent.id)).messages.some((m: any) => m.sys?.code === "thread.reported"));

  const project = parent.projectHash ?? (await call("GET", "/api/rooms")).body.rooms.find((r: any) => r.id === parent.id).projectHash;
  const got = await call("GET", `/api/projects/${project}/overview`);
  assert.equal(got.status, 200, JSON.stringify(got.body));
  const { library, threads, usage, rawBase } = got.body;

  const byPath = new Map(library.map((entry: any) => [entry.path, entry]));
  const doc: any = byPath.get("PLAN.md");
  assert.equal(doc.kind, "doc");
  assert.equal(doc.room, parent.id);
  assert.equal(doc.by, "Claude");
  assert.ok(doc.revisions >= 1);
  assert.equal(doc.exists, true);
  const file: any = byPath.get(upload);
  assert.equal(file.kind, "upload");
  assert.equal(file.by, "Ivan");
  assert.equal(file.exists, true);
  const media: any = byPath.get(chart);
  assert.deepEqual([media.kind, media.by, media.room, media.exists], ["media", "Claude", parent.id, true]);
  assert.equal((byPath.get(gone) as any).exists, false);
  // Nothing was copied: the upload is where it was saved, the chart where the agent left it.
  assert.ok(upload.startsWith(join(home, "agora", "uploads")));

  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, thread.id);
  assert.equal(threads[0].parentName, "Main");
  assert.deepEqual(threads[0].agents, ["Claude"]);
  assert.equal(threads[0].branch, "agoryx/side");
  assert.equal(threads[0].report.reason, "quiet");
  assert.deepEqual(threads[0].report.last, { by: "Claude", text: "Side done." });

  assert.equal(usage.total.turns, 2);
  assert.equal(usage.threads.turns, 1);
  assert.equal(usage.byKind.claude.turns, 2);
  assert.deepEqual(usage.rooms.map((room: any) => room.id).sort(), [parent.id, thread.id].sort());
  assert.ok(rawBase[parent.id].startsWith(`/raw/${parent.id}/`));

  assert.equal((await call("GET", `/api/projects/${project}/nothing`)).status, 404);
});
