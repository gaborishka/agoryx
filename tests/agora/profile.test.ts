import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RoomEngine } from "../../internal/agora/engine.js";
import {
  describeProfile,
  MAX_PROFILE_CHARS,
  profilePath,
  profileReaders,
  profileUpdate,
  readProfile,
} from "../../internal/agora/profile.js";
import { parseAgents, RosterError } from "../../internal/agora/roster.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { RoomStore } from "../../internal/agora/store.js";
import type { RoomAgent } from "../../internal/agora/types.js";
import { profileLine } from "../../ui/src/lib/room.js";
import { createTestRoom, withTimeout, type TestRoom } from "./helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = () => mkdtempSync(join(tmpdir(), "agora-profile-"));

/** Claude is given the profile; Codex has it switched off in the roster. */
const AGENTS: RoomAgent[] = parseAgents([{ kind: "claude" }, { kind: "codex", profile: false }]);

const MARK_V1 = "I-AM-IVAN-v1: I write in Ukrainian, prefer small diffs, hate ceremony.";
const MARK_V2 = "I-AM-IVAN-v2: I now review every change before it lands.";

/** Every file under `dir`, as text (binary files included raw: a marker would still show). */
const everything = (dir: string): string => {
  let out = "";
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out += readFileSync(path, "latin1");
    }
  };
  walk(dir);
  return out;
};

/** What git would show of everything ever committed in the workspace. */
const gitHistory = (workspace: string): string =>
  spawnSync("git", ["log", "--all", "-p", "--format=%B"], { cwd: workspace, encoding: "utf8" }).stdout ?? "";

const turnStarts = (room: { store: RoomStore }, agent: string) =>
  room.store.events.flatMap((event) => (event.type === "turn.started" && event.agent === agent ? [event] : []));

// --- the roster switch ------------------------------------------------------------------------

test('the roster switches the profile off per agent with "profile": false; it is on otherwise', () => {
  assert.deepEqual(parseAgents([{ kind: "claude" }, { kind: "codex", profile: false }, { id: "opus", kind: "claude", profile: true }]), [
    { id: "claude", kind: "claude", label: "Claude" },
    { id: "codex", kind: "codex", label: "Codex", profile: false },
    { id: "opus", kind: "claude", label: "Opus" },
  ]);
  // A roster that went through once (a room's own) reads the same again.
  assert.deepEqual(parseAgents(AGENTS), AGENTS);
  assert.throws(() => parseAgents([{ kind: "codex", profile: "no" }]), (error: unknown) => error instanceof RosterError && /"profile" must be true or false/.test(error.message));
  assert.throws(
    () => parseAgents([{ kind: "codex", bio: false }]),
    (error: unknown) => error instanceof RosterError && /unknown field "bio" \(allowed: id, kind, label, model, effort, profile\)/.test(error.message),
  );
});

// --- the file ---------------------------------------------------------------------------------

test("no profile file, or an empty one, is no profile; a long one is cut, and says so", () => {
  const dir = scratch();
  try {
    assert.equal(profilePath({ AGORYX_HOME: dir }), join(dir, "profile.md"));
    const path = join(dir, "profile.md");
    assert.equal(readProfile(path), null);
    assert.equal(readProfile(undefined), null);
    writeFileSync(path, "  \n\n\t\n");
    assert.equal(readProfile(path), null);

    writeFileSync(path, `${"A line about me that goes on for a while.\n".repeat(400)}THE-END-MARK\n`);
    const long = readProfile(path)!;
    assert.equal(long.truncated, true);
    assert.ok(long.text.length < MAX_PROFILE_CHARS + 200, `bounded (${long.text.length})`);
    assert.doesNotMatch(long.text, /THE-END-MARK/);
    assert.match(long.text, /\[… cut here: the profile is \d+ characters, only the first 4000 are given to agents\]$/);

    writeFileSync(path, "short\r\n");
    const short = readProfile(path)!;
    assert.deepEqual({ text: short.text, truncated: short.truncated }, { text: "short", truncated: false });
    assert.notEqual(short.hash, long.hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a running session is given the profile once per version, told once when it is removed, and nothing otherwise", () => {
  const dir = scratch();
  try {
    const path = join(dir, "profile.md");
    writeFileSync(path, MARK_V1);
    const v1 = readProfile(path)!;
    assert.match(profileUpdate(v1, "", "Ivan")!, /Ivan wrote a profile about themself[\s\S]*I-AM-IVAN-v1/);
    assert.equal(profileUpdate(v1, v1.hash, "Ivan"), null);
    writeFileSync(path, MARK_V2);
    assert.match(profileUpdate(readProfile(path), v1.hash, "Ivan")!, /Ivan changed their profile since you last got it[\s\S]*I-AM-IVAN-v2/);
    assert.match(profileUpdate(null, v1.hash, "Ivan")!, /Ivan removed their profile/);
    assert.equal(profileUpdate(null, "", "Ivan"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- in a room --------------------------------------------------------------------------------

test("the profile reaches the agents it is on for — once — and not a word of it reaches the others, the workspace or the log", async () => {
  const dir = scratch();
  const path = join(dir, "profile.md");
  writeFileSync(path, `${MARK_V1}\n`);
  // Codex answers the second question, so Claude takes one more turn after the one that brings the new version.
  const room = createTestRoom({ agents: AGENTS, profilePath: path, rules: [{ agent: "codex", match: "And the table?", reply: "Codex: a board beside the talk.", once: true }] });
  let reopened: RoomEngine | undefined;
  try {
    room.engine.postHuman("How should we store rooms?");
    await withTimeout(room.engine.waitIdle());

    const claude = () => room.invocations().filter((entry) => entry.env?.AGORYX_AGENT === "claude");
    const codex = () => room.invocations().filter((entry) => entry.env?.AGORYX_AGENT === "codex");
    assert.equal(claude().length, 2);
    // A fresh session: in the briefing, marked as the human's own words about themself.
    const first = claude()[0]!.prompt!;
    assert.match(first, /^You are Claude \(@claude\), in an Agoryx room/, "still a briefing (native import tells room prompts by it)");
    assert.match(first, /About Ivan, in their own words — Ivan wrote this profile about themself/);
    assert.ok(first.includes(MARK_V1));
    // The delta stays thin: the next turn in the same session does not repeat it.
    assert.ok(!claude()[1]!.prompt!.includes("I-AM-IVAN"));
    assert.doesNotMatch(claude()[1]!.prompt!, /profile/i);
    // Switched off: not a word, in any turn.
    for (const call of codex()) {
      assert.ok(!call.prompt!.includes("I-AM-IVAN"));
      assert.doesNotMatch(call.prompt!, /profile/i);
    }
    // What the room remembers is the hash of the version each agent holds, never the text.
    const hash = readProfile(path)!.hash;
    assert.ok(turnStarts(room, "claude").every((event) => event.profile === hash));
    assert.ok(turnStarts(room, "codex").every((event) => event.profile === undefined));
    assert.deepEqual(room.store.state.profiles, { claude: hash, codex: "" });

    // The human changes it; the daemon restarts in between. The room's log tells who has which version.
    writeFileSync(path, `${MARK_V2}\n`);
    await room.engine.close();
    reopened = new RoomEngine({
      store: RoomStore.open(room.roomsRoot, room.store.id),
      runners: { claude: createClaudeRunner(room.fakeClaude), codex: createCodexRunner(room.fakeCodex) },
      shimDir: room.shimDir,
      env: room.env,
      profilePath: path,
      opsPollMs: 50,
      nativePollMs: 0,
    });
    reopened.postHuman("And the table?");
    await withTimeout(reopened.waitIdle());
    const after = claude().slice(2);
    assert.ok(after.length >= 2, `claude took ${after.length} turns`);
    assert.equal(after[0]!.resumed, true, "the same native session, resumed");
    assert.match(after[0]!.prompt!, /^\[agoryx · /);
    assert.match(after[0]!.prompt!, /Ivan changed their profile since you last got it/);
    assert.ok(after[0]!.prompt!.includes(MARK_V2));
    assert.ok(!after[0]!.prompt!.includes(MARK_V1));
    for (const call of after.slice(1)) assert.ok(!call.prompt!.includes("I-AM-IVAN"), "given once, not every turn");
    for (const call of codex()) assert.ok(!call.prompt!.includes("I-AM-IVAN"));

    // Nowhere the room's history is kept: not the workspace, not .agoryx/, not git, not the room's own log.
    const workspace = room.store.state.workspace;
    assert.ok(!everything(workspace).includes("I-AM-IVAN"), "workspace (with .agoryx/ and .git/)");
    assert.ok(!gitHistory(workspace).includes("I-AM-IVAN"), "commits");
    assert.ok(!everything(room.roomsRoot).includes("I-AM-IVAN"), "the room's event log");
  } finally {
    await reopened?.close();
    await room.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with no profile file the prompts are what they were", async () => {
  const dir = scratch();
  const withPath = createTestRoom({ agents: AGENTS, profilePath: join(dir, "profile.md") });
  const without = createTestRoom({ agents: AGENTS });
  const strip = (text: string) => text.replace(/\d\d:\d\d/g, "HH:MM").replace(/Workspace: .*/g, "").replace(/"[^"]*agoryx"/g, "").replace(/test-room-[a-z0-9]+/g, "ROOM");
  try {
    for (const room of [withPath, without]) {
      room.engine.postHuman("How should we store rooms?");
      await withTimeout(room.engine.waitIdle());
    }
    const prompts = (room: TestRoom) =>
      room
        .invocations()
        .map((entry) => `${entry.env?.AGORYX_AGENT}:${strip(entry.prompt!)}`)
        .sort();
    assert.deepEqual(prompts(withPath), prompts(without));
    assert.ok(turnStarts(withPath, "claude").every((event) => !("profile" in event)));
  } finally {
    await withPath.cleanup();
    await without.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- showing the human who sees it --------------------------------------------------------------

test("who sees the profile: the CLI and the UI say it from the roster and the room's log", () => {
  const dir = scratch();
  try {
    const path = join(dir, "profile.md");
    const room = { name: "Store", id: "r1", agents: [...AGENTS, { id: "opus", kind: "claude" as const, label: "Opus" }], profiles: {} as Record<string, string> };
    assert.deepEqual(describeProfile(path, null, null).slice(0, 2), [`Profile: ${path}`, "  none yet (or empty) — no agent is given anything. Write who you are, how you work and what matters to you there;"]);

    writeFileSync(path, MARK_V1);
    const profile = readProfile(path)!;
    room.profiles.claude = profile.hash;
    room.profiles.opus = "an-older-version";
    assert.deepEqual(
      profileReaders(room, profile).map((entry) => `${entry.agent.id}:${entry.status}`),
      ["claude:has", "codex:off", "opus:next"],
    );
    const text = describeProfile(path, profile, room).join("\n");
    assert.match(text, /Room "Store" \(r1\):/);
    assert.match(text, /Claude \(@claude\)\s+sees it — has this version/);
    assert.match(text, /Codex \(@codex\)\s+is not given it \("profile": false in the roster; its own tools could still read the file\)/);
    assert.match(text, /Opus \(@opus\)\s+sees it — gets this version with its next turn/);
    assert.doesNotMatch(text, /I-AM-IVAN/, "the report never prints the profile itself");

    assert.equal(profileLine(AGENTS[0]!, { exists: false }), null);
    assert.equal(profileLine(AGENTS[0]!, undefined), null);
    assert.match(profileLine(AGENTS[0]!, { exists: true })!, /Бачить ваш профіль/);
    assert.match(profileLine(AGENTS[1]!, { exists: true })!, /вимкнено/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`agoryx profile` names the file and, with a room, who in it sees the profile", () => {
  const home = scratch();
  try {
    const run = () =>
      spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "cmd/agoryx/main.ts"), "profile"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home, AGORYX_HOME: home },
      });
    const empty = run();
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, new RegExp(`Profile: ${join(home, "profile.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(empty.stdout, /none yet/);

    mkdirSync(join(home, "rooms"), { recursive: true });
    RoomStore.create(join(home, "rooms"), {
      name: "Store",
      workspace: join(home, "ws"),
      createdWorkspace: true,
      human: "Ivan",
      agents: AGENTS,
      settings: { budget: 8, turnTimeoutMs: 60_000, access: "workspace", network: false, autoCommit: false, doc: null },
    });
    writeFileSync(join(home, "profile.md"), MARK_V1);
    const withRoom = run();
    assert.equal(withRoom.status, 0, withRoom.stderr);
    assert.match(withRoom.stdout, /Claude \(@claude\)\s+sees it — gets this version with its next turn/);
    assert.match(withRoom.stdout, /Codex \(@codex\)\s+is not given it/);
    assert.doesNotMatch(withRoom.stdout, /I-AM-IVAN/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a turn that failed never answered the version it was shown: that version is given again", () => {
  const home = scratch();
  try {
    const store = RoomStore.create(join(home, "rooms"), {
      name: "Store",
      workspace: join(home, "ws"),
      createdWorkspace: true,
      human: "Ivan",
      agents: AGENTS,
      settings: { budget: 8, turnTimeoutMs: 60_000, access: "workspace", network: false, autoCommit: false, doc: null },
    });
    const start = (turnId: string, profile: string) =>
      store.append({ type: "turn.started", turnId, agent: "claude", runId: "r1", cursor: store.state.seq, resume: true, sessionId: "s", promptChars: 1, profile });
    const end = (turnId: string, status: "ok" | "error") => store.append({ type: "turn.ended", turnId, agent: "claude", status, sessionId: "s", durationMs: 1 });
    start("t1", "v1");
    end("t1", "ok");
    assert.equal(store.state.profiles.claude, "v1");
    start("t2", "v2");
    end("t2", "error");
    assert.equal(store.state.profiles.claude, "v1", "v2 is new to the session again");
    start("t3", "v2");
    end("t3", "ok");
    assert.equal(RoomStore.open(join(home, "rooms"), store.id).state.profiles.claude, "v2", "and the log says so after a restart");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
