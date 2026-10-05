// The files a shell command names as what it writes: `> file`, `tee file`, `sed -i … file`, `cp a file`,
// `mv`/`rm`/`touch file`, and a script's own `open('file', 'w')` or `writeFileSync('file', …)`.
// In parallel turns this is the evidence that a file changed by a shell command is this agent's: the command
// named it. It reads only what the command says; a file a command changes without naming it stays unclaimed.

import { homedir } from "node:os";
import { posix } from "node:path";

const INTERPRETER_WRITES = [
  // Python: open('f', 'w'), Path('f').write_text(…)
  /\bopen\(\s*(["'])([^"'\n]+)\1\s*,\s*(?:mode\s*=\s*)?["'][wax]/g,
  /\bPath\(\s*(["'])([^"'\n]+)\1\s*\)\s*\.write_(?:text|bytes)\(/g,
  // Node: fs.writeFileSync('f', …), appendFile…
  /\b(?:writeFile|appendFile)(?:Sync)?\(\s*(["'`])([^"'`\n]+)\1/g,
];

/** How far a call's or a `def`'s parentheses are read: one that does not close by then is not read at all. */
const ARGS_SPAN = 4000;

/**
 * The arguments of a call (or a `def`'s parameters) whose `(` is just before `from`, as written: strings and brackets kept
 * whole, so `dict[str, int]` or `[[1, 2]]` is one. `end` is just past its `)`, or -1 when it does not close within ARGS_SPAN.
 */
const callArgs = (text: string, from: number): { args: string[]; end: number } => {
  const args: string[] = [];
  const limit = Math.min(text.length, from + ARGS_SPAN);
  let depth = 0;
  let start = from;
  for (let i = from; i < limit; i += 1) {
    const char = text[i]!;
    if (char === "'" || char === '"') {
      const quote = text.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      const end = text.indexOf(quote, i + quote.length);
      if (end < 0 || end >= limit) break;
      i = end + quote.length - 1;
    } else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char) && depth > 0) depth -= 1;
    else if ((char === "," || char === ")") && depth === 0) {
      const arg = text.slice(start, i).trim();
      if (arg || char === ",") args.push(arg);
      start = i + 1;
      if (char === ")") return { args, end: i + 1 };
    }
  }
  return { args, end: -1 };
};

const NAME = /^[A-Za-z_]\w*$/;

/** How much of a script's helpers is read: its first `def`s, their first parameters, their bodies up to a total, and calls to them. */
const MAX_DEFS = 200;
const MAX_PARAMS = 32;
const MAX_BODIES = 2_000_000;
const MAX_CALLS = 1000;
const MAX_CALLS_EACH = 200;

type Def = {
  name: string;
  /** The parameter each argument given by position lands in (null for one that is no plain name). */
  positions: Array<string | null>;
  /** Every parameter a call can name: `fn(path='f')`. */
  names: string[];
  /** Where the `def` is, and its own lines: those after it indented deeper than it (the `def` line's rest for a one-liner). */
  at: number;
  from: number;
  to: number;
};

/** A Python script's functions: `def name(params) -> annotation:`, parameters read whole whatever their type hints. */
const defs = (text: string): Def[] => {
  const found: Def[] = [];
  let read = 0;
  for (const match of text.matchAll(/^([\t ]*)def[\t ]+([A-Za-z_]\w*)[\t ]*\(/gm)) {
    if ((read += 1) > MAX_DEFS) break;
    const { args, end } = callArgs(text, match.index! + match[0].length);
    // Past `-> annotation` to the header's `:`.
    const header = end < 0 ? null : /^[^:\n]{0,200}:/.exec(text.slice(end, end + 201));
    if (!header) continue;
    const depth = match[1]!.length;
    const from = end + header[0].length;
    let to = text.indexOf("\n", from);
    if (to < 0) to = text.length;
    // Its lines: those indented deeper than the `def`, and blank ones among them.
    for (let base = to + 1; base < text.length; ) {
      let indent = base;
      while (indent < text.length && indent - base <= depth && (text[indent] === " " || text[indent] === "\t")) indent += 1;
      if (indent - base <= depth && indent < text.length && text[indent] !== "\n" && text[indent] !== "\r") break;
      let next = text.indexOf("\n", base);
      if (next < 0) next = text.length;
      to = next;
      base = next + 1;
    }
    const positions: Array<string | null> = [];
    const names: string[] = [];
    let keywordsOnly = false;
    for (const arg of args) {
      const name = arg.replace(/[:=][\s\S]*$/, "").trim();
      // `/`: those before it are given by position only, which moves no position.
      if (name === "/") continue;
      // `*` or `*args`: those after it are given by name only; `**kwargs` is the last.
      if (name.startsWith("*")) {
        keywordsOnly = true;
        continue;
      }
      const plain = NAME.test(name) ? name : null;
      if (plain && names.length < MAX_PARAMS && !names.includes(plain)) names.push(plain);
      if (!keywordsOnly) positions.push(plain);
    }
    found.push({ name: match[2]!, positions, names, at: match.index!, from, to });
  }
  return found;
};

const LITERAL = /^(["'])([^"'\n]+)\1$/;
/** A value that is a path: `'f'` or `Path('f')`, the rest of its line no more than another statement or a comment. */
const PATH_VALUE = /^(?:(?:pathlib\.)?Path\(\s*(["'])([^"'\n]+)\1\s*\)|(["'])([^"'\n]+)\3)\s*(?:[;#].*)?$/;
/** Whether a plain `name=` at `at` is a call's keyword argument, `f(name=…)` or `f(a, name=…)`, rather than an assignment. */
const keywordArgument = (text: string, at: number, plain: string | undefined): boolean => {
  if (plain === undefined) return false;
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i -= 1;
  return text[i] === "(" || text[i] === ",";
};
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `name = …` (also `name: T = …`, `name += …`, `name := …`), not `self.name = …` or `name == …`; the value is read from the lookahead. */
const ASSIGNMENT = (names: string) =>
  new RegExp(
    String.raw`(?<![\w.])(${names})[\t ]*(?:(?<plain>(?::[^=\n]{1,200})?=(?!=))|:=|(?:[-+*/%@&|^]|//|\*\*|<<|>>)=)[\t ]*(?=([^\n]{0,400}))`,
    "g",
  );

/**
 * Python's paths given by name: `p = 'f'` … `open(p, 'w')` (the value `p` has there: the last one before it),
 * and a helper's — `def edit(p, …): … open(p, 'w')`, then `edit('f', …)` writes f.
 */
const writesThroughVariables = (text: string): Array<{ path: string; at: number }> => {
  // Each name's values in order: a path, or undefined for any other value, so the last one before a write is the one it has.
  const assigned = new Map<string, Array<{ at: number; path: string | undefined }>>();
  for (const match of text.matchAll(ASSIGNMENT(String.raw`[A-Za-z_]\w*`))) {
    if (keywordArgument(text, match.index!, match.groups!.plain)) continue;
    const value = match.groups!.plain === undefined ? null : PATH_VALUE.exec(match[3]!.trimEnd());
    const values = assigned.get(match[1]!) ?? [];
    values.push({ at: match.index!, path: value ? (value[2] ?? value[4]) : undefined });
    assigned.set(match[1]!, values);
  }
  const functions = defs(text);
  // Inside a function its own parameter is whatever each call gives it, not a value from outside.
  const valueAt = (name: string, at: number): string | undefined => {
    if (functions.some((fn) => at >= fn.from && at < fn.to && fn.names.includes(name))) return undefined;
    const values = assigned.get(name) ?? [];
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[middle]!.at < at) low = middle + 1;
      else high = middle;
    }
    return low ? values[low - 1]!.path : undefined;
  };
  const pathOf = (arg: string | undefined, at: number): string | undefined => {
    if (!arg) return undefined;
    const literal = LITERAL.exec(arg)?.[2];
    return literal ?? (NAME.test(arg) ? valueAt(arg, at) : undefined);
  };
  const found: Array<{ path: string; at: number }> = [];
  // A name written to: `open(name, 'w')`, `name.write_text(…)`, `Path(name).write_text(…)` — not `self.name` or `other_name`.
  const writing = (names: string) => [
    new RegExp(String.raw`\bopen\(\s*(${names})\s*,\s*(?:mode\s*=\s*)?["'][wax]`, "g"),
    new RegExp(String.raw`(?<![\w.])(?:(?:pathlib\.)?Path\(\s*(${names})\s*\)|(${names}))\s*\.write_(?:text|bytes)\(`, "g"),
  ];
  for (const pattern of writing(String.raw`[A-Za-z_]\w*`))
    for (const match of text.matchAll(pattern)) {
      const path = pathOf(match[1] ?? match[2], match.index!);
      if (path) found.push({ path, at: match.index! });
    }
  let bodies = 0;
  let calls = 0;
  for (const [index, fn] of functions.entries()) {
    if (fn.names.length === 0) continue;
    if ((bodies += fn.to - fn.from) > MAX_BODIES || calls >= MAX_CALLS) break;
    const body = text.slice(fn.from, fn.to);
    if (!body.includes("open(") && !body.includes(".write_")) continue;
    const names = fn.names.join("|");
    const written = new Set<string>();
    for (const pattern of writing(names)) for (const match of body.matchAll(pattern)) written.add((match[1] ?? match[2])!);
    if (written.size === 0) continue;
    // A parameter given a new value in the body is no longer what the call gave it — unless it is that path as a Path.
    for (const match of body.matchAll(ASSIGNMENT(names)))
      if (keywordArgument(body, match.index!, match.groups!.plain)) continue;
      else if (match.groups!.plain === undefined || !new RegExp(String.raw`^(?:pathlib\.)?Path\(\s*${match[1]}\s*\)\s*(?:[;#].*)?$`).test(match[3]!.trimEnd()))
        written.delete(match[1]!);
    // Rebound by a loop or a `with … as`: `for path in …`, `for i, path in …`, `as path`.
    for (const match of body.matchAll(/\bfor\b([^\n:]{0,200}?)\bin\b|\bas[\t ]+([A-Za-z_]\w*)/g))
      for (const name of match[1]?.match(/(?<![\w.])[A-Za-z_]\w*/g) ?? [match[2]!]) written.delete(name);
    if (written.size === 0) continue;
    // Its calls: after it, up to where a function of the same name replaces it.
    const until = functions.slice(index + 1).find((other) => other.name === fn.name)?.at ?? text.length;
    const call = new RegExp(String.raw`(?<![\w.])${fn.name}\(`, "g");
    const keyword = new Map([...written].map((param) => [param, new RegExp(String.raw`^${param}\s*=(?!=)\s*([\s\S]+)$`)] as const));
    call.lastIndex = fn.to;
    let each = 0;
    for (let match = call.exec(text); match && match.index < until; match = call.exec(text)) {
      if ((each += 1) > MAX_CALLS_EACH || (calls += 1) > MAX_CALLS) break;
      const at = match.index;
      const { args } = callArgs(text, call.lastIndex);
      for (const param of written) {
        const named = args.map((arg) => keyword.get(param)!.exec(arg)?.[1]).find(Boolean);
        const position = fn.positions.indexOf(param);
        const positional = position >= 0 ? args[position] : undefined;
        const path = pathOf(named ?? (positional && !/^\w+\s*=[^=]/.test(positional) ? positional : undefined), at);
        if (path) found.push({ path, at });
      }
    }
  }
  return found;
};

type Heredoc = {
  /** The `<<EOF` itself. */
  opener: { from: number; to: number };
  /** Its lines, without the one that ends it. */
  body: { from: number; to: number };
  /** What goes from the command with it: the body and its end, from the newline before them. */
  cut: { from: number; to: number };
  /** Whether a script interpreter reads it (`python3 - <<'EOF'`), rather than a command taking it as data (`cat > f <<EOF`). */
  script: boolean;
};

const INTERPRETER = String.raw`(?:python[\d.]*|node(?:js)?|deno|bun|tsx|ts-node|ruby|perl|php|bash|sh|zsh)`;
const INTERPRETERS = new RegExp(String.raw`(?:^|[\s;|&(/])${INTERPRETER}(?=$|[\s;|&)<>])`);
/** A file run as a script: `python3 f.py`, `bash -e f.sh`, `npx tsx f.ts`, `./f.sh`, `. f.sh`, `/usr/bin/python3 f.py`. */
const RUNS = (file: string) =>
  new RegExp(
    String.raw`(?:^|[;&|(\n])[\t ]*(?:(?:(?:npx|bunx|exec|sudo|uv[\t ]+run)[\t ]+)?(?:(?:[^\s;|&()<>]*/)?${INTERPRETER}|source|\.)[\t ]+(?:-[^\s;|&()<>]+[\t ]+)*)?(?:\./)?${escaped(file.replace(/^(?:\.\/)+/, ""))}(?=$|[\s;|&)])`,
  );

/** How many heredocs a command is read for, and how many `<<` it looks at to find them. */
const MAX_HEREDOCS = 50;
const MAX_OPENERS = 200;

/**
 * Reads a command for what its quotes, `$((…))` and `$(…)` open, so that a `<<` is a heredoc only where the shell itself
 * reads it: not in `"a<<b"`, `'1<<4'` or `$((1 << n))`, but in `"$(cat <<'EOF' …)"`. Heredoc bodies (`skips`) are passed over.
 * Asked for positions in order: whether the shell reads its own words there.
 */
const shellReads = (command: string, skips: Map<number, number>) => {
  const open: Array<'"' | "(" | "((" | "inner"> = [];
  let i = 0;
  return (until: number): boolean => {
    for (; i < until; i += 1) {
      const skip = skips.get(i);
      if (skip !== undefined) {
        i = skip - 1;
        continue;
      }
      const char = command[i]!;
      const top = open.at(-1);
      if (char === "\\") {
        i += 1;
      } else if (top === '"') {
        if (char === '"') open.pop();
        else if (char === "$" && command[i + 1] === "(") {
          const arithmetic = command[i + 2] === "(";
          open.push(arithmetic ? "((" : "(");
          i += arithmetic ? 2 : 1;
        }
      } else if (top === "((" || top === "inner") {
        if (char === "(") open.push("inner");
        else if (char === ")") {
          if (top === "((" && command[i + 1] === ")") i += 1;
          open.pop();
        }
      } else if (char === "'") {
        const end = command.indexOf("'", i + 1);
        i = end < 0 ? command.length : end;
      } else if (char === '"') {
        open.push('"');
      } else if (char === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
        const end = command.indexOf("\n", i);
        i = (end < 0 ? command.length : end) - 1;
      } else if (char === "(") {
        if (command[i + 1] === "(") {
          open.push("((");
          i += 1;
        } else open.push("(");
      } else if (char === ")" && top === "(") {
        open.pop();
      }
    }
    return i === until && (open.length === 0 || open.at(-1) === "(");
  };
};

/** The file a heredoc's own command writes it to: `cat > f <<EOF`, `cat <<EOF >> f`, `tee f <<EOF`. */
const heredocFile = (command: string, opener: { from: number; to: number }): string | undefined => {
  const lineStart = command.lastIndexOf("\n", opener.from - 1) + 1;
  let lineEnd = command.indexOf("\n", opener.to);
  if (lineEnd < 0) lineEnd = command.length;
  const before = command.slice(lineStart, opener.from);
  const after = command.slice(opener.to, lineEnd);
  const separator = /[;&|]/.exec(after);
  const own = `${before.slice(Math.max(before.lastIndexOf(";"), before.lastIndexOf("&"), before.lastIndexOf("|")) + 1)} ${separator ? after.slice(0, separator.index) : after}`;
  const files = [...own.matchAll(/(?:>>?|>\|)[\t ]*(["']?)([^\s;|&<>()'"]+)\1/g), ...own.matchAll(/(?:^|\s)tee[\t ]+(?:-\S+[\t ]+)*(["']?)([^\s;|&<>()'"]+)\1/g)];
  return files.map((match) => match[2]!).find((file) => !file.startsWith("/dev/"));
};

/**
 * A command's heredocs: `<<EOF`, `<<-'EOF'`, `<<"END-DOC"`, `<<\EOF`; not `<<<` (a here-string), nor a shift (`1<<4`, `$((x << n))`)
 * or a `<<` in quotes. The body is the lines after the opener's line up to one that is only the delimiter; the rest of the
 * opener's line (`cat <<'EOF' > out.txt`) stays shell. A command flattened to one line ends its body at the delimiter as a word.
 */
const heredocs = (command: string): Heredoc[] => {
  const found: Heredoc[] = [];
  const skips = new Map<number, number>();
  const reads = shellReads(command, skips);
  const opener = /(?<!<)(?<!(?:^|[^\w.$])\d+)<<(?!<)-?[\t ]*(?:(["'])([^"'\n]+)\1|\\?([A-Za-z_][^\s;|&<>()'"\\]*))/g;
  // The last opener's line: where it ends, where the bodies of its openers end, and whether an interpreter reads them.
  let line = { end: -1, bodies: -1, script: false };
  let tried = 0;
  for (let match = opener.exec(command); match && found.length < MAX_HEREDOCS && (tried += 1) <= MAX_OPENERS; match = opener.exec(command)) {
    // Inside the bodies of that line's openers: past them.
    if (match.index > line.end && match.index < line.bodies) {
      opener.lastIndex = line.bodies;
      continue;
    }
    if (!reads(match.index)) continue;
    const delimiter = escaped(match[2] ?? match[3]!);
    const at = { from: match.index, to: opener.lastIndex };
    const lineStart = command.lastIndexOf("\n", match.index - 1) + 1;
    const lineEnd = command.indexOf("\n", at.to);
    if (lineEnd < 0) {
      const close = new RegExp(`\\s${delimiter}(?=\\s|$|[;|&)])`).exec(command.slice(at.to));
      const to = close ? at.to + close.index : command.length;
      const end = close ? to + close[0].length : command.length;
      found.push({ opener: at, body: { from: at.to, to }, cut: { from: at.to, to: end }, script: INTERPRETERS.test(command.slice(lineStart, match.index)) });
      if (end > at.to) skips.set(at.to, end);
      opener.lastIndex = end;
      continue;
    }
    // A second opener on a line: its body follows the first one's.
    const same = line.end === lineEnd;
    const newline = same ? line.bodies : lineEnd;
    const close = new RegExp(`\\n[\\t ]*${delimiter}[\\t ]*(?=\\n|$)`, "g");
    close.lastIndex = newline;
    const hit = close.exec(command);
    const from = Math.min(command.length, newline + 1);
    const body = { from, to: Math.max(from, hit ? hit.index : command.length) };
    const cut = { from: newline, to: hit ? hit.index + hit[0].length : command.length };
    const script = same ? line.script : INTERPRETERS.test(command.slice(lineStart, lineEnd).replace(/(?<!<)(?<!(?:^|[^\w.$])\d+)<<(?!<)-?[\t ]*\S+/g, " "));
    found.push({ opener: at, body, cut, script });
    if (cut.to > cut.from) skips.set(cut.from, cut.to);
    line = { end: lineEnd, bodies: cut.to, script };
    opener.lastIndex = at.to;
  }
  // A script written to a file and run after it: `cat > /tmp/fix.py <<'EOF' … EOF` then `python3 /tmp/fix.py`.
  for (const doc of found) {
    if (doc.script) continue;
    const file = heredocFile(command, doc.opener);
    if (file && RUNS(file).test(command.slice(doc.cut.to))) doc.script = true;
  }
  return found;
};

/**
 * Words of a shell command, quotes removed, with the operators that separate commands and redirections as their own words.
 * `fds`: a redirection keeps the file descriptor written before it (`2>`, `2>&`); otherwise it is dropped.
 */
const tokenize = (text: string, fds = false): string[] => {
  const tokens: string[] = [];
  let current = "";
  let open = false;
  const flush = () => {
    if (open) tokens.push(current);
    current = "";
    open = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "'" || char === '"') {
      const end = text.indexOf(char, i + 1);
      if (end < 0) return [...tokens, ...(open ? [current] : [])];
      current += text.slice(i + 1, end);
      open = true;
      i = end;
    } else if (char === "\\" && text[i + 1] === "\n") {
      i += 1; // a line continued
    } else if (char === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      open = true;
      i += 1;
    } else if (char === "#" && !open) {
      // A comment, to the end of its line.
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1;
    } else if (char === "\n") {
      // A line ends a command, as ; does.
      flush();
      tokens.push(";");
    } else if (/\s/.test(char)) {
      flush();
    } else if (";|&<>()".includes(char)) {
      // A digit right before > is its file descriptor (2>), not a word; not the one a dup names (`2>&1>/dev/null`).
      let fd = "";
      if (char === ">" && /^\d$/.test(current) && open && !/[<>]&$/.test(tokens.at(-1) ?? "")) {
        fd = fds ? current : "";
        current = "";
        open = false;
      }
      flush();
      let op = fd + char;
      // A subshell's ( and ) stand alone: `); next` is a close, then a separator.
      if (char !== "(" && char !== ")") while (i + 1 < text.length && ";|&<>".includes(text[i + 1]!)) op += text[++i];
      tokens.push(op);
    } else {
      current += char;
      open = true;
    }
  }
  flush();
  return tokens;
};

const isOperator = (token: string) => /^[;|&<>()]+$/.test(token);
/** An operator, or a redirection with the file descriptor tokenize kept for it (`2>`, `2>&`). */
const isStepOperator = (token: string) => isOperator(token) || /^\d[<>][;|&<>]*$/.test(token);
const SEPARATORS = new Set([";", "&&", "||", "|", "&", "(", ")", "|&", ";;", ";&", ";;&"]);
/** Words before a command that are not it: `then cd ui`, `if cd ui`, `! sed -i …`. */
const KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "{", "!", "time"]);

/** Where a command runs, relative to the workspace ("" is its root, an absolute path outside it); null once a `cd` goes somewhere unknown (`cd $DIR`, `cd -`). */
export type ShellCwd = string | null;

/** An absolute path inside the workspace (any of the ways `roots` spell it) as relative to it ("" is its root); others as they are. */
export function fromWorkspace(path: string, roots: readonly string[]): string {
  const normal = posix.normalize(path).replace(/(.)\/+$/, "$1");
  for (const root of roots) {
    const base = posix.normalize(root).replace(/(.)\/+$/, "$1");
    if (normal === base) return "";
    if (normal.startsWith(`${base}/`)) return normal.slice(base.length + 1);
  }
  return normal;
}

/** `cd`'s directory from where the shell is now: null when it cannot be told from the command (or is past any real depth). */
const cdTo = (cwd: ShellCwd, args: string[], roots: readonly string[]): ShellCwd => {
  const arg = args.find((word) => !/^-[LPe@]+$/.test(word));
  if (arg === "-" || (arg !== undefined && /[*?$`{}'"]/.test(arg))) return null;
  // `cd` and `cd ~` go home; `~user` is someone's home, not known here.
  const dir = arg === undefined || arg === "~" ? homedir() : arg.startsWith("~/") ? `${homedir()}${arg.slice(1)}` : arg.startsWith("~") ? null : arg;
  if (dir === null) return null;
  const next = dir.startsWith("/") ? fromWorkspace(dir, roots) : cwd === null ? null : relativeTo(cwd, dir, roots);
  return next !== null && next.length > 1024 ? null : next;
};

/** A path from a directory: relative to the workspace, or absolute outside it (`cd .. && cd ws/ui`, `cd /tmp/x && cd ../ws/ui` may come back in). */
const relativeTo = (cwd: string, path: string, roots: readonly string[]): string => {
  const joined = posix.normalize(cwd ? `${cwd}/${path}` : path).replace(/(.)\/+$/, "$1");
  // Above the workspace: where that is, from the workspace's own path.
  if ((joined === ".." || joined.startsWith("../")) && roots[0]) return fromWorkspace(posix.join(roots[0], joined), roots);
  if (joined.startsWith("/")) return fromWorkspace(joined, roots);
  return joined === "." ? "" : joined;
};

/**
 * Where the shell is through a command: after each `cd` at a command's start (`then cd ui` too), and back where it was at the
 * end of the subshell it ran in. Quotes, comments and heredoc bodies are passed over. In order of position.
 */
const cdsIn = (command: string, docs: Heredoc[], cwd: ShellCwd, roots: readonly string[]): Array<{ at: number; cwd: ShellCwd }> => {
  const skips = new Map(docs.filter(({ cut }) => cut.to > cut.from).map(({ cut }) => [cut.from, cut.to] as const));
  const found: Array<{ at: number; cwd: ShellCwd }> = [];
  const outer: ShellCwd[] = [];
  let at = cwd;
  let start = true;
  for (let i = 0; i < command.length; i += 1) {
    const skip = skips.get(i);
    if (skip !== undefined) {
      i = skip - 1;
      continue;
    }
    const char = command[i]!;
    if (char === "\\") {
      // `\` and a newline continue the line; any other escaped character is a word's.
      if (command[i + 1] !== "\n") start = false;
      i += 1;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      i = end < 0 ? command.length : end;
      start = false;
    } else if (char === '"') {
      for (i += 1; i < command.length && command[i] !== '"'; i += 1) {
        const inner = skips.get(i);
        if (inner !== undefined) i = inner - 1;
        else if (command[i] === "\\") i += 1;
      }
      start = false;
    } else if (char === "#" && (i === 0 || /[\s;&|()]/.test(command[i - 1]!))) {
      const end = command.indexOf("\n", i);
      i = (end < 0 ? command.length : end) - 1;
    } else if (char === "(") {
      outer.push(at);
      start = true;
    } else if (char === ")") {
      if (outer.length) {
        at = outer.pop()!;
        found.push({ at: i + 1, cwd: at });
      }
      start = false;
    } else if (char === ";" || char === "&" || char === "|" || char === "\n") {
      start = true;
    } else if (char !== "<" && char !== ">" && !/\s/.test(char)) {
      let end = i;
      while (end < command.length && !/[\s;&|()<>'"\\]/.test(command[end]!)) end += 1;
      const word = command.slice(i, end);
      i = end - 1;
      if (!start || KEYWORDS.has(word)) continue;
      start = false;
      if (word === "popd") {
        at = null;
        found.push({ at: end, cwd: at });
      } else if (word === "cd" || word === "pushd") {
        // Its words, to the end of the command (a line continued goes on).
        let stop = end;
        while (stop < command.length && !";&|)<>\n".includes(command[stop]!)) stop += command[stop] === "\\" ? 2 : 1;
        stop = Math.min(stop, command.length);
        at = cdTo(at, command.slice(end, stop).replace(/\\\n/g, " ").trim().split(/\s+/).filter(Boolean), roots);
        found.push({ at: stop, cwd: at });
        i = stop - 1;
      }
    }
  }
  return found;
};

/** How much of a command is read: a longer one's rest is not. */
const MAX_COMMAND = 100_000;

/** A command as the shell reads it: a heredoc's body is not more shell (a script reads it), its opener's line is. */
const shellText = (command: string, docs: Heredoc[]): string => {
  const cuts = docs.flatMap(({ opener, cut }) => [{ ...opener, with: " " }, { ...cut, with: "" }]).sort((a, b) => a.from - b.from);
  let shell = "";
  let from = 0;
  for (const cut of cuts) {
    if (cut.from < from) continue;
    shell += command.slice(from, cut.from) + cut.with;
    from = cut.to;
  }
  return shell + command.slice(from);
};

/** Words before a command that only run it: `sudo git push`, `env X=1 gh pr create`, `nohup gh pr create`. */
const WRAPPERS = ["sudo", "command", "exec", "env", "builtin", "nohup", "time"];

/** Past keywords, variable assignments and wrappers (`time -p`) to the command itself: where its name is. */
const commandStart = (words: readonly string[]): number => {
  let start = 0;
  while (start < words.length) {
    const word = words[start]!;
    if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word) || WRAPPERS.includes(word)) start += 1;
    else if (word === "-p" && words[start - 1] === "time") start += 1;
    else break;
  }
  return start;
};

/** A shell that runs its `-c` argument as a command: `bash -c "gh pr create"`, `zsh -lc '…'`. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * The commands a shell is given with `-c`: its first operand, as the shell reads its options (`bash -euo pipefail -c
 * '…'`). After a script's name the words are the script's own: `bash ./x.sh -c` runs no `-c` string.
 */
const shellString = (words: readonly string[]): string | undefined => {
  let given = false;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i]!;
    if (word === "--" || word === "-") return given ? words[i + 1] : undefined;
    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.startsWith("-") && word.includes("c")) given = true;
      // `-o pipefail`: the option's name is the next word.
      if (/[oO]$/.test(word)) i += 1;
      continue;
    }
    // `--rcfile ~/.rc`: the file is the option's.
    if (word === "--rcfile" || word === "--init-file") i += 1;
    if (word.startsWith("--")) continue;
    return given ? word : undefined;
  }
  return undefined;
};

/**
 * The commands a shell command runs, each as its words with quotes removed: past keywords, variable assignments and
 * wrappers, without redirections; a shell's `-c` string is read as the commands it runs. Words in quotes, in comments
 * or in a heredoc's body are no command of their own: `echo 'gh pr create'` is `echo`, `git commit -m 'git push -f'`
 * is `git commit`.
 */
export function shellCommands(command: string): string[][] {
  return shellSteps(command).map((step) => step.words);
}

/** Where a command's stdout or stderr goes, as the shell around it has them: its stdout ("1"), its stderr ("2"), or away. */
type Fd = "1" | "2" | "away";
type Fds = Record<string, Fd>;
const shown = (): Fds => ({ "1": "1", "2": "2" });

/** A redirection on a table of where a command's descriptors go: `2>&1`, `>&2`, `2>&-`, `2>/dev/null`, `&> log`, `>& log`. */
const redirect = (fds: Fds, op: string, to: string): void => {
  const dup = /^(\d?)>&$/.exec(op);
  if (dup && (dup[1] || /^(?:\d+|-)$/.test(to))) {
    // `2>&1`: stderr goes where stdout goes now; `2>&-` closes it; a descriptor not open is no output either.
    fds[dup[1] || "1"] = to === "-" ? "away" : (fds[String(Number(to))] ?? "away");
    return;
  }
  const into = /^(\d?)(>|>>|>\||&>|&>>|>&)$/.exec(op);
  if (!into) return;
  // `>/dev/stderr`, `>/dev/fd/2`: to that descriptor, not away (one not open is no output).
  const number = /^\/dev\/fd\/(\d+)$/.exec(to)?.[1];
  const fd = to === "/dev/stdout" ? "1" : to === "/dev/stderr" ? "2" : number === undefined ? undefined : String(Number(number));
  const where: Fd = fd === undefined ? "away" : (fds[fd] ?? "away");
  if (into[2]!.includes("&")) fds["1"] = fds["2"] = where;
  else fds[into[1] || "1"] = where;
};

/** A table as seen from outside its subshell or `sh -c`: what goes to the subshell's stdout goes where the subshell's does. */
const through = (inner: Fds, outer: Fds): Fds =>
  Object.fromEntries(Object.entries(inner).map(([fd, where]) => [fd, where === "away" ? "away" : (outer[where] ?? "away")]));

/**
 * The simple commands of a shell command, in order: their words, the operator that joins each to the one before (`&&`,
 * `||`, `|`, `;`; none for the first; a `-c` string's first command takes its shell's), and `hushed` when its stderr,
 * where git push prints what it did, goes away (`2>/dev/null`, `&> log`, `> log 2>&1`, a subshell's or `sh -c`'s).
 */
export function shellSteps(command: string): Array<{ words: string[]; after?: string; hushed?: true; negated?: true }> {
  return steps(command, 0).map(({ words, after, fds, negated }) => ({
    words,
    ...(after ? { after } : {}),
    ...(fds["2"] === "away" ? { hushed: true as const } : {}),
    ...(negated ? { negated } : {}),
  }));
}

function steps(command: string, depth: number): Array<{ words: string[]; after?: string; fds: Fds; negated?: true }> {
  if (command.length > MAX_COMMAND) command = command.slice(0, MAX_COMMAND);
  const tokens = tokenize(shellText(command, heredocs(command)), true);
  const commands: Array<{ words: string[]; after?: string; fds: Fds }> = [{ words: [], fds: shown() }];
  // Each subshell: where its commands begin and end, the one it is in, and the redirections after its `)`, put on its
  // commands once all are read (at each `)`, they would be read again for every subshell around them).
  const subshells: Array<{ from: number; to: number; parent: number; fds: Fds }> = [];
  // The open ones, innermost last: a subshell, a braced group or a `case` (to its `esac`; its patterns end in a `)` of
  // their own, and it takes the redirections after it as a subshell does); the order they closed in; the one just
  // closed, while the redirections after it come.
  const open: Array<{ kind: "(" | "{" | "case"; id: number; pattern?: boolean }> = [];
  const closing: number[] = [];
  let closed: number | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const step = commands.at(-1)!;
    const inner = open.at(-1);
    // Where a command starts: no word yet, or keywords only (`then {`, `do {`, `! {`).
    const starts = step.words.every((word) => KEYWORDS.has(word));
    // A braced group (`{` where a command starts, to its `}`) takes the redirections after it as a subshell does.
    const token = starts && (tokens[i] === "{" || (tokens[i] === "}" && inner?.kind === "{")) ? (tokens[i] === "{" ? "(" : ")") : tokens[i]!;
    if (inner?.kind === "case") {
      // `case $x in a) …;; (b) …;; esac`: after `in` and each `;;` comes a pattern, up to its `)`.
      if (token === "in" && step.words.length === step.words.lastIndexOf("case") + 2) inner.pattern = true;
      else if (token === ";;" || token === ";&" || token === ";;&") inner.pattern = true;
      else if (inner.pattern && tokens[i] === "(" && !step.words.length) continue;
      else if (inner.pattern && tokens[i] === ")") {
        inner.pattern = false;
        closed = undefined;
        if (step.words.length) commands.push({ words: [], after: ")", fds: shown() });
        continue;
      } else if (token === "esac" && starts) {
        open.pop();
        if (step.words.length) commands.push({ words: [], fds: shown() });
        subshells[inner.id]!.to = commands.length - 1;
        closing.push(inner.id);
        closed = inner.id;
        continue;
      }
    }
    if (token === "case" && starts) {
      subshells.push({ from: commands.length - 1, to: -1, parent: inner?.id ?? -1, fds: shown() });
      open.push({ kind: "case", id: subshells.length - 1, pattern: false });
    }
    if (SEPARATORS.has(token)) {
      closed = undefined;
      // `a || (b)`: b is joined by the `||`, not by the parenthesis; `a ||` and a new line: still the `||`; `(a)` and a
      // new line: the new line.
      if (step.words.length) commands.push({ words: [], after: token, fds: shown() });
      else {
        if (token !== "(" && token !== ")" && !(token === ";" && step.after && step.after !== ")")) step.after = token;
        // A redirection with no command (`> log;`) is no later command's.
        step.fds = shown();
      }
      if (token === "(") {
        subshells.push({ from: commands.length - 1, to: -1, parent: inner?.id ?? -1, fds: shown() });
        open.push({ kind: tokens[i] === "{" ? "{" : "(", id: subshells.length - 1 });
      }
      // A `)` closes a subshell, a `}` its braced group (a `)` with a group or a `case` open closes neither).
      const id = token === ")" && inner?.kind === (tokens[i] === "}" ? "{" : "(") ? (open.pop(), inner!.id) : undefined;
      if (id !== undefined && subshells[id]!.from < commands.length - 1) {
        subshells[id]!.to = commands.length - 1;
        closing.push(id);
        closed = id;
      }
    } else if (isStepOperator(token)) {
      // A redirection's file is no word of the command; after a subshell's `)`, it is the subshell's.
      const to = tokens[i + 1];
      if (/^\d?(?:<|>|>>|>\||&>|&>>|<<<|>&|<&)$/.test(token) && to !== undefined && !isStepOperator(to)) {
        i += 1;
        redirect(closed !== undefined && !step.words.length ? subshells[closed]!.fds : step.fds, token, to);
      }
    } else {
      closed = undefined;
      step.words.push(token);
    }
  }
  // Where a subshell's commands write, through every subshell around it (an outer one comes before the ones in it).
  const outward = subshells.map((one) => one.fds);
  subshells.forEach((one, id) => {
    if (one.parent >= 0) outward[id] = through(one.fds, outward[one.parent]!);
  });
  // Each command's innermost subshell (those inside one closed before it, and are passed over in a step).
  const innermost: Array<number | undefined> = [];
  const past = new Map<number, number>();
  for (const id of closing) {
    const { from, to } = subshells[id]!;
    for (let at = from; at < to; ) {
      const end = past.get(at);
      if (end !== undefined) at = end;
      else innermost[at++] = id;
    }
    past.set(from, to);
  }
  innermost.forEach((id, at) => {
    if (id !== undefined) commands[at]!.fds = through(commands[at]!.fds, outward[id]!);
  });
  return commands
    .map((step) => {
      const start = commandStart(step.words);
      return { ...step, words: step.words.slice(start), ...(step.words.slice(0, start).includes("!") ? { negated: true as const } : {}) };
    })
    .filter((step) => step.words.length > 0)
    .flatMap((step) => {
      const string = SHELLS.has(step.words[0]!.split("/").at(-1)!) ? shellString(step.words) : undefined;
      if (string === undefined || depth >= 3) return [step];
      // `sh -c '…' 2>/dev/null`: what runs in it writes where the shell does.
      return steps(string, depth + 1).map((inner, at) => {
        const after = at === 0 ? step.after : inner.after;
        return { words: inner.words, ...(after ? { after } : {}), fds: through(inner.fds, step.fds), ...(inner.negated ? { negated: inner.negated } : {}) };
      });
    });
}

/**
 * Paths a shell command names as written, relative to the workspace: resolved against where the command ran
 * (`cwd`, the workspace root by default) and any `cd` before them, so `cd sub && echo > b.txt` is `sub/b.txt`.
 * A path outside the workspace stays absolute; one after a `cd` to somewhere unknown is left out.
 */
export function shellWriteTargets(command: string, cwd: ShellCwd = "", roots: readonly string[] = []): string[] {
  return shellWrites(command, cwd, roots).targets;
}

/**
 * The paths a command names as written (see shellWriteTargets), and where the shell is when it ends.
 * `roots` are the workspace's absolute path (and its real path): a path or `cd` under one is relative to it.
 */
export function shellWrites(command: string, cwd: ShellCwd = "", roots: readonly string[] = []): { targets: string[]; cwd: ShellCwd } {
  if (command.length > MAX_COMMAND) command = command.slice(0, MAX_COMMAND);
  const found = new Set<string>();
  const add = (path: string | undefined, from: ShellCwd) => {
    if (!path || path.startsWith("/dev/") || path.startsWith("-") || /[*?$`{}]/.test(path)) return;
    const target = path.startsWith("/") ? fromWorkspace(path, roots) : from === null ? "" : relativeTo(from, path, roots);
    if (target) found.add(target);
  };
  const docs = heredocs(command);
  // What a script interpreter may run: the command with the heredocs given to other commands as data blanked out.
  let script = command;
  for (const { body, script: run } of docs) if (!run) script = script.slice(0, body.from) + script.slice(body.from, body.to).replace(/[^\n]/g, " ") + script.slice(body.to);
  // A script's own writes are relative to where it runs: after the `cd`s before it in the command.
  const cds = cdsIn(command, docs, cwd, roots);
  const cwdAt = (index: number): ShellCwd => {
    // The last cd at or before index.
    let low = 0;
    let high = cds.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (cds[middle]!.at <= index) low = middle + 1;
      else high = middle;
    }
    return low ? cds[low - 1]!.cwd : cwd;
  };
  for (const pattern of INTERPRETER_WRITES) for (const match of script.matchAll(pattern)) add(match[2], cwdAt(match.index!));
  for (const { path, at } of writesThroughVariables(script)) add(path, cwdAt(at));

  const tokens = tokenize(shellText(command, docs));
  // Commands in order, each with the files it redirects into; "(" and ")" open and close a subshell, whose `cd` ends with it.
  type Segment = { words: string[]; redirects: string[]; paren?: "(" | ")" };
  const segments: Segment[] = [{ words: [], redirects: [] }];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === ">" || token === ">>" || token === ">|" || token === "&>" || token === "&>>") {
      const next = tokens[i + 1];
      if (next !== undefined && !isOperator(next)) {
        segments.at(-1)!.redirects.push(next);
        i += 1;
      }
      continue;
    }
    if (token === ">&") {
      i += 1; // 2>&1: another descriptor, not a file
      continue;
    }
    if (token === "(" || token === ")") {
      segments.push({ words: [], redirects: [], paren: token }, { words: [], redirects: [] });
      continue;
    }
    if (SEPARATORS.has(token)) {
      segments.push({ words: [], redirects: [] });
      continue;
    }
    if (isOperator(token)) continue;
    segments.at(-1)!.words.push(token);
  }

  const outer: ShellCwd[] = [];
  for (const { words, redirects, paren } of segments) {
    if (paren === "(") outer.push(cwd);
    if (paren === ")" && outer.length) cwd = outer.pop()!;
    for (const path of redirects) add(path, cwd);
    const [name, ...args] = words.slice(commandStart(words));
    if (!name) continue;
    const operands = args.filter((arg) => !arg.startsWith("-"));
    switch (name.split("/").at(-1)) {
      case "cd":
      case "pushd":
        cwd = cdTo(cwd, args, roots);
        break;
      case "popd":
        cwd = null;
        break;
      case "tee":
      case "touch":
      case "rm":
      case "mv":
      case "truncate":
        for (const operand of operands) add(operand, cwd);
        break;
      case "cp":
      case "install":
      case "ln":
        add(operands.at(-1), cwd);
        break;
      case "sed":
      case "perl": {
        if (!args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"))) break;
        // The script is the first operand unless given with -e (or -f); the files follow it.
        // BSD `sed -i ''` gives an empty backup suffix, which is no file.
        const files: string[] = [];
        let scripted = false;
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i]!;
          if (arg === "-e" || arg === "-f" || arg === "--expression" || arg === "--file") {
            scripted = true;
            i += 1;
          } else if (!arg.startsWith("-") && arg !== "") {
            files.push(arg);
          }
        }
        for (const file of scripted ? files : files.slice(1)) add(file, cwd);
        break;
      }
      default:
        break;
    }
  }
  return { targets: [...found], cwd: outer.length ? outer[0]! : cwd };
}

/** Whether a path a command wrote (as shellWriteTargets resolves it: relative to the workspace) is this workspace file. */
export function namesFile(target: string, file: string): boolean {
  return target === posix.normalize(file).replace(/^(?:\.\/)+/, "");
}
