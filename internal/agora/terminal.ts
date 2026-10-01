import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IPty } from "node-pty";

// The human's own terminals in a room's folder: a real shell (a PTY), kept by the daemon, so a page that
// reloads or a second window finds the same shell with what it printed. Agents never get one: they have
// their own shells; this one is the human's, so it is refused to agent keys (daemon.ts).

/** What a terminal kept of its output, replayed to a page that attaches later. */
const SCROLLBACK = 512 * 1024;
/** How many terminals one room may have open at once. */
export const MAX_TERMINALS = 8;

export interface TerminalInfo {
  id: string;
  room: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  pid: number;
  /** The shell ended: its exit code (the terminal stays, to read, until closed). */
  exit: number | null;
  createdAt: string;
}

/** What the page and the terminal say to each other over the WebSocket (JSON text frames). */
export type TerminalClientMessage = { t: "in"; d: string } | { t: "resize"; cols: number; rows: number };
export type TerminalServerMessage =
  | { t: "replay"; d: string; info: TerminalInfo }
  | { t: "out"; d: string }
  | { t: "exit"; code: number }
  | { t: "closed" }
  | { t: "title"; title: string };

type Listener = (message: TerminalServerMessage) => void;

// What is kept for replay drops the terminal's questions and their answers (cursor position, device
// attributes, colour and mode queries): replayed into a new page, a question is asked again and the page's
// answer lands at the shell's prompt as junk. After T3 Code's sanitizeTerminalHistoryChunk (MIT).

const stripCsi = (body: string, final: string): boolean =>
  final === "n" ||
  (final === "R" && /^[0-9;?]*$/.test(body)) ||
  (final === "c" && /^[>0-9;?]*$/.test(body)) ||
  ((final === "p" || final === "y") && /^[0-9;?]*\$$/.test(body)) ||
  (final === "q" && /^>[0-9;]*$/.test(body)) ||
  (final === "u" && body.startsWith("?"));
const stripDcs = (content: string): boolean => /^[01]?[$+][qr]/.test(content);
const stripOsc = (content: string): boolean => /^(10|11|12);(?:\?|rgb:)/.test(content);

const stringEnd = (input: string, start: number): number | null => {
  for (let i = start; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x07 || c === 0x9c) return i + 1;
    if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return null;
};
const unterminated = (value: string): string => (value.endsWith("\u001b\\") ? value.slice(0, -2) : /[\u0007\u009c]$/.test(value) ? value.slice(0, -1) : value);

/** Output with the queries taken out; a sequence cut at the chunk's end waits in `pending` for the next. */
export const sanitizeForReplay = (pending: string, data: string): { text: string; pending: string } => {
  const input = pending + data;
  let text = "";
  let i = 0;
  while (i < input.length) {
    const c = input.charCodeAt(i);
    const csi = c === 0x1b && input.charCodeAt(i + 1) === 0x5b ? 2 : c === 0x9b ? 1 : 0;
    if (csi) {
      let j = i + csi;
      while (j < input.length && !(input.charCodeAt(j) >= 0x40 && input.charCodeAt(j) <= 0x7e)) j++;
      if (j >= input.length) return { text, pending: input.slice(i) };
      if (!stripCsi(input.slice(i + csi, j), input[j]!)) text += input.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const next = input.charCodeAt(i + 1);
    const kind = c === 0x1b && [0x5d, 0x50, 0x5e, 0x5f].includes(next) ? next : [0x9d, 0x90, 0x9e, 0x9f].includes(c) ? c - 0x40 : 0;
    if (kind) {
      const skip = c === 0x1b ? 2 : 1;
      const end = stringEnd(input, i + skip);
      if (end === null) return { text, pending: input.slice(i) };
      const content = unterminated(input.slice(i + skip, end));
      if (!((kind === 0x5d && stripOsc(content)) || (kind === 0x50 && stripDcs(content)))) text += input.slice(i, end);
      i = end;
      continue;
    }
    if (c === 0x1b) {
      if (Number.isNaN(next)) return { text, pending: input.slice(i) };
      let j = i + 1;
      while (j < input.length && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
      if (j >= input.length) return { text, pending: input.slice(i) };
      const end = input.charCodeAt(j) >= 0x30 && input.charCodeAt(j) <= 0x7e ? j + 1 : i + 1;
      text += input.slice(i, end);
      i = end;
      continue;
    }
    text += input[i];
    i++;
  }
  return { text, pending: "" };
};

interface Terminal {
  info: TerminalInfo;
  pty: IPty | null;
  /** Output kept for replay, as chunks; trimmed from the front past SCROLLBACK. */
  chunks: string[];
  size: number;
  /** An escape sequence cut at a chunk's end, kept until the rest comes. */
  pending: string;
  listeners: Set<Listener>;
}

let ptyModule: typeof import("node-pty") | null | undefined;

/**
 * node-pty, loaded when the first terminal opens: the daemon runs without it (tests, a build where its
 * native part did not build). Its prebuilt spawn-helper sometimes installs without the execute bit
 * (posix_spawnp failed): set it once here.
 */
const loadPty = (): typeof import("node-pty") => {
  if (ptyModule) return ptyModule;
  if (ptyModule === null) throw new Error("terminals are not available: node-pty did not load (run npm install in the Agoryx folder)");
  const require = createRequire(import.meta.url);
  try {
    const main = require.resolve("node-pty");
    const root = dirname(dirname(main));
    for (const arch of ["darwin-arm64", "darwin-x64"]) {
      const helper = join(root, "prebuilds", arch, "spawn-helper");
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
        try {
          chmodSync(helper, 0o755);
        } catch {
          // not ours to change: spawning will say so
        }
      }
    }
    ptyModule = require("node-pty") as typeof import("node-pty");
    return ptyModule;
  } catch (error) {
    ptyModule = null;
    throw new Error(`terminals are not available: node-pty did not load (${error instanceof Error ? error.message : String(error)})`);
  }
};

/**
 * The shell's environment: the daemon's, without what Agoryx sets for agents' turns (keys, turn files, the
 * room an agent sits in) — this shell is the human's. AGORYX_HOME stays, so `agoryx` here reaches this daemon.
 */
export const terminalEnv = (base: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.startsWith("AGORYX_") && name !== "AGORYX_HOME") continue;
    if (name === "ELECTRON_RUN_AS_NODE") continue;
    env[name] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "Agoryx";
  if (!env.LANG) env.LANG = "en_US.UTF-8";
  return env;
};

const defaultShell = (env: NodeJS.ProcessEnv): string => {
  const shell = env.SHELL;
  if (shell && existsSync(shell)) return shell;
  return process.platform === "win32" ? "powershell.exe" : existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
};

const clampSize = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(n) && n >= 2 ? Math.min(n, max) : fallback;
};

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class TerminalHub {
  private readonly terminals = new Map<string, Terminal>();
  private next = 1;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  list(room: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => t.info.room === room).map((t) => ({ ...t.info }));
  }

  /** A new shell in the room's folder. */
  open(room: string, cwd: string, options: { cols?: unknown; rows?: unknown; title?: unknown } = {}): TerminalInfo {
    if (this.list(room).length >= MAX_TERMINALS) throw new TerminalError(`a room has at most ${MAX_TERMINALS} terminals: close one first`, 409);
    if (!existsSync(cwd)) throw new TerminalError(`the room's folder is gone: ${cwd}`, 409);
    const pty = loadPty();
    const cols = clampSize(options.cols, 100, 500);
    const rows = clampSize(options.rows, 30, 300);
    const shell = defaultShell(this.env);
    const id = `term${this.next++}`;
    const proc = pty.spawn(shell, process.platform === "win32" ? [] : ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnv(this.env),
    });
    const title = typeof options.title === "string" && options.title.trim() ? options.title.trim().slice(0, 60) : shell.split("/").pop() || "shell";
    const terminal: Terminal = {
      info: { id, room, title, cwd, cols, rows, pid: proc.pid, exit: null, createdAt: new Date().toISOString() },
      pty: proc,
      chunks: [],
      size: 0,
      pending: "",
      listeners: new Set(),
    };
    proc.onData((data) => {
      this.keep(terminal, data);
      for (const listener of terminal.listeners) listener({ t: "out", d: data });
    });
    proc.onExit(({ exitCode }) => {
      terminal.pty = null;
      terminal.info.exit = exitCode;
      for (const listener of terminal.listeners) listener({ t: "exit", code: exitCode });
    });
    this.terminals.set(id, terminal);
    return { ...terminal.info };
  }

  private keep(terminal: Terminal, data: string): void {
    const { text, pending } = sanitizeForReplay(terminal.pending, data);
    terminal.pending = pending;
    if (!text) return;
    terminal.chunks.push(text);
    terminal.size += text.length;
    while (terminal.size > SCROLLBACK && terminal.chunks.length > 1) terminal.size -= terminal.chunks.shift()!.length;
  }

  private get(room: string, id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal || terminal.info.room !== room) throw new TerminalError("no such terminal in this room", 404);
    return terminal;
  }

  /** A page attaches: it gets what the terminal printed so far, then everything new. */
  attach(room: string, id: string, listener: Listener): () => void {
    const terminal = this.get(room, id);
    listener({ t: "replay", d: terminal.chunks.join(""), info: { ...terminal.info } });
    if (terminal.info.exit !== null) listener({ t: "exit", code: terminal.info.exit });
    terminal.listeners.add(listener);
    return () => terminal.listeners.delete(listener);
  }

  /** What the page sends: keys, or its new size. Malformed messages are dropped. */
  receive(room: string, id: string, message: unknown): void {
    const terminal = this.get(room, id);
    if (!message || typeof message !== "object") return;
    const m = message as Partial<TerminalClientMessage> & Record<string, unknown>;
    if (m.t === "in" && typeof m.d === "string") {
      terminal.pty?.write(m.d);
      return;
    }
    if (m.t === "resize") {
      const cols = clampSize(m.cols, terminal.info.cols, 500);
      const rows = clampSize(m.rows, terminal.info.rows, 300);
      if (cols === terminal.info.cols && rows === terminal.info.rows) return;
      terminal.info.cols = cols;
      terminal.info.rows = rows;
      try {
        terminal.pty?.resize(cols, rows);
      } catch {
        // the shell just ended
      }
    }
  }

  /** Type a command into a terminal, as if the human did (the session panel's «Продовжити в терміналі»). */
  write(room: string, id: string, text: string): void {
    const terminal = this.get(room, id);
    if (!terminal.pty) throw new TerminalError("this terminal's shell has ended", 409);
    terminal.pty.write(text);
  }

  rename(room: string, id: string, title: string): TerminalInfo {
    const terminal = this.get(room, id);
    const name = title.trim().slice(0, 60);
    if (!name) throw new TerminalError("a terminal needs a name", 400);
    terminal.info.title = name;
    for (const listener of terminal.listeners) listener({ t: "title", title: name });
    return { ...terminal.info };
  }

  close(room: string, id: string): void {
    const terminal = this.get(room, id);
    this.end(terminal);
  }

  private end(terminal: Terminal): void {
    this.terminals.delete(terminal.info.id);
    for (const listener of terminal.listeners) listener({ t: "closed" });
    terminal.listeners.clear();
    const pty = terminal.pty;
    terminal.pty = null;
    if (!pty) return;
    // SIGHUP, as a closed terminal window sends; what ignores it is killed a second later.
    try {
      pty.kill("SIGHUP");
    } catch {
      return;
    }
    let ended = false;
    pty.onExit(() => {
      ended = true;
    });
    setTimeout(() => {
      if (ended) return;
      try {
        process.kill(pty.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }, 1000).unref();
  }

  /** The daemon stops: every shell ends with it. */
  closeAll(): void {
    for (const terminal of [...this.terminals.values()]) this.end(terminal);
  }
}
