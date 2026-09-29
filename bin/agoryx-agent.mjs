#!/usr/bin/env node
// The `agoryx` command agents see inside a room. Zero dependencies on purpose:
// it runs inside the agents' sandboxes, writes table ops into the workspace
// inbox (.agoryx/rooms/<room>/ops/<agent>.jsonl) and waits briefly for the room to ack.
// It also works outside a room turn, when someone talks to the agent directly
// in its own session: the op is signed with --as, or with a hint from the
// agent's environment, and the room reads it from the same inbox.
// `agoryx diff` reads what each turn changed (.agoryx/rooms/<room>/turns/<turn>.patch).
// `agoryx read` reads what was said, in full (.agoryx/messages/<room>/<id>.md).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const USAGE = `agoryx — room tools for agents

  agoryx table show
  agoryx table ask "question"
  agoryx table propose "short title" [--body "what and why" | --body-file notes.md | --body -] [--file path] [--q Q1]
                   the body is markdown: mermaid/html/svg fences and ![](path) embeds render for everyone
  agoryx table object  P1 "reason"
  agoryx table support P1 "reason"
  agoryx table evidence P1 "finding" [--source url-or-path]
  agoryx table fact "a fact everyone should rely on"
  agoryx table settle "what is now established" [--q Q1]   (--q: this answers Q1 and closes it)
  agoryx table concede "what I no longer hold, and why" [--on P1]
                   an argument changed your mind: say so on the table
  agoryx table next "concrete next step"
  agoryx table done X1
  agoryx table withdraw P1
  agoryx table decide P1 [--note "why"]
  agoryx table reopen Q1|P1

  agoryx diff              recent turns that changed files: who, when, +/−
  agoryx diff t7           exactly what turn t7 changed (a patch)
  agoryx diff t7 src/a.ts  only that file

  agoryx read              recent messages: id, who, how long, how it starts
  agoryx read m12          the full text of message m12 (your turn's delta may give only its start)
  agoryx read m12 m15      several at once

Outside a room turn (someone talking to you directly in your own session), run it
from the room's workspace and sign it: agoryx table … --as <your id in the room>.
If several rooms share the workspace, name yours too: --room <room id> (table, diff, read).
`;

const cleanRoom = (value) => String(value).replace(/[^\w.-]/g, "");

/** The workspace's .agoryx directory: the one the room turn's inbox is in, or the nearest one up from here. */
const findAgoryxDir = () => {
  if (process.env.AGORYX_OPS_DIR) {
    const opsParent = dirname(resolve(process.env.AGORYX_OPS_DIR));
    // .agoryx/rooms/<room>/ops, or .agoryx/ops from a room that opened before rooms had their own directories
    return /[\\/]rooms$/.test(dirname(opsParent)) ? dirname(dirname(opsParent)) : opsParent;
  }
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".agoryx", "ops")) || existsSync(join(dir, ".agoryx", "rooms"))) return join(dir, ".agoryx");
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/** Rooms that opened in this workspace with their own directories: [{ id, name }]. */
const roomsHere = (agoryxDir) => {
  const root = join(agoryxDir, "rooms");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "room.json")))
    .map((entry) => {
      try {
        return { id: entry.name, name: JSON.parse(readFileSync(join(root, entry.name, "room.json"), "utf8")).name ?? entry.name };
      } catch {
        return { id: entry.name, name: entry.name };
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * The directory holding one room's inbox (ops/), table (TABLE.md) and turn patches (turns/). Rooms may
 * share a workspace, so each has .agoryx/rooms/<room>/. A room turn names it (AGORYX_OPS_DIR, AGORYX_ROOM);
 * outside one, --room does, or the only room here. Several rooms and no --room is an error, not a guess:
 * a move on the wrong room's table is worse than none. A workspace no room has opened with per-room
 * directories yet keeps the older layout straight under .agoryx/.
 */
const roomDir = (agoryxDir, flagRoom) => {
  const named = flagRoom ?? process.env.AGORYX_ROOM;
  if (named !== undefined) {
    const room = cleanRoom(named);
    if (!room || room !== String(named) || room.startsWith(".")) fail(`'${named}' is not a room id`);
    const dir = join(agoryxDir, "rooms", room);
    if (!existsSync(dir)) {
      // A room turn run by an engine from before per-room directories: its inbox is the one it named.
      if (flagRoom === undefined && process.env.AGORYX_OPS_DIR && roomsHere(agoryxDir).length === 0
        && dirname(resolve(process.env.AGORYX_OPS_DIR)) === agoryxDir) return agoryxDir;
      const rooms = roomsHere(agoryxDir);
      fail(`no room '${room}' in this workspace${rooms.length ? ` — rooms here: ${rooms.map((entry) => `${entry.id} (${entry.name})`).join(", ")}` : ""}`);
    }
    return dir;
  }
  if (process.env.AGORYX_OPS_DIR) {
    const selected = dirname(resolve(process.env.AGORYX_OPS_DIR));
    if (selected !== agoryxDir) return selected;
  }
  const rooms = roomsHere(agoryxDir);
  if (rooms.length === 0) return agoryxDir;
  if (rooms.length === 1) return join(agoryxDir, "rooms", rooms[0].id);
  fail(
    `${rooms.length} rooms share this workspace — say which one with --room <id>:\n${rooms.map((entry) => `  --room ${entry.id}   ${entry.name}`).join("\n")}`,
  );
};

const parseArgs = (argv) => {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (i + 1 < argv.length) flags[arg.slice(2)] = argv[++i];
      else flags[arg.slice(2)] = "";
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
};

const fail = (message) => {
  process.stderr.write(`agoryx: ${message}\n`);
  process.exit(1);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Who is writing. A room turn sets AGORYX_AGENT; outside one, --as says it, or
 * the agent's own environment hints at which CLI it is ("kind.claude": a room
 * may seat two Claudes, and one of them may even be called "claude", so a hint
 * is never an id). "unknown" lets the room decide by who is mid-exchange in its
 * own session right now.
 */
const signer = (flags) => {
  const clean = (value) => String(value).replace(/[^a-z0-9_-]/gi, "");
  if (flags.as) return clean(flags.as) || "unknown";
  if (process.env.AGORYX_AGENT) return clean(process.env.AGORYX_AGENT) || "unknown";
  if (process.env.CLAUDECODE) return "kind.claude";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED) return "kind.codex";
  return "unknown";
};

/** The flags each verb takes (same as internal/agora/table-cli.ts); anything else is a typo, not something to drop. */
const TABLE_FLAGS = {
  propose: ["body", "file", "q"],
  evidence: ["source"],
  object: ["source"],
  support: ["source"],
  decide: ["note"],
  settle: ["q"],
  concede: ["on"],
};

const buildOp = (verb, positional, flags) => {
  const allowed = TABLE_FLAGS[verb] ?? [];
  const unknown = Object.keys(flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length > 0 && ["ask", "fact", "settle", "concede", "next", "propose", "object", "support", "evidence", "done", "withdraw", "reopen", "decide"].includes(verb)) {
    fail(`'${verb}' does not take ${unknown.map((flag) => `--${flag}`).join(", ")}${allowed.length ? ` (it takes ${allowed.map((flag) => `--${flag}`).join(", ")})` : ""}`);
  }
  const rest = positional.join(" ").trim();
  switch (verb) {
    case "ask":
    case "fact":
    case "next":
      if (!rest) fail(`'${verb}' needs text`);
      return { op: verb, text: rest };
    case "settle":
      if (!rest) fail("'settle' needs text");
      return { op: "settle", text: rest, q: flags.q };
    case "concede":
      if (!rest) fail("'concede' needs text: what you no longer hold, and why");
      return { op: "concede", text: rest, target: flags.on };
    case "propose":
      if (!positional[0]) fail("'propose' needs a title");
      return {
        op: "propose",
        title: positional[0],
        body: flags.body ?? (positional.slice(1).join(" ") || undefined),
        file: flags.file,
        q: flags.q,
      };
    case "object":
    case "support":
    case "evidence": {
      const [target, ...text] = positional;
      if (!target || text.length === 0) fail(`'${verb}' needs an option id and text, e.g. ${verb} P1 "..."`);
      return { op: verb, target, text: text.join(" "), source: flags.source };
    }
    case "done":
    case "withdraw":
    case "reopen":
      if (!positional[0]) fail(`'${verb}' needs an id`);
      return { op: verb, target: positional[0] };
    case "decide":
      if (!positional[0]) fail("'decide' needs an option id");
      return { op: "decide", target: positional[0], note: flags.note ?? (positional.slice(1).join(" ") || undefined) };
    default:
      fail(`unknown table command '${verb}'\n\n${USAGE}`);
  }
};

/** A patch file is "# header" lines, then `diff --git` sections. */
const splitPatch = (text) => {
  const header = [];
  const lines = text.split("\n");
  while (lines.length && lines[0].startsWith("#")) header.push(lines.shift());
  return { header, body: lines.join("\n") };
};

/**
 * A room's turn patches; a room that opened before rooms had their own directories keeps its older
 * ones in .agoryx/turns/, read too while it is the only room in the workspace.
 */
const runDiff = (agoryxDir, room, ref, path) => {
  const dirs = [join(room, "turns")];
  if (room !== agoryxDir && roomsHere(agoryxDir).length <= 1) dirs.push(join(agoryxDir, "turns"));
  const found = new Map();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/^t\d+\.patch$/.test(name)) continue;
      const n = Number(name.slice(1, -".patch".length));
      if (!found.has(n)) found.set(n, join(dir, name));
    }
  }
  const turns = [...found.keys()].sort((a, b) => b - a);
  if (!ref) {
    if (turns.length === 0) {
      process.stdout.write("No turn has changed files yet.\n");
      return;
    }
    for (const n of turns.slice(0, 15)) {
      const { header } = splitPatch(readFileSync(found.get(n), "utf8"));
      process.stdout.write(`${header.filter((line) => line !== "#").map((line) => line.replace(/^# ?/, "")).join("\n")}\n\n`);
    }
    if (turns.length > 15) process.stdout.write(`… ${turns.length - 15} older turns: agoryx diff t<N>\n`);
    return;
  }
  const id = /^t?\d+$/.test(ref) ? `t${ref.replace(/^t/, "")}` : null;
  if (!id) fail(`'${ref}' is not a turn id (like t7) — agoryx diff lists them`);
  const file = found.get(Number(id.slice(1)));
  if (!file) fail(`turn ${id} changed no files (or its patch is gone) — agoryx diff lists the ones that did`);
  const { header, body } = splitPatch(readFileSync(file, "utf8"));
  if (!path) {
    process.stdout.write(`${header.join("\n")}\n${body}`);
    return;
  }
  const want = path.replace(/^\.\//, "");
  const section = body.split(/(?=^diff --git )/m).find((part) => {
    const first = part.split("\n", 1)[0];
    return first.endsWith(` b/${want}`) || first.includes(` a/${want} `);
  });
  if (!section) fail(`turn ${id} did not change ${want}`);
  process.stdout.write(`${header[0]}\n${section}`);
};

/**
 * Messages are kept per room (.agoryx/messages/<room>/), since rooms may share a
 * workspace. A room turn names its room in AGORYX_ROOM; outside one, --room does,
 * or the only room here, or the one that spoke last (said on stderr).
 */
const messagesDir = (agoryxDir, flagRoom) => {
  const root = join(agoryxDir, "messages");
  const clean = (value) => String(value).replace(/[^\w.-]/g, "");
  const named = flagRoom ?? process.env.AGORYX_ROOM;
  if (named) {
    const room = clean(named);
    if (!room || room !== String(named) || room.startsWith(".")) fail(`'${named}' is not a room id`);
    return join(root, room);
  }
  const rooms = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, mtime: statSync(join(root, entry.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
    : [];
  if (rooms.length === 0) return join(root, "-");
  if (rooms.length > 1) process.stderr.write(`agoryx: ${rooms.length} rooms share this workspace; reading ${rooms[0].name} (--room <id> for another)\n`);
  return join(root, rooms[0].name);
};

const runRead = (agoryxDir, argv) => {
  const { positional: refs, flags } = parseArgs(argv);
  const dir = messagesDir(agoryxDir, flags.room);
  if (refs.length === 0) {
    const all = existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /^m\d+\.md$/.test(name))
          .map((name) => Number(name.slice(1, -".md".length)))
          .sort((a, b) => b - a)
      : [];
    if (all.length === 0) {
      process.stdout.write("No messages yet.\n");
      return;
    }
    for (const n of all.slice(0, 20)) {
      const [header, , ...body] = readFileSync(join(dir, `m${n}.md`), "utf8").split("\n");
      const text = body.join("\n").trim();
      const start = text.replace(/\s+/g, " ").slice(0, 100);
      process.stdout.write(`${header.replace(/^# /, "")} · ${text.length} chars\n   ${start}${text.length > 100 ? " …" : ""}\n`);
    }
    if (all.length > 20) process.stdout.write(`… ${all.length - 20} older messages: agoryx read m<N>\n`);
    return;
  }
  const out = [];
  for (const ref of refs) {
    const id = /^m?\d+$/.test(ref) ? `m${ref.replace(/^m/, "")}` : null;
    if (!id) fail(`'${ref}' is not a message id (like m12) — agoryx read lists them`);
    const file = join(dir, `${id}.md`);
    if (!existsSync(file)) fail(`no message ${id} — agoryx read lists recent ones`);
    out.push(readFileSync(file, "utf8"));
  }
  process.stdout.write(out.join("\n"));
};

const main = async () => {
  const [command, verb, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "table" && command !== "diff" && command !== "read") {
    fail(`inside a room only 'agoryx table …', 'agoryx diff …' and 'agoryx read …' are available\n\n${USAGE}`);
  }

  const agoryxDir = findAgoryxDir();
  if (!agoryxDir) fail("not inside an Agoryx room workspace (no .agoryx/ directory found)");
  if (command === "read") {
    runRead(agoryxDir, verb ? [verb, ...args] : []);
    return;
  }
  const { positional, flags } = parseArgs(verb ? [verb, ...args] : []);
  const room = roomDir(agoryxDir, flags.room);
  if (command === "diff") {
    runDiff(agoryxDir, room, positional[0], positional[1]);
    return;
  }

  positional.shift();
  if (!verb || verb === "show") {
    const tableFile = join(room, "TABLE.md");
    process.stdout.write(existsSync(tableFile) ? readFileSync(tableFile, "utf8") : "The table is empty.\n");
    return;
  }

  const agent = signer(flags);
  delete flags.as;
  delete flags.room;
  // A long markdown body (diagrams, html) is easier to pass as a file or on stdin than as one shell argument.
  if (flags["body-file"]) {
    try {
      flags.body = readFileSync(resolve(flags["body-file"]), "utf8");
    } catch (error) {
      fail(`cannot read --body-file: ${error instanceof Error ? error.message : String(error)}`);
    }
    delete flags["body-file"];
  } else if (flags.body === "-") {
    flags.body = readFileSync(0, "utf8");
  }
  const op = buildOp(verb, positional, flags);
  for (const key of Object.keys(op)) if (op[key] === undefined) delete op[key];
  const nonce = randomBytes(6).toString("hex");
  const opsDir = join(room, "ops");
  mkdirSync(opsDir, { recursive: true });
  appendFileSync(join(opsDir, `${agent}.jsonl`), `${JSON.stringify({ ...op, nonce })}\n`);

  const ackFile = join(opsDir, "acks", `${nonce}.json`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(ackFile)) {
      let ack;
      try {
        ack = JSON.parse(readFileSync(ackFile, "utf8"));
      } catch {
        await sleep(50);
        continue;
      }
      rmSync(ackFile, { force: true });
      if (!ack.ok) fail(ack.error || "rejected");
      process.stdout.write(`${ack.text || "ok"}\n`);
      return;
    }
    await sleep(100);
  }
  process.stdout.write(
    process.env.AGORYX_AGENT
      ? "queued — the room will pick it up when your turn ends\n"
      : "queued — nothing is watching this room right now; it is applied when the room next opens (agoryx up, or any agoryx command for this room)\n",
  );
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
