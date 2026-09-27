import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const AGORYX_DIR = ".agoryx";

const git = (cwd: string, args: string[], timeout = 15_000): string | null => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

export const isGitRepo = (dir: string): boolean => git(dir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";

export interface WorkspacePaths {
  root: string;
  agoryxDir: string;
  opsDir: string;
  acksDir: string;
  tableFile: string;
}

export const workspacePaths = (root: string): WorkspacePaths => {
  const agoryxDir = join(root, AGORYX_DIR);
  const opsDir = join(agoryxDir, "ops");
  return { root, agoryxDir, opsDir, acksDir: join(opsDir, "acks"), tableFile: join(agoryxDir, "TABLE.md") };
};

/**
 * Make sure the workspace exists, is a git repo when Agoryx created it, and
 * keeps Agoryx's own files (.agoryx/) out of git status.
 */
export const prepareWorkspace = (root: string, options: { initGit: boolean }): WorkspacePaths => {
  mkdirSync(root, { recursive: true });
  if (options.initGit && !isGitRepo(root)) {
    git(root, ["init", "-q"]);
  }
  const paths = workspacePaths(root);
  mkdirSync(paths.acksDir, { recursive: true });
  if (isGitRepo(root)) {
    const excludeRel = git(root, ["rev-parse", "--git-path", "info/exclude"])?.trim();
    if (excludeRel) {
      const excludePath = isAbsolute(excludeRel) ? excludeRel : join(root, excludeRel);
      const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
      const prefix = git(root, ["rev-parse", "--show-prefix"])?.trim() ?? "";
      const entry = `/${prefix}${AGORYX_DIR}/`;
      if (!current.split("\n").some((line) => line.trim() === entry)) {
        mkdirSync(dirname(excludePath), { recursive: true });
        appendFileSync(excludePath, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
      }
    }
  }
  return paths;
};

// ---------------------------------------------------------------------------
// Change tracking
// ---------------------------------------------------------------------------

export type ChangeSnapshot = Map<string, string>;

/** Signature of every dirty/untracked file: git status code + mtime + size. */
export const snapshotChanges = (root: string): ChangeSnapshot | null => {
  const output = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (output === null) return null;
  const snapshot: ChangeSnapshot = new Map();
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i += 1; // skip rename source
    if (path.startsWith(`${AGORYX_DIR}/`)) continue;
    let signature = code;
    try {
      const stats = statSync(join(root, path));
      signature += `:${stats.mtimeMs}:${stats.size}`;
    } catch {
      signature += ":gone";
    }
    snapshot.set(path, signature);
  }
  return snapshot;
};

export const diffSnapshots = (before: ChangeSnapshot | null, after: ChangeSnapshot | null): string[] => {
  if (!before || !after) return [];
  const changed = new Set<string>();
  for (const [path, signature] of after) if (before.get(path) !== signature) changed.add(path);
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
};

export const checkpointCommit = (root: string, subject: string, body: string): { sha: string; files: number } | null => {
  if (!isGitRepo(root)) return null;
  const status = git(root, ["status", "--porcelain"]);
  if (!status?.trim()) return null;
  if (git(root, ["add", "-A"]) === null) return null;
  const staged = git(root, ["diff", "--cached", "--name-only"])?.split("\n").filter(Boolean) ?? [];
  if (staged.length === 0) return null;
  const committed = git(root, [
    "-c",
    "user.name=Agoryx",
    "-c",
    "user.email=agoryx@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    subject,
    ...(body ? ["-m", body] : []),
  ]);
  if (committed === null) return null;
  const sha = git(root, ["rev-parse", "HEAD"])?.trim();
  return sha ? { sha, files: staged.length } : null;
};

// ---------------------------------------------------------------------------
// Files (for previews in the UI)
// ---------------------------------------------------------------------------

export const listWorkspaceFiles = (root: string, limit = 2000): string[] => {
  const fromGit = git(root, ["ls-files", "-co", "--exclude-standard"]);
  if (fromGit !== null) {
    return fromGit
      .split("\n")
      .filter((path) => path && !path.startsWith(`${AGORYX_DIR}/`))
      .slice(0, limit);
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= limit) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return files;
};

/** Resolve a user/agent supplied path inside the workspace, or null if it escapes. */
export const resolveInside = (root: string, relPath: string): string | null => {
  const cleaned = relPath.replace(/^\/+/, "");
  const full = resolve(root, cleaned);
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  try {
    if (lstatSync(full).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return full;
};

// ---------------------------------------------------------------------------
// Agent-side ops inbox
// ---------------------------------------------------------------------------

export interface InboxOp {
  agent: string;
  raw: Record<string, unknown>;
}

/**
 * Atomically take every ops file (one per agent) out of the inbox and parse
 * it. Agents keep appending to a fresh file after the rename.
 */
export const drainOpsInbox = (paths: WorkspacePaths): InboxOp[] => {
  if (!existsSync(paths.opsDir)) return [];
  const ops: InboxOp[] = [];
  for (const name of readdirSync(paths.opsDir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const agent = name.slice(0, -".jsonl".length);
    const source = join(paths.opsDir, name);
    const taken = `${source}.${process.pid}.${Date.now()}.taking`;
    try {
      renameSync(source, taken);
    } catch {
      continue;
    }
    const text = readFileSync(taken, "utf8");
    rmSync(taken, { force: true });
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        if (raw && typeof raw === "object") ops.push({ agent, raw });
      } catch {
        // ignore malformed lines
      }
    }
  }
  return ops;
};

export const writeAck = (paths: WorkspacePaths, nonce: string, ack: Record<string, unknown>): void => {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(nonce)) return;
  try {
    mkdirSync(paths.acksDir, { recursive: true });
    const target = join(paths.acksDir, `${nonce}.json`);
    writeFileSync(`${target}.tmp`, JSON.stringify(ack));
    renameSync(`${target}.tmp`, target);
  } catch {
    // the agent will report "queued"
  }
};

export const clearStaleAcks = (paths: WorkspacePaths, olderThanMs = 10 * 60_000): void => {
  if (!existsSync(paths.acksDir)) return;
  const cutoff = Date.now() - olderThanMs;
  for (const name of readdirSync(paths.acksDir)) {
    const full = join(paths.acksDir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
    } catch {
      // ignore
    }
  }
};

// ---------------------------------------------------------------------------
// The `agoryx` command agents see on their PATH
// ---------------------------------------------------------------------------

const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "bin", "agoryx-agent.mjs"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("cannot locate the agoryx repo root (bin/agoryx-agent.mjs)");
};

export const agentCliScript = (): string => join(repoRoot(), "bin", "agoryx-agent.mjs");

/** Write <dir>/agoryx: a tiny shell shim that runs the zero-dependency agent CLI. */
export const ensureAgentShim = (dir: string): string => {
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "agoryx");
  const content = `#!/bin/sh\nexec "${process.execPath}" "${agentCliScript()}" "$@"\n`;
  const current = existsSync(shim) ? readFileSync(shim, "utf8") : "";
  if (current !== content) {
    writeFileSync(shim, content);
    chmodSync(shim, 0o755);
  }
  return shim;
};
