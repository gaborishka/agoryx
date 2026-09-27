#!/usr/bin/env node
// The `agoryx` command agents see inside a room. Zero dependencies on purpose:
// it runs inside the agents' sandboxes, writes table ops into the workspace
// inbox (.agoryx/ops/<agent>.jsonl) and waits briefly for the room to ack.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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

const main = async () => {
  const [command, verb, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== "table") fail(`inside a room only 'agoryx table …' is available\n\n${USAGE}`);

  const agoryxDir = findAgoryxDir();
  if (!agoryxDir) fail("not inside an Agoryx room workspace (no .agoryx/ directory found)");

  if (!verb || verb === "show") {
    const tableFile = process.env.AGORYX_TABLE || join(agoryxDir, "TABLE.md");
    process.stdout.write(existsSync(tableFile) ? readFileSync(tableFile, "utf8") : "The table is empty.\n");
    return;
  }

  const { positional, flags } = parseArgs(args);
  const op = buildOp(verb, positional, flags);
  for (const key of Object.keys(op)) if (op[key] === undefined) delete op[key];
  const nonce = randomBytes(6).toString("hex");
  const agent = (process.env.AGORYX_AGENT || "agent").replace(/[^a-z0-9_-]/gi, "") || "agent";
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
  process.stdout.write("queued — the room will pick it up when your turn ends\n");
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
