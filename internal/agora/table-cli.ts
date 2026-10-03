import { readFileSync } from "node:fs";

/**
 * Parse `table <verb> …` arguments into a raw table op. Mirrors the
 * zero-dependency agent CLI (bin/agoryx-agent.mjs) so humans and agents use
 * the same words.
 */
export const TABLE_USAGE = [
  "agoryx table [show]",
  'agoryx table brief "where we are" [--change "important change"] [--next "next step"] [--ref P1] [--awaiting Q1 --recommend P1]   (--change and --ref can repeat)',
  'agoryx table component "title" --kind comparison|plan|checks|artifact|custom [--ref P1] [--body … | --body-file f.md] [--file path] [--target W1]   (--ref can repeat; target replaces your component)',
  "agoryx table archive W1 | restore W1",
  'agoryx table ask "question" [--many]   (--many: its options don\'t exclude each other; any number can be chosen)',
  'agoryx table propose "short title" [--body "what and why" | --body-file notes.md] [--file path] [--q Q1]',
  'agoryx table object|support P1|X1|S1|F1 "reason"   (on a step X1: a finding of its check, or that the check passed)',
  'agoryx table evidence P1|X1|S1|F1 "finding" [--source url-or-path]',
  'agoryx table fact "text"',
  'agoryx table next "a step" [--on P1]   (--on: the option, a route, it carries out)',
  "agoryx table review X1   (the step is built: it waits for someone else's check)",
  'agoryx table settle "what is now established" [--q Q1]',
  'agoryx table concede "what I no longer hold, and why" [--on P1]',
  "agoryx table done X1 | withdraw P1|F1 | reopen Q1|P1",
  'agoryx table decide P1 [--note "why"]',
  'agoryx table edit P1 ["new title"] [--body … | --body-file …] [--file path] [--q Q2]',
  'agoryx table edit Q1|S1|F1|X1|N1|C1 ["new text"] [--many | --one] [--source …]',
  "agoryx table delete P1|Q1|S1|F1|X1|N1|C1",
];

export class TableCommandError extends Error {}

/** The flags each verb takes; anything else is a typo that would otherwise be dropped silently. */
export const TABLE_FLAGS: Record<string, string[]> = {
  brief: ["change", "next", "ref", "awaiting", "recommend"],
  component: ["kind", "ref", "body", "body-file", "file", "target"],
  ask: ["many"],
  propose: ["body", "body-file", "file", "q"],
  edit: ["body", "body-file", "file", "q", "source", "many", "one"],
  evidence: ["source"],
  object: ["source"],
  support: ["source"],
  decide: ["note"],
  settle: ["q"],
  concede: ["on"],
  next: ["on"],
};

/** Flags that take no value: the next argument stays positional. */
export const TABLE_SWITCHES = ["many", "one"];

export const parseTableCommand = (verb: string, argv: string[]): Record<string, unknown> => {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const repeated: Record<string, string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      const value = eq > 0 ? arg.slice(eq + 1)
        : TABLE_SWITCHES.includes(name) ? "true"
          : index + 1 < argv.length && !argv[index + 1]!.startsWith("--") ? argv[++index]! : "";
      flags[name] = value;
      if (name === "ref" || name === "change") (repeated[name] ??= []).push(value);
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
    case "brief": {
      if (!rest) throw new TableCommandError("'brief' needs text describing where the work is now");
      if (flags.recommend !== undefined && !flags.awaiting) throw new TableCommandError("--recommend needs --awaiting Q1");
      for (const name of Object.keys(flags)) if (!flags[name]) throw new TableCommandError(`--${name} needs a value`);
      for (const name of Object.keys(repeated)) if (repeated[name]!.some((value) => !value)) throw new TableCommandError(`--${name} needs a value`);
      return clean({
        op: verb,
        now: rest,
        changes: repeated.change,
        next: flags.next,
        refs: repeated.ref,
        awaiting: flags.awaiting ? { q: flags.awaiting, ...(flags.recommend ? { recommendation: flags.recommend } : {}) } : undefined,
      });
    }
    case "component": {
      if (!rest) throw new TableCommandError("'component' needs a title");
      if (!flags.kind) throw new TableCommandError("'component' needs --kind comparison|plan|checks|artifact|custom");
      if (flags.body !== undefined && flags["body-file"] !== undefined) throw new TableCommandError("use --body or --body-file, not both");
      for (const name of Object.keys(flags)) if (!flags[name]) throw new TableCommandError(`--${name} needs a value`);
      for (const name of Object.keys(repeated)) if (repeated[name]!.some((value) => !value)) throw new TableCommandError(`--${name} needs a value`);
      return clean({
        op: verb,
        title: rest,
        kind: flags.kind,
        refs: repeated.ref ?? [],
        body: flags["body-file"] ? readFileSync(flags["body-file"], "utf8") : flags.body,
        file: flags.file,
        target: flags.target,
      });
    }
    case "archive":
    case "restore":
      if (positional.length !== 1) throw new TableCommandError(`'${verb}' needs one component id, e.g. ${verb} W1`);
      return { op: verb, target: positional[0] };
    case "ask":
      if (!rest) throw new TableCommandError("'ask' needs text");
      return { op: "ask", text: rest, ...(flags.many ? { many: true } : {}) };
    case "fact":
      if (!rest) throw new TableCommandError("'fact' needs text");
      return { op: verb, text: rest };
    case "next":
      if (!rest) throw new TableCommandError("'next' needs text");
      return clean({ op: verb, text: rest, target: flags.on });
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
    case "review":
    case "withdraw":
    case "reopen":
      if (!positional[0]) throw new TableCommandError(`'${verb}' needs an id`);
      return { op: verb, target: positional[0] };
    case "edit": {
      const [target, ...text] = positional;
      if (!target) throw new TableCommandError("'edit' needs an id, e.g. edit P1 \"new title\" or edit Q1 --many");
      if (flags.many && flags.one) throw new TableCommandError("'edit' takes --many or --one, not both");
      return clean({
        op: "edit",
        target,
        text: text.join(" ").trim() || undefined,
        body: flags["body-file"] ? readFileSync(flags["body-file"], "utf8") : flags.body,
        file: flags.file,
        q: flags.q,
        source: flags.source,
        many: flags.many ? true : flags.one ? false : undefined,
      });
    }
    case "delete":
      if (!positional[0]) throw new TableCommandError("'delete' needs an id");
      return { op: "delete", target: positional[0] };
    case "decide":
      if (!positional[0]) throw new TableCommandError("'decide' needs an option id");
      return clean({ op: "decide", target: positional[0], note: flags.note ?? (positional.slice(1).join(" ") || undefined) });
    default:
      throw new TableCommandError(`unknown table command '${verb}'`);
  }
};
