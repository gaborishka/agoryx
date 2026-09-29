// The files a shell command names as what it writes: `> file`, `tee file`, `sed -i … file`, `cp a file`,
// `mv`/`rm`/`touch file`, and a script's own `open('file', 'w')` or `writeFileSync('file', …)`.
// In parallel turns this is the evidence that a file changed by a shell command is this agent's: the command
// named it. It reads only what the command says; a file a command changes without naming it stays unclaimed.

const INTERPRETER_WRITES = [
  // Python: open('f', 'w'), Path('f').write_text(…)
  /\bopen\(\s*(["'])([^"'\n]+)\1\s*,\s*(?:mode\s*=\s*)?["'][wax]/g,
  /\bPath\(\s*(["'])([^"'\n]+)\1\s*\)\s*\.write_(?:text|bytes)\(/g,
  // Node: fs.writeFileSync('f', …), appendFile…
  /\b(?:writeFile|appendFile)(?:Sync)?\(\s*(["'`])([^"'`\n]+)\1/g,
];

/** Python's `p = 'f'` … `open(p, 'w')`: the variable resolved to the path it was given. */
const writesThroughVariables = (text: string): string[] => {
  const values = new Map<string, string>();
  for (const match of text.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(?:Path\(\s*)?(["'])([^"'\n]+)\2/g)) values.set(match[1]!, match[3]!);
  const found: string[] = [];
  for (const match of text.matchAll(/\bopen\(\s*([A-Za-z_]\w*)\s*,\s*(?:mode\s*=\s*)?["'][wax]/g)) {
    const value = values.get(match[1]!);
    if (value) found.push(value);
  }
  for (const match of text.matchAll(/\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/g)) {
    const value = values.get(match[1]!);
    if (value) found.push(value);
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
      while (i + 1 < text.length && ";|&<>".includes(text[i + 1]!)) op += text[++i];
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

/** Paths a shell command names as written (as given: relative to where it ran, or absolute). */
export function shellWriteTargets(command: string): string[] {
  const found = new Set<string>();
  const add = (path: string | undefined) => {
    if (!path || path.startsWith("/dev/") || path.startsWith("-") || /[*?$`{}]/.test(path)) return;
    found.add(path);
  };
  for (const pattern of INTERPRETER_WRITES) for (const match of command.matchAll(pattern)) add(match[2]);
  for (const path of writesThroughVariables(command)) add(path);

  // A heredoc's body is data for the command it feeds (read above for a script's own writes), not more shell.
  const shell = command.replace(/<<-?\s*(["']?)([A-Za-z_]\w*)\1[\s\S]*?(?:\s\2(?=\s|$|[;|&)])|$)/g, " ");
  const tokens = tokenize(shell);
  const segments: string[][] = [[]];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === ">" || token === ">>" || token === ">|" || token === "&>" || token === "&>>") {
      const next = tokens[i + 1];
      if (next !== undefined && !isOperator(next)) {
        add(next);
        i += 1;
      }
      continue;
    }
    if (token === ">&") {
      i += 1; // 2>&1: another descriptor, not a file
      continue;
    }
    if (SEPARATORS.has(token)) {
      segments.push([]);
      continue;
    }
    if (isOperator(token)) continue;
    segments.at(-1)!.push(token);
  }

  for (const words of segments) {
    // Past env assignments and wrappers to the command itself.
    let start = 0;
    while (start < words.length && (/^[A-Za-z_]\w*=/.test(words[start]!) || ["sudo", "command", "exec", "env"].includes(words[start]!))) start += 1;
    const [name, ...args] = words.slice(start);
    if (!name) continue;
    const operands = args.filter((arg) => !arg.startsWith("-"));
    switch (name.split("/").at(-1)) {
      case "tee":
      case "touch":
      case "rm":
      case "mv":
      case "truncate":
        operands.forEach(add);
        break;
      case "cp":
      case "install":
      case "ln":
        add(operands.at(-1));
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
        (scripted ? files : files.slice(1)).forEach(add);
        break;
      }
      default:
        break;
    }
  }
  return [...found];
}

/** Whether a path a command wrote (relative to where it ran, maybe under a `cd`) is this workspace file. */
export function namesFile(target: string, file: string): boolean {
  const clean = target.replace(/^(?:\.\/)+/, "");
  return clean === file || file.endsWith(`/${clean}`);
}
