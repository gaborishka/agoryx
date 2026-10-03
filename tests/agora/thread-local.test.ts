import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { roomsDir } from "../../internal/agora/paths.js";
import { createRoom } from "../../internal/agora/service.js";
import { RoomStore } from "../../internal/agora/store.js";
import { writeFakeBins } from "./helpers.js";

const ROOT = resolve(import.meta.dirname, "../..");

test("a thread driven without the daemon still reports its run to the room it was started from", () => {
  const home = mkdtempSync(join(tmpdir(), "agora-thread-local-"));
  try {
    const { fakeClaude, fakeCodex } = writeFakeBins(home);
    writeFileSync(join(home, "rules.json"), JSON.stringify([{ agent: "claude", match: "LOCAL-BRIEF", reply: "Looked, nothing to change." }]));
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

    const said = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "cmd/agoryx/main.ts"), "say", "-r", thread.id, "LOCAL-BRIEF: look around"], { cwd: ROOT, encoding: "utf8", env, timeout: 60_000 });
    assert.equal(said.status, 0, said.stderr);

    const state = RoomStore.open(roomsDir(env), parent.id).state;
    const report = state.messages.find((message) => message.sys?.code === "thread.reported");
    assert.ok(report, `the parent got the report (stderr: ${said.stderr})`);
    assert.match(report.text, /Thread "Look" .* went quiet\./);
    assert.match(report.text, /Looked, nothing to change\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
