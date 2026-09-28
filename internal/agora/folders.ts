import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { agoraHome } from "./paths.js";
import { slugify } from "./store.js";
import type { RoomWorktree } from "./types.js";

const git = (cwd: string, args: string[], timeout = 10_000): string | null => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return null;
  }
};

/** What git says about a folder: the repository it is in, where in it, and on which branch. */
export interface FolderGit {
  /** The top of the working tree the folder is in. */
  root: string;
  /** The folder relative to `root` ("" at the top), with a trailing slash. */
  prefix: string;
  /** Checked-out branch; null when HEAD is detached. */
  branch: string | null;
  /** Short commit HEAD points to; null in a repository with no commits yet. */
  head: string | null;
  /** Local branches, most recently committed first. */
  branches: string[];
  /** The folder is a linked worktree, not the main checkout. */
  linked: boolean;
  /** Tracked files with uncommitted changes (they do not travel into a new worktree). */
  dirty: number;
}

const MAX_BRANCHES = 60;

export const folderGit = (dir: string, options: { branches?: boolean } = {}): FolderGit | null => {
  if (!existsSync(dir)) return null;
  const top = git(dir, ["rev-parse", "--show-toplevel", "--show-prefix", "--git-dir", "--git-common-dir"]);
  if (!top) return null;
  const [root, prefix = "", gitDir = "", commonDir = ""] = top.split("\n");
  if (!root) return null;
  const abs = (path: string) => (isAbsolute(path) ? path : resolve(dir, path));
  const branch = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || null;
  const head = git(dir, ["rev-parse", "--short", "--verify", "--quiet", "HEAD"])?.trim() || null;
  const branches =
    options.branches === false
      ? []
      : (git(dir, ["for-each-ref", `--count=${MAX_BRANCHES}`, "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]) ?? "")
          .split("\n")
          .filter(Boolean);
  const status = git(dir, ["status", "--porcelain=v1", "--untracked-files=no"], 5_000);
  return {
    root,
    prefix,
    branch,
    head,
    branches,
    linked: Boolean(gitDir && commonDir) && abs(gitDir) !== abs(commonDir),
    dirty: status ? status.split("\n").filter(Boolean).length : 0,
  };
};

export interface FolderEntry {
  name: string;
  path: string;
  /** Holds a .git entry: the top of a repository or a worktree. */
  git: boolean;
}

const MAX_ENTRIES = 400;

/** The folders inside `dir` (not hidden ones, not files), for picking a room's working folder. */
export const listFolder = (dir: string): FolderEntry[] => {
  const entries: FolderEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    entries.push({ name: entry.name, path, git: existsSync(join(path, ".git")) });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
};

/** A folder path the human typed or picked: absolute, `~` expanded, existing, a directory. */
export const resolveFolder = (input: string, env: NodeJS.ProcessEnv = process.env): string => {
  const home = env.HOME?.trim() || homedir();
  const raw = input.trim();
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) throw new Error(`a folder must be an absolute path: ${input}`);
  const path = resolve(expanded);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`no such folder: ${path}`);
  return path;
};

const refExists = (root: string, ref: string) => git(root, ["show-ref", "--verify", "--quiet", ref]) !== null;

/**
 * A new git worktree for a room: one branch and one folder that both agents work in, so the
 * checkout the human is using stays untouched. It branches off `base` (default: the folder's
 * current branch). Uncommitted changes in the source checkout stay there.
 */
export const createRoomWorktree = (
  source: string,
  options: { name: string; id: string; base?: string; env?: NodeJS.ProcessEnv },
): { workspace: string; worktree: RoomWorktree } => {
  const info = folderGit(source, { branches: false });
  if (!info) throw new Error(`not a git repository, so no worktree: ${source}`);
  if (!info.head) throw new Error("the repository has no commits yet; a worktree needs one to branch from");
  const base = options.base?.trim() || info.branch || info.head;
  if (base.startsWith("-") || git(info.root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
    throw new Error(`no such branch or commit to start the worktree from: ${base}`);
  }
  let branch = `agoryx/${slugify(options.name)}`;
  if (git(info.root, ["check-ref-format", "--branch", branch]) === null) branch = `agoryx/${options.id}`;
  if (refExists(info.root, `refs/heads/${branch}`)) branch = `${branch}-${options.id.slice(-4)}`;
  if (refExists(info.root, `refs/heads/${branch}`)) throw new Error(`branch ${branch} already exists`);
  const parent = join(agoraHome(options.env), "worktrees");
  mkdirSync(parent, { recursive: true });
  const path = join(parent, `${slugify(basename(info.root)) || "repo"}-${options.id}`);
  if (existsSync(path)) throw new Error(`the worktree folder already exists: ${path}`);
  try {
    execFileSync("git", ["worktree", "add", "--quiet", "-b", branch, path, base], {
      cwd: info.root,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git worktree add failed${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`);
  }
  const real = realpathSync(path);
  // Picked a folder inside the repository: work in the same folder of the worktree.
  const workspace = info.prefix ? join(real, info.prefix.replace(/\/+$/, "")) : real;
  mkdirSync(workspace, { recursive: true });
  return { workspace, worktree: { source, repo: info.root, path: real, branch, base } };
};

/** Undo a worktree made for a room that then failed to start. */
export const removeRoomWorktree = (worktree: RoomWorktree): void => {
  git(worktree.repo, ["worktree", "remove", "--force", worktree.path], 60_000);
  git(worktree.repo, ["branch", "-D", worktree.branch]);
};

/** The folder a summary's room was started in, as the human picked it; null for a folder Agoryx made. */
export const pickedFolder = (state: { workspace: string; createdWorkspace: boolean; worktree?: RoomWorktree }): string | null =>
  state.worktree ? state.worktree.source : state.createdWorkspace ? null : state.workspace;

export const parentFolder = (path: string): string | null => {
  const up = dirname(path);
  return up === path ? null : up;
};
