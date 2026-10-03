import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { roomsDir } from "../../internal/agora/paths.js";
import { createRoom, openEngine } from "../../internal/agora/service.js";
import { RoomStore } from "../../internal/agora/store.js";
import { writeFakeBins } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");

/** A home with fake agents, a git repo, a Work room in it and a thread of that room. */
const setUp = (prefix: string, rules: Array<{ agent: string; match: string; reply: string }>) => {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    AGORYX_HOME: join(home, "agora"),
    AGORYX_USER: "Ivan",
    AGORYX_LIVE: "0",
    AGORYX_CLAUDE_BIN: fakeClaude,
    AGORYX_CODEX_BIN: fakeCodex,
    FAKE_LOG: join(home, "fake.log"),
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: join(home, "rules.json"),
    FAKE_MARKS: home,
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
  };
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const parent = createRoom({ name: "Main", dir: repo, mode: "work", agents: [{ kind: "claude" }], env });
  const thread = createRoom({ name: "Look", from: parent.id, env });
  const say = (room: string, text: string) => spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "cmd/agoryx/main.ts"), "say", "-r", room, text], { cwd: ROOT, encoding: "utf8", env, timeout: 60_000 });
  const reports = () => RoomStore.open(roomsDir(env), parent.id).state.messages.filter((message) => message.sys?.code === "thread.reported");
  return { home, env, parent, thread, say, reports };
};

test("a thread driven without the daemon still reports its run to the room it was started from", () => {
  const { home, thread, say, reports } = setUp("agora-thread-local-", [{ agent: "claude", match: "LOCAL-BRIEF", reply: "Looked, nothing to change." }]);
  try {
    const said = say(thread.id, "LOCAL-BRIEF: look around");
    assert.equal(said.status, 0, said.stderr);
    const report = reports()[0];
    assert.ok(report, `the parent got the report (stderr: ${said.stderr})`);
    assert.match(report.text, /Thread "Look" .* went quiet\./);
    assert.match(report.text, /Looked, nothing to change\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a thread's report for a room another process drives waits, and goes in once when that room is next driven", async () => {
  const { home, env, parent, thread, say, reports } = setUp("agora-thread-held-", [
    { agent: "claude", match: "HELD-BRIEF", reply: "Looked while it was held." },
    { agent: "claude", match: "AFTER", reply: "Back." },
  ]);
  try {
    // Held by this process, as by a terminal that drives it.
    const store = RoomStore.open(roomsDir(env), parent.id);
    const elsewhere = openEngine(store, { env, runners: {} });
    const said = say(thread.id, "HELD-BRIEF: look");
    assert.equal(said.status, 0, said.stderr);
    assert.equal(reports().length, 0, "not while the room is held");
    assert.equal(readdirSync(join(store.dir, "reports-waiting")).filter((name) => name.endsWith(".json")).length, 1, "kept, not dropped");
    await elsewhere.close();

    const after = say(parent.id, "AFTER: anything new?");
    assert.equal(after.status, 0, after.stderr);
    const got = reports();
    assert.equal(got.length, 1, "posted once");
    assert.match(got[0]!.text, /Looked while it was held\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
