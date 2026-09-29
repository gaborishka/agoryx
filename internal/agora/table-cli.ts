import { readFileSync } from "node:fs";

/**
 * Parse `table <verb> …` arguments into a raw table op. Mirrors the
 * zero-dependency agent CLI (bin/agoryx-agent.mjs) so humans and agents use
 * the same words.
 */
export const TABLE_USAGE = [
  "agoryx table [show]",
  'agoryx table ask "question"',
  'agoryx table propose "short title" [--body "what and why" | --body-file notes.md] [--file path] [--q Q1]',
  'agoryx table object|support P1|S1|F1 "reason"',
  'agoryx table evidence P1|S1|F1 "finding" [--source url-or-path]',
  'agoryx table fact|next "text"',
  'agoryx table settle "what is now established" [--q Q1]',
  'agoryx table concede "what I no longer hold, and why" [--on P1]',
  "agoryx table done X1 | withdraw P1|F1 | reopen Q1|P1",
  'agoryx table decide P1 [--note "why"]',
];

export class TableCommandError extends Error {}

/** The flags each verb takes; anything else is a typo that would otherwise be dropped silently. */
export const TABLE_FLAGS: Record<string, string[]> = {
  propose: ["body", "body-file", "file", "q"],
  evidence: ["source"],
  object: ["source"],
  support: ["source"],
  decide: ["note"],
  settle: ["q"],
  concede: ["on"],
};

export const parseTableCommand = (verb: string, argv: string[]): Record<string, unknown> => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else if (index + 1 < argv.length) flags[arg.slice(2)] = argv[++index]!;
      else flags[arg.slice(2)] = "";
    } else {
      positional.push(arg);
    }
  }
  const allowed = TABLE_FLAGS[verb] ?? [];
  const unknown = Object.keys(flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length > 0) {
    throw new TableCommandError(
      `'${verb}' does not take ${unknown.map((flag) => `--${flag}`).join(", ")}${allowed.length ? ` (it takes ${allowed.map((flag) => `--${flag}`).join(", ")})` : ""}`,
    );
  }
  const rest = positional.join(" ").trim();
  const clean = (op: Record<string, unknown>) => {
    for (const key of Object.keys(op)) if (op[key] === undefined || op[key] === "") delete op[key];
    return op;
  };
  switch (verb) {
    case "ask":
    case "fact":
    case "next":
      if (!rest) throw new TableCommandError(`'${verb}' needs text`);
      return { op: verb, text: rest };
    case "settle":
      if (!rest) throw new TableCommandError("'settle' needs text");
      return clean({ op: "settle", text: rest, q: flags.q });
    case "concede":
      if (!rest) throw new TableCommandError("'concede' needs text: what you no longer hold, and why");
      return clean({ op: "concede", text: rest, target: flags.on });
    case "propose":
      if (!positional[0]) throw new TableCommandError("'propose' needs a title");
      return clean({
        op: "propose",
        title: positional[0],
        body: (flags["body-file"] ? readFileSync(flags["body-file"], "utf8") : flags.body) ?? (positional.slice(1).join(" ") || undefined),
        file: flags.file,
        q: flags.q,
      });
    case "object":
    case "support":
    case "evidence": {
      const [target, ...text] = positional;
      if (!target || text.length === 0) throw new TableCommandError(`'${verb}' needs an option id and text, e.g. ${verb} P1 "..."`);
      return clean({ op: verb, target, text: text.join(" "), source: flags.source });
    }
    case "done":
    case "withdraw":
    case "reopen":
      if (!positional[0]) throw new TableCommandError(`'${verb}' needs an id`);
      return { op: verb, target: positional[0] };
    case "decide":
      if (!positional[0]) throw new TableCommandError("'decide' needs an option id");
      return clean({ op: "decide", target: positional[0], note: flags.note ?? (positional.slice(1).join(" ") || undefined) });
    default:
      throw new TableCommandError(`unknown table command '${verb}'`);
  }
};
