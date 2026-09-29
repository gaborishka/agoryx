// The files a shell command names as what it writes: `> file`, `tee file`, `sed -i … file`, `cp a file`,
// `mv`/`rm`/`touch file`, and a script's own `open('file', 'w')` or `writeFileSync('file', …)`.
// In parallel turns this is the evidence that a file changed by a shell command is this agent's: the command
// named it. It reads only what the command says; a file a command changes without naming it stays unclaimed.

import { posix } from "node:path";

const INTERPRETER_WRITES = [
  // Python: open('f', 'w'), Path('f').write_text(…)
  /\bopen\(\s*(["'])([^"'\n]+)\1\s*,\s*(?:mode\s*=\s*)?["'][wax]/g,
  /\bPath\(\s*(["'])([^"'\n]+)\1\s*\)\s*\.write_(?:text|bytes)\(/g,
  // Node: fs.writeFileSync('f', …), appendFile…
  /\b(?:writeFile|appendFile)(?:Sync)?\(\s*(["'`])([^"'`\n]+)\1/g,
];

/** Python's `p = 'f'` … `open(p, 'w')`: the variable resolved to the path it was given. */
const writesThroughVariables = (text: string): Array<{ path: string; at: number }> => {
  const values = new Map<string, string>();
  for (const match of text.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:Path\(\s*)?(["'])([^"'\n]+)\2/g)) values.set(match[1]!, match[3]!);
  const found: Array<{ path: string; at: number }> = [];
  for (const match of text.matchAll(/\bopen\(\s*([A-Za-z_]\w*)\s*,\s*(?:mode\s*=\s*)?["'][wax]/g)) {
    const value = values.get(match[1]!);
    if (value) found.push({ path: value, at: match.index! });
  }
  for (const match of text.matchAll(/\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/g)) {
    const value = values.get(match[1]!);
    if (value) found.push({ path: value, at: match.index! });
  }
  return found;
};

/** Words of a shell command, quotes removed, with the operators that separate commands and redirections as their own words. */
const tokenize = (text: string): string[] => {
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
    } else if (char === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      open = true;
      i += 1;
    } else if (/\s/.test(char)) {
      flush();
    } else if (";|&<>()".includes(char)) {
      // A digit right before > is its file descriptor (2>), not a word.
      if (char === ">" && /^\d$/.test(current) && open) {
        current = "";
        open = false;
      }
      flush();
      let op = char;
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
const SEPARATORS = new Set([";", "&&", "||", "|", "&", "(", ")", "|&"]);

/** Where a command runs, relative to the workspace ("" is its root); null once a `cd` goes somewhere unknown (`cd`, `cd ~`, `cd $DIR`). */
export type ShellCwd = string | null;

/** `cd`'s directory from where the shell is now: null when it cannot be told from the command. */
const cdTo = (cwd: ShellCwd, args: string[]): ShellCwd => {
  const dir = args.find((arg) => !/^-[LPe@]+$/.test(arg));
  if (dir === undefined || dir === "-" || dir.startsWith("~") || /[*?$`{}'"]/.test(dir)) return null;
  if (dir.startsWith("/")) return posix.normalize(dir);
  return cwd === null ? null : relativeTo(cwd, dir);
};

const relativeTo = (cwd: string, path: string): string => {
  const joined = posix.normalize(cwd ? `${cwd}/${path}` : path).replace(/\/+$/, "");
  return joined === "." ? "" : joined;
};

/** Where a command's `cd`s (at the start of one of its commands) have left the shell at each character. */
const cdsIn = (command: string): Array<{ at: number; args: string[] }> =>
  [...command.matchAll(/(?:^|[;&|(\n])\s*(?:cd|pushd)\b([^;&|)<>\n]*)/g)].map((match) => ({
    at: match.index! + match[0].length,
    args: match[1]!.trim().split(/\s+/).filter(Boolean),
  }));

/**
 * Paths a shell command names as written, relative to the workspace: resolved against where the command ran
 * (`cwd`, the workspace root by default) and any `cd` before them, so `cd sub && echo > b.txt` is `sub/b.txt`.
 * A path outside the workspace stays absolute; one after a `cd` to somewhere unknown is left out.
 */
export function shellWriteTargets(command: string, cwd: ShellCwd = ""): string[] {
  return shellWrites(command, cwd).targets;
}

/** The paths a command names as written (see shellWriteTargets), and where the shell is when it ends. */
export function shellWrites(command: string, cwd: ShellCwd = ""): { targets: string[]; cwd: ShellCwd } {
  const found = new Set<string>();
  const add = (path: string | undefined, from: ShellCwd) => {
    if (!path || path.startsWith("/dev/") || path.startsWith("-") || /[*?$`{}]/.test(path)) return;
    if (path.startsWith("/")) found.add(posix.normalize(path));
    else if (from !== null) found.add(relativeTo(from, path));
  };
  // A script's own writes are relative to where it runs: after the `cd`s before it in the command.
  const cds = cdsIn(command);
  const cwdAt = (index: number): ShellCwd => cds.filter((cd) => cd.at <= index).reduce<ShellCwd>((at, cd) => cdTo(at, cd.args), cwd);
  for (const pattern of INTERPRETER_WRITES) for (const match of command.matchAll(pattern)) add(match[2], cwdAt(match.index!));
  for (const { path, at } of writesThroughVariables(command)) add(path, cwdAt(at));

  // A heredoc's body is data for the command it feeds (read above for a script's own writes), not more shell.
  const shell = command.replace(/<<-?\s*(["']?)([A-Za-z_]\w*)\1[\s\S]*?(?:\s\2(?=\s|$|[;|&)])|$)/g, " ");
  const tokens = tokenize(shell);
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
    // Past env assignments and wrappers to the command itself.
    let start = 0;
    while (start < words.length && (/^[A-Za-z_]\w*=/.test(words[start]!) || ["sudo", "command", "exec", "env", "builtin"].includes(words[start]!))) start += 1;
    const [name, ...args] = words.slice(start);
    if (!name) continue;
    const operands = args.filter((arg) => !arg.startsWith("-"));
    switch (name.split("/").at(-1)) {
      case "cd":
      case "pushd":
        cwd = cdTo(cwd, args);
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
