#!/usr/bin/env node
// The `agoryx` command agents see inside a room. Zero dependencies on purpose:
// it runs inside the agents' sandboxes, writes table ops into the workspace
// inbox (.agoryx/ops/<agent>.jsonl) and waits briefly for the room to ack.
// It also works outside a room turn, when someone talks to the agent directly
// in its own session: the op is signed with --as, or with a hint from the
// agent's environment, and the room reads it from the same inbox.
// `agoryx diff` reads what each turn changed (.agoryx/turns/<turn>.patch).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const USAGE = `agoryx — room tools for agents

  agoryx table show
  agoryx table ask "question"
  agoryx table propose "short title" [--body "what and why"] [--file path] [--q Q1]
  agoryx table object  P1 "reason"
  agoryx table support P1 "reason"
  agoryx table evidence P1 "finding" [--source url-or-path]
  agoryx table fact "a fact everyone should rely on"
  agoryx table settle "what is now established"
  agoryx table next "concrete next step"
  agoryx table done X1
  agoryx table withdraw P1
  agoryx table decide P1 [--note "why"]
  agoryx table reopen Q1|P1

  agoryx diff              recent turns that changed files: who, when, +/−
  agoryx diff t7           exactly what turn t7 changed (a patch)
  agoryx diff t7 src/a.ts  only that file

Outside a room turn (someone talking to you directly in your own session), run it
from the room's workspace and sign it: agoryx table … --as <your id in the room>.
`;

const findAgoryxDir = () => {
  if (process.env.AGORYX_OPS_DIR) return dirname(resolve(process.env.AGORYX_OPS_DIR));
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".agoryx", "ops"))) return join(dir, ".agoryx");
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
 * the agent's own environment hints at it. "unknown" lets the room decide by
 * who is mid-exchange in its own session right now.
 */
const signer = (flags) => {
  const clean = (value) => String(value).replace(/[^a-z0-9_-]/gi, "");
  if (flags.as) return clean(flags.as) || "unknown";
  if (process.env.AGORYX_AGENT) return clean(process.env.AGORYX_AGENT) || "unknown";
  if (process.env.CLAUDECODE) return "claude";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_SANDBOX_NETWORK_DISABLED) return "codex";
  return "unknown";
};

const buildOp = (verb, positional, flags) => {
  const rest = positional.join(" ").trim();
  switch (verb) {
    case "ask":
    case "fact":
    case "settle":
    case "next":
      if (!rest) fail(`'${verb}' needs text`);
      return { op: verb, text: rest };
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

const runDiff = (agoryxDir, ref, path) => {
  const dir = join(agoryxDir, "turns");
  const turns = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /^t\d+\.patch$/.test(name))
        .map((name) => Number(name.slice(1, -".patch".length)))
        .sort((a, b) => b - a)
    : [];
  if (!ref) {
    if (turns.length === 0) {
      process.stdout.write("No turn has changed files yet.\n");
      return;
    }
    for (const n of turns.slice(0, 15)) {
      const { header } = splitPatch(readFileSync(join(dir, `t${n}.patch`), "utf8"));
      process.stdout.write(`${header.filter((line) => line !== "#").map((line) => line.replace(/^# ?/, "")).join("\n")}\n\n`);
    }
    if (turns.length > 15) process.stdout.write(`… ${turns.length - 15} older turns: agoryx diff t<N>\n`);
    return;
  }
  const id = /^t?\d+$/.test(ref) ? `t${ref.replace(/^t/, "")}` : null;
  if (!id) fail(`'${ref}' is not a turn id (like t7) — agoryx diff lists them`);
  const file = join(dir, `${id}.patch`);
  if (!existsSync(file)) fail(`turn ${id} changed no files (or its patch is gone) — agoryx diff lists the ones that did`);
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

const main = async () => {
  const [command, verb, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "table" && command !== "diff") fail(`inside a room only 'agoryx table …' and 'agoryx diff …' are available\n\n${USAGE}`);

  const agoryxDir = findAgoryxDir();
  if (!agoryxDir) fail("not inside an Agoryx room workspace (no .agoryx/ directory found)");
  if (command === "diff") {
    runDiff(agoryxDir, verb, args[0]);
    return;
  }

  if (!verb || verb === "show") {
    const tableFile = process.env.AGORYX_TABLE || join(agoryxDir, "TABLE.md");
    process.stdout.write(existsSync(tableFile) ? readFileSync(tableFile, "utf8") : "The table is empty.\n");
    return;
  }

  const { positional, flags } = parseArgs(args);
  const agent = signer(flags);
  delete flags.as;
  const op = buildOp(verb, positional, flags);
  for (const key of Object.keys(op)) if (op[key] === undefined) delete op[key];
  const nonce = randomBytes(6).toString("hex");
  const opsDir = process.env.AGORYX_OPS_DIR || join(agoryxDir, "ops");
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
