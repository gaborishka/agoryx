import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stepsInSubject } from "./checkpoint-message.js";
import type { FileChange } from "./types.js";

export const AGORYX_DIR = ".agoryx";

/**
 * The daemon's git never takes git's optional locks: a `git status` of its, refreshing the index while an
 * agent's `git add` or `git commit` runs in the folder, would make the agent's command fail on index.lock.
 */
const quiet = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...(env ?? process.env), GIT_OPTIONAL_LOCKS: "0" });

const git = (cwd: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv): string | null => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      env: quiet(env),
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

/** git, and what it said on stderr when it failed. */
const gitSays = (cwd: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv): { out: string | null; err: string } => {
  try {
    return { out: execFileSync("git", args, { cwd, encoding: "utf8", timeout, env: quiet(env), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }), err: "" };
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return { out: null, err: String(stderr ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300) };
  }
};

export const isGitRepo = (dir: string): boolean => git(dir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";

/**
 * A folder the human brought that is not a git repository still gets its changes tracked: Agoryx keeps its
 * own repository for that in .agoryx/shadow.git, with the folder as its work tree. The folder itself gains no
 * .git and nothing is ever committed there; it only lets Agoryx see what each turn changed. Once the folder
 * becomes a repository of its own, that one is used.
 */
const SHADOW_GIT = "shadow.git";
const shadowGitDir = (root: string): string => join(root, AGORYX_DIR, SHADOW_GIT);
const shadowEnv = (root: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined => {
  const dir = shadowGitDir(root);
  if (!existsSync(dir) || existsSync(join(root, ".git"))) return env;
  return { ...(env ?? process.env), GIT_DIR: dir, GIT_WORK_TREE: root };
};
/** A folder past this many files (a home directory…) is left untracked rather than scanned on every turn. */
export const MAX_SHADOW_FILES = 20_000;
const fewerFilesThan = (root: string, limit: number): boolean => {
  let seen = 0;
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.name === AGORYX_DIR || entry.name === ".git") continue;
      if ((seen += 1) >= limit) return false;
      if (entry.isDirectory() && !walk(join(dir, entry.name))) return false;
    }
    return true;
  };
  return walk(root);
};
/**
 * How a workspace's changes are seen: its own git repository, Agoryx's shadow one (the folder has no .git, so
 * `git status` there finds nothing), or not at all (a folder too big to scan).
 */
export const workspaceTracking = (root: string): "git" | "shadow" | "none" =>
  isGitRepo(root) ? "git" : existsSync(shadowGitDir(root)) ? "shadow" : "none";

/** git for seeing changes: the workspace's own repository, or Agoryx's shadow one for a folder without it. */
const track = (root: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv): string | null => git(root, args, timeout, shadowEnv(root, env));

/**
 * Where the workspace sits inside its repository ("" at the root, "sub/dir/" below it). A room given a
 * subdirectory of a bigger repository sees, diffs and commits only that subdirectory; git reports paths
 * from the repository root, so they are made workspace-relative with this.
 */
const repoPrefix = (root: string): string => track(root, ["rev-parse", "--show-prefix"])?.trim() ?? "";

/** A repository-relative path as a workspace-relative one; null when it lies outside the workspace. */
const underPrefix = (prefix: string, path: string): string | null =>
  !prefix ? path : path.startsWith(prefix) ? path.slice(prefix.length) : null;

export interface WorkspacePaths {
  root: string;
  agoryxDir: string;
  /** Where this room's own service files live: .agoryx/rooms/<room>/, or .agoryx/ itself (the layout before rooms shared a workspace). */
  roomDir: string;
  opsDir: string;
  acksDir: string;
  tableFile: string;
  turnsDir: string;
}

/** A room id as a directory name, or null when nothing safe is left of it. */
export const roomDirName = (roomId: string): string | null => {
  const clean = roomId.replace(/[^\w.-]/g, "");
  return clean && !clean.startsWith(".") ? clean : null;
};

/**
 * Rooms may share a workspace, and each numbers its turns from t1, has its own table and its own
 * inbox; so everything but the message copies (already per room) sits under .agoryx/rooms/<room>/.
 * Without a room id: the single-room layout older rooms and shims used, straight under .agoryx/.
 */
export const workspacePaths = (root: string, roomId?: string): WorkspacePaths => {
  const agoryxDir = join(root, AGORYX_DIR);
  const dirName = roomId === undefined ? null : roomDirName(roomId);
  if (roomId !== undefined && !dirName) throw new Error(`'${roomId}' is not a room id`);
  const roomDir = dirName ? join(agoryxDir, "rooms", dirName) : agoryxDir;
  const opsDir = join(roomDir, "ops");
  return { root, agoryxDir, roomDir, opsDir, acksDir: join(opsDir, "acks"), tableFile: join(roomDir, "TABLE.md"), turnsDir: join(roomDir, "turns") };
};

/** Where a room writes its id and name, so the agent tool can list the rooms sharing a workspace. */
const ROOM_INFO = "room.json";

/** Ids of the rooms that have opened in this workspace since rooms got their own directories. */
export const workspaceRooms = (root: string): string[] => {
  const dir = join(root, AGORYX_DIR, "rooms");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, ROOM_INFO)))
    .map((entry) => entry.name)
    .sort();
};

/**
 * Make sure the workspace exists, is a git repo when Agoryx created it, and
 * keeps Agoryx's own files (.agoryx/) out of git status.
 */
export const prepareWorkspace = (root: string, options: { initGit: boolean; room?: { id: string; name: string } }): WorkspacePaths => {
  mkdirSync(root, { recursive: true });
  if (options.initGit && !isGitRepo(root)) {
    git(root, ["init", "-q"]);
  }
  if (!isGitRepo(root) && !existsSync(shadowGitDir(root)) && fewerFilesThan(root, MAX_SHADOW_FILES)) {
    mkdirSync(join(root, AGORYX_DIR), { recursive: true });
    git(root, ["init", "-q"], 15_000, { ...process.env, GIT_DIR: shadowGitDir(root), GIT_WORK_TREE: root });
    try {
      writeFileSync(join(shadowGitDir(root), "info", "exclude"), `/${AGORYX_DIR}/\n`);
    } catch {
      rmSync(shadowGitDir(root), { recursive: true, force: true }); // untracked is better than tracking Agoryx's own files
    }
  }
  const paths = workspacePaths(root, options.room?.id);
  mkdirSync(paths.acksDir, { recursive: true });
  if (options.room) {
    try {
      writeFileSync(join(paths.roomDir, ROOM_INFO), `${JSON.stringify({ id: options.room.id, name: options.room.name })}\n`);
    } catch {
      // the agent tool then cannot list this room by name; --room <id> still reaches it
    }
  }
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
  const output = track(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (output === null) return null;
  const prefix = repoPrefix(root);
  const snapshot: ChangeSnapshot = new Map();
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = underPrefix(prefix, entry.slice(3));
    if (/[RC]/.test(code)) i += 1; // skip rename source
    if (path === null || path.startsWith(`${AGORYX_DIR}/`)) continue;
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

// ---------------------------------------------------------------------------
// Live turns: .agoryx/live/<room>.<turn>.json — rooms sharing a workspace (in one process
// or in several) tell each other when their turns run, so none credits the other's work
// ---------------------------------------------------------------------------

export interface LiveTurn {
  room: string;
  turn: string;
  pid: number;
  startedAt: number;
  /** Unset while the turn runs; a turn whose process died ends when a reader first sees it dead. */
  endedAt?: number;
}

/** Ended markers are kept this long, so a turn still running after them can see they overlapped it. */
const LIVE_KEEP_MS = 24 * 60 * 60 * 1000;

const liveDir = (root: string): string => join(root, AGORYX_DIR, "live");

const liveFile = (root: string, room: string, turn: string): string | null => {
  const dir = roomDirName(room);
  return dir && TURN_ID.test(turn) ? join(liveDir(root), `${dir}.${turn}.json`) : null;
};

export const markTurnLive = (root: string, entry: LiveTurn): void => {
  const target = liveFile(root, entry.room, entry.turn);
  if (!target) return;
  const partial = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(partial, JSON.stringify(entry));
    renameSync(partial, target);
  } catch {
    rmSync(partial, { force: true });
  }
};

/**
 * Turns of rooms other than `room` that ran at some point since `since` (ms): still running, ended
 * after it, or left running by a process that died after it. Old ended markers are swept on the way.
 */
export const otherRoomTurns = (root: string, room: string, since: number, now = Date.now()): LiveTurn[] => {
  const dir = liveDir(root);
  if (!existsSync(dir)) return [];
  const own = roomDirName(room);
  const found: LiveTurn[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const full = join(dir, name);
    let entry: LiveTurn;
    try {
      entry = JSON.parse(readFileSync(full, "utf8")) as LiveTurn;
    } catch {
      continue;
    }
    if (typeof entry?.room !== "string" || typeof entry.startedAt !== "number") continue;
    // Its process died mid-turn at some unknown moment: it ends now, when that is first seen (and stays so).
    if (entry.endedAt === undefined && !processAlive(entry.pid)) {
      entry = { ...entry, endedAt: now };
      markTurnLive(root, entry);
    }
    if (entry.endedAt !== undefined && now - entry.endedAt > LIVE_KEEP_MS) {
      rmSync(full, { force: true });
      continue;
    }
    if (roomDirName(entry.room) === own) continue;
    if (entry.endedAt === undefined || entry.endedAt >= since) found.push(entry);
  }
  return found;
};

/**
 * A copy of a git index that keeps the original's mtime. git trusts an entry's stat only when the entry is
 * older than the index file; an entry from the index's own second is checked by content. A copy stamped
 * "now" would make such an entry look settled, and an edit made in that second that kept the file's size
 * would be missed.
 */
const copyIndex = (from: string, to: string): void => {
  // Stamped before copying: an index rewritten in between gives the copy an older time, never a newer one.
  const { atime, mtime } = statSync(from);
  copyFileSync(from, to);
  utimesSync(to, atime, mtime);
};

/** Past this many dirty files (a fresh `npm install` without .gitignore…) turns are not snapshotted as trees. */
export const MAX_TREE_SNAPSHOT_DIRTY = 3000;

/**
 * The working tree as a git tree object: tracked and untracked files, .gitignore
 * respected. It is built in a scratch copy of the index, so the real index, HEAD
 * and the files stay untouched. Two of these bracket a turn; their diff is exactly
 * what the turn changed.
 */
export const snapshotTree = (root: string): string | null => {
  const indexRel = track(root, ["rev-parse", "--git-path", "index"])?.trim();
  if (!indexRel) return null;
  const index = isAbsolute(indexRel) ? indexRel : join(root, indexRel);
  const scratch = join(tmpdir(), `agoryx-index-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    if (existsSync(index)) copyIndex(index, scratch);
    const env = { ...process.env, GIT_INDEX_FILE: scratch };
    if (track(root, ["add", "-A", "--", "."], 30_000, env) === null) return null;
    return track(root, ["write-tree"], 15_000, env)?.trim() || null;
  } catch {
    return null;
  } finally {
    rmSync(scratch, { force: true });
    rmSync(`${scratch}.lock`, { force: true });
  }
};

/** Patches bigger than this are cut (the file says so). */
export const MAX_TURN_PATCH = 256 * 1024;
const CUT_MARK = "… the patch is cut here";
const MAX_PATHSPECS = 400;

/** `git diff --numstat -z` and `--name-status -z` (without renames) as file changes. */
const parseChanges = (numstat: string, names: string): FileChange[] => {
  const statusOf = new Map<string, string>();
  const nameParts = names.split("\0");
  for (let i = 0; i + 1 < nameParts.length; i += 2) statusOf.set(nameParts[i + 1]!, nameParts[i]!.slice(0, 1));
  const changes: FileChange[] = [];
  for (const record of numstat.split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record);
    if (!match) continue;
    const path = match[3]!;
    changes.push({
      path,
      status: statusOf.get(path) ?? "M",
      added: match[1] === "-" ? null : Number(match[1]),
      removed: match[2] === "-" ? null : Number(match[2]),
    });
  }
  return changes;
};

/**
 * What changed between two snapshots, limited to `files` (the ones credited to
 * this turn — a parallel turn's edits are not in it). Null when git can't tell.
 */
export const treeChanges = (
  root: string,
  before: string,
  after: string,
  files: string[],
): { changes: FileChange[]; patch: string; truncated: boolean } | null => {
  if (files.length === 0 || before === after) return { changes: [], patch: "", truncated: false };
  // A turn that rewrote hundreds of files keeps its file list, without counts.
  if (files.length > MAX_PATHSPECS) return null;
  const prefix = repoPrefix(root);
  return diffTrees(root, before, after, files.map((file) => `:(top,literal)${prefix}${file}`));
};

/**
 * Everything that differs between `before` (a tree or commit) and the workspace as it is now: tracked and
 * untracked files, .gitignore respected, Agoryx's own .agoryx/ left out. Null when git can't tell.
 */
export const workspaceDiff = (root: string, before: string): { changes: FileChange[]; patch: string; truncated: boolean } | null => {
  // A tree git has since pruned (or never had) says nothing.
  if (track(root, ["cat-file", "-e", before]) === null) return null;
  const after = snapshotTree(root);
  if (!after) return null;
  return diffTrees(root, before, after, [".", `:(exclude)${AGORYX_DIR}`]);
};

/** Where `HEAD` forked from `base`: the commit a worktree room's branch started at, as far as git knows now. */
export const forkPoint = (root: string, base: string): string | null => {
  if (base.startsWith("-")) return null;
  return track(root, ["merge-base", "HEAD", base])?.trim() || null;
};

const diffTrees = (
  root: string,
  before: string,
  after: string,
  specs: string[],
): { changes: FileChange[]; patch: string; truncated: boolean } | null => {
  // --relative: paths in the counts and the patch are the workspace's, like everywhere else in the room.
  const base = ["-c", "core.quotepath=off", "diff", "--no-renames", "--no-ext-diff", "--no-color", "--relative", before, after];
  const numstat = track(root, [...base, "--numstat", "-z", "--", ...specs]);
  const names = track(root, [...base, "--name-status", "-z", "--", ...specs]);
  if (numstat === null || names === null) return null;
  const changes = parseChanges(numstat, names);
  let patch = track(root, [...base, "-U3", "--", ...specs], 30_000) ?? "";
  const truncated = patch.length > MAX_TURN_PATCH;
  if (truncated) patch = `${patch.slice(0, MAX_TURN_PATCH)}\n${CUT_MARK} (${patch.length - MAX_TURN_PATCH} more chars): git diff ${before.slice(0, 12)} ${after.slice(0, 12)}\n`;
  return { changes, patch, truncated };
};

/**
 * Every workspace path whose content differs between two snapshots. A turn that commits its work
 * leaves `git status` as clean as it found it; the trees still tell what changed.
 */
export const treeChangedPaths = (root: string, before: string, after: string): string[] | null => {
  if (before === after) return [];
  const output = track(root, ["-c", "core.quotepath=off", "diff", "--no-renames", "--relative", "--name-only", "-z", before, after, "--", "."]);
  if (output === null) return null;
  return output.split("\0").filter((path) => path && !path.startsWith(`${AGORYX_DIR}/`));
};

// ---------------------------------------------------------------------------
// Turn patches: .agoryx/turns/<turn>.patch — what a turn changed, readable by
// everyone in the room (agents via `agoryx diff t7`, inside their sandbox too)
// ---------------------------------------------------------------------------

const TURN_ID = /^t\d{1,9}$/;

export const turnPatchPath = (paths: WorkspacePaths, turnId: string): string | null =>
  TURN_ID.test(turnId) ? join(paths.turnsDir, `${turnId}.patch`) : null;

/** "+12 −3", or "(binary)". */
export const changeStats = (change: FileChange): string =>
  change.added === null ? "(binary)" : `+${change.added} −${change.removed}`;

/**
 * The file starts with a `#` header (turn, author, time, one line per file) so a
 * plain `cat` or `agoryx diff` without arguments tells whose change it is.
 */
export const writeTurnPatch = (
  paths: WorkspacePaths,
  turn: { id: string; author: string; ts: string },
  changes: FileChange[],
  patch: string,
): void => {
  const target = turnPatchPath(paths, turn.id);
  if (!target) return;
  const header = [
    `# ${turn.id} · ${turn.author} · ${turn.ts.slice(0, 16).replace("T", " ")} UTC`,
    ...changes.map(
      (change) =>
        `#   ${change.path}  ${changeStats(change)}${change.status === "A" ? " (new)" : change.status === "D" ? " (deleted)" : ""}${change.with?.length ? ` (also edited by ${change.with.join(", ")} meanwhile)` : ""}`,
    ),
    "#",
  ];
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${header.join("\n")}\n${patch}`);
  } catch {
    // the counts are in the event log; only the patch text is lost
  }
};

const MESSAGE_ID = /^m\d{1,9}$/;

/**
 * Every room message, in full, at .agoryx/messages/<room>/<id>.md: the room log lives
 * outside the workspace, where an agent's sandbox cannot see it, so this copy is
 * what `agoryx read m12` prints when the delta gave only part of a message.
 * Per room, because rooms may share a workspace and every room has its own m1.
 */
export const messagePath = (paths: WorkspacePaths, roomId: string, messageId: string): string | null => {
  const room = roomId.replace(/[^\w.-]/g, "");
  return MESSAGE_ID.test(messageId) && room && !room.startsWith(".") ? join(paths.agoryxDir, "messages", room, `${messageId}.md`) : null;
};

export const writeRoomMessage = (
  paths: WorkspacePaths,
  roomId: string,
  message: { id: string; author: string; ts: string; text: string; turnId?: string },
): void => {
  const target = messagePath(paths, roomId, message.id);
  if (!target) return;
  const turn = message.turnId ? ` · turn ${message.turnId}` : "";
  const partial = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    // Written aside and renamed in: a reader never sees half a message.
    writeFileSync(partial, `# ${message.id} · ${message.author} · ${message.ts.slice(0, 16).replace("T", " ")} UTC${turn}\n\n${message.text}\n`);
    renameSync(partial, target);
  } catch {
    rmSync(partial, { force: true });
    // the message is still in the event log; only the agents' copy is lost
  }
};

/** The patch without its header; regenerated from the turn's trees when the file is gone. */
export const readTurnPatch = (
  paths: WorkspacePaths,
  turnId: string,
  fallback?: { trees?: { before: string; after: string }; files: string[]; author?: string; endedAt?: string; ownsLegacy?: () => boolean },
): { patch: string; truncated: boolean } | null => {
  const target = turnPatchPath(paths, turnId);
  if (!target) return null;
  const fromFile = (file: string) => {
    const text = readFileSync(file, "utf8");
    const patch = text.replace(/^(#[^\n]*\n)+/, "");
    return { header: text.split("\n", 1)[0]!, patch, truncated: patch.includes(CUT_MARK) };
  };
  if (existsSync(target)) {
    const { patch, truncated } = fromFile(target);
    return { patch, truncated };
  }
  if (fallback?.trees && fallback.files.length > 0) {
    const diff = treeChanges(paths.root, fallback.trees.before, fallback.trees.after, fallback.files);
    if (diff) return { patch: diff.patch, truncated: diff.truncated };
  }
  // A turn from before rooms had their own directories: its patch sits in .agoryx/turns/, where another
  // room sharing the workspace may have written a turn of the same number, by the same agent, in the same
  // minute. So it is taken only by a room that alone ever had this workspace (the caller knows the rooms),
  // and only when its header names this turn's author and the minute it ended.
  const legacy = turnPatchPath(workspacePaths(paths.root), turnId)!;
  if (legacy !== target && fallback?.author && fallback.ownsLegacy && existsSync(legacy) && fallback.ownsLegacy()) {
    const { header, patch, truncated } = fromFile(legacy);
    const match = /^# (t\d+) · (.*) · (\d{4}-\d\d-\d\d \d\d:\d\d) UTC$/.exec(header);
    const written = match ? Date.parse(`${match[3]!.replace(" ", "T")}:00Z`) : NaN;
    const near = !fallback.endedAt || Math.abs(written - Date.parse(fallback.endedAt)) <= 2 * 60_000;
    if (match?.[1] === turnId && match[2] === fallback.author && near) return { patch, truncated };
  }
  return null;
};

/** One file's `diff --git` section of a patch; null when the patch does not touch it. */
export const patchSection = (patch: string, path: string): string | null => {
  const want = path.replace(/^\.\//, "");
  return (
    patch.split(/(?=^diff --git )/m).find((part) => {
      const first = part.split("\n", 1)[0]!;
      return first.startsWith("diff --git ") && (first.endsWith(` b/${want}`) || first.includes(` a/${want} `));
    }) ?? null
  );
};

/**
 * The steps named first in the subjects of HEAD's commits made since `since` (ms) that hold some of `files` (paths
 * in the workspace: what the run changed), each with the newest such commit. Another room's "X1 …", or one made
 * before the run, is not this run's step.
 */
export const stepCommitsSince = (root: string, since: number, files: readonly string[]): Map<string, string> => {
  const found = new Map<string, string>();
  const ours = new Set(files);
  const log = git(root, ["-c", "core.quotePath=false", "log", "-n", "200", "--no-renames", "--relative", "--name-only", "--format=%x1e%H%x1f%ct%x1f%s", "HEAD", "--"]) ?? "";
  for (const entry of log.split("\x1e")) {
    const [head = "", ...names] = entry.split("\n");
    const [sha, time, subject] = head.split("\x1f");
    // A second's grace: git keeps whole seconds.
    if (!sha || subject === undefined || Number(time) * 1000 < since - 1000) continue;
    if (!names.some((name) => ours.has(name))) continue;
    for (const id of stepsInSubject(subject)) if (!found.has(id)) found.set(id, sha);
  }
  return found;
};

const AGORYX_IDENT = ["-c", "user.name=Agoryx", "-c", "user.email=agoryx@localhost", "-c", "commit.gpgsign=false"];

/** HEAD of the workspace's own repository (never Agoryx's shadow one): null without one, or before its first commit. */
export const headCommit = (root: string): string | null => (isGitRepo(root) ? git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null : null);

/** A commit on HEAD: what it says first, the workspace files it holds, and whether Agoryx made it (a checkpoint). */
export interface HeadCommit {
  sha: string;
  subject: string;
  files: string[];
  agoryx: boolean;
}

/**
 * The commits HEAD gained after `from` (all of HEAD's when there was none), oldest first, committed at or after
 * `since` (ms): a branch switched to during a turn brings its old commits, not new ones. At most `limit`.
 */
export const commitsSince = (root: string, from: string | null, since: number, limit = 30): HeadCommit[] => {
  const head = headCommit(root);
  if (!head || head === from) return [];
  const log = git(root, ["log", `--max-count=${limit}`, "--reverse", "--format=%H%x1f%ct%x1f%ce%x1f%s", from ? `${from}..HEAD` : "HEAD", "--"]);
  if (!log) return [];
  return log.split("\n").flatMap((line) => {
    const [sha, time, email, subject] = line.split("\x1f");
    if (!sha || !subject || Number(time) * 1000 < since - 2_000) return [];
    return [{ sha, subject, files: commitFilesOf(root, sha), agoryx: email === "agoryx@localhost" }];
  });
};

/** The workspace files a commit changed (paths in the workspace). */
export const commitFilesOf = (root: string, sha: string): string[] =>
  git(root, ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", "--relative", "--root", sha])?.split("\0").filter(Boolean) ?? [];

/**
 * The workspace's files git sees changed or new since HEAD (never .agoryx/), a renamed file's old path with its new
 * one (committing only the new one would keep both); null outside a repository of its own.
 */
export const uncommittedFiles = (root: string): string[] | null => {
  if (!isGitRepo(root)) return null;
  const output = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (output === null) return null;
  const prefix = repoPrefix(root);
  const files = new Set<string>();
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const paths = [entry.slice(3)];
    // A rename's source follows it (staged, or in the worktree after `git add -N`); a copy's source is unchanged.
    if (/[RC]/.test(code)) {
      i += 1;
      if (code.includes("R") && parts[i]) paths.push(parts[i]!);
    }
    for (const path of paths.map((entry) => underPrefix(prefix, entry))) {
      if (path !== null && !path.startsWith(`${AGORYX_DIR}/`)) files.add(path);
    }
  }
  return [...files].sort();
};

/** A git operation the repository is in the middle of (a merge, a rebase…): a commit now would land inside it. */
export const gitOperation = (root: string): string | null => {
  const inside = (name: string) => {
    const path = git(root, ["rev-parse", "--git-path", name])?.trim();
    return Boolean(path && existsSync(resolve(root, path)));
  };
  if (inside("MERGE_HEAD")) return "a merge";
  if (inside("rebase-merge") || inside("rebase-apply")) return "a rebase";
  if (inside("CHERRY_PICK_HEAD")) return "a cherry-pick";
  if (inside("REVERT_HEAD")) return "a revert";
  return null;
};

/** A commit's body, or how to write it from the files the commit holds (paths in the workspace). */
export type CheckpointBody = string | ((files: string[]) => string);

const commitAll = (root: string, subject: string, body: CheckpointBody): { sha: string; files: number } | null => {
  if (!isGitRepo(root)) return null;
  // Only the workspace: a room in a subdirectory never stages or commits the rest of the repository.
  const status = git(root, ["status", "--porcelain", "--", "."]);
  if (!status?.trim()) return null;
  if (git(root, ["add", "-A", "--", "."]) === null) return null;
  const staged = git(root, ["diff", "--cached", "--name-only", "--no-renames", "--relative", "-z"])?.split("\0").filter(Boolean) ?? [];
  if (staged.length === 0) return null;
  const text = typeof body === "function" ? body(staged) : body;
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
    ...(text ? ["-m", text] : []),
    "--",
    ".",
  ]);
  if (committed === null) return null;
  const sha = git(root, ["rev-parse", "HEAD"])?.trim();
  return sha ? { sha, files: staged.length } : null;
};

/**
 * The run's checkpoint. A room alone in its directory commits all of it, as it always has. Given `files`
 * (the room shares the directory), only those credited paths go in, and nobody's staged change is taken.
 */
export const checkpointCommit = (root: string, subject: string, body: CheckpointBody, files?: string[], expectedTrees?: ReadonlyMap<string, string>): { sha: string; files: number } | null =>
  files ? commitPaths(root, subject, body, files, expectedTrees, false) : commitAll(root, subject, body);

/**
 * The human's commit of a step: only `files`, as they are in the folder now, under the folder's own git identity
 * (Agoryx's when it has none). A file the human staged goes in whole; every other staged change stays staged.
 * When git cannot, `fail` hears why (another git holds the index, a signing key that would not sign, HEAD moved).
 */
export const commitFiles = (root: string, subject: string, body: CheckpointBody, files: string[], fail?: (why: string) => void): { sha: string; files: number } | null =>
  files.length ? commitPaths(root, subject, body, files, undefined, true, fail) : null;

const commitPaths = (
  root: string,
  subject: string,
  body: CheckpointBody,
  files: string[],
  expectedTrees: ReadonlyMap<string, string> | undefined,
  own: boolean,
  fail?: (why: string) => void,
): { sha: string; files: number } | null => {
  const failed = (why: string) => {
    fail?.(why);
    return null;
  };
  if (!files.length || !isGitRepo(root)) return null;
  const indexRel = git(root, ["rev-parse", "--git-path", "index"])?.trim();
  if (!indexRel) return null;
  const index = resolve(root, indexRel);
  const lock = `${index}.lock`;
  const scratch = join(tmpdir(), `agoryx-commit-${process.pid}-${randomBytes(8).toString("hex")}`);
  const preserved = `${scratch}-preserved`;
  let locked = false;
  try {
    // Also serializes checkpoints from separate daemons. On contention skip this checkpoint.
    try {
      closeSync(openSync(lock, "wx"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return failed("another git command holds the index (index.lock); try again when it is done");
      throw error;
    }
    locked = true;
    const head = git(root, ["rev-parse", "--verify", "HEAD"])?.trim();
    const prefix = repoPrefix(root);
    const staged = git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
    if (staged === null) return null;
    const occupied = new Set(staged.split("\0"));
    const paths = [...new Set(files)].filter((file) =>
      file && !isAbsolute(file) && !file.split("/").some((part) => part === ".." || part === ".git" || part === AGORYX_DIR) &&
      (own || !occupied.has(`${prefix}${file}`)),
    );
    if (!paths.length) return null;
    let specs = paths.map((file) => `:(top,literal)${prefix}${file}`);
    const env = { ...process.env, GIT_INDEX_FILE: scratch };
    if (git(root, ["read-tree", head ?? "--empty"], 15_000, env) === null) return null;
    if (git(root, ["add", "-A", "--", ...specs], 30_000, env) === null) return null;
    if (expectedTrees) {
      // Stage first, then compare that frozen content with the latest credited turn. A later
      // writer may have changed an allowed file; do not put their version into this room's commit.
      const rejected = paths.filter((file) => {
        const expected = expectedTrees.get(file);
        return !expected || git(root, ["diff", "--cached", "--quiet", expected, "--", `:(top,literal)${prefix}${file}`], 15_000, env) === null;
      });
      if (rejected.length) {
        const rejectedSpecs = rejected.map((file) => `:(top,literal)${prefix}${file}`);
        const args = head ? ["reset", "-q", head, "--", ...rejectedSpecs] : ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "--", ...rejectedSpecs];
        if (git(root, args, 15_000, env) === null) return null;
        specs = paths.filter((file) => !rejected.includes(file)).map((file) => `:(top,literal)${prefix}${file}`);
      }
      if (!specs.length) return null;
    }
    const changed = git(root, ["diff", "--cached", "--name-only", "--no-renames", "--relative", "-z"], 15_000, env)?.split("\0").filter(Boolean);
    if (!changed?.length) return null;
    const text = typeof body === "function" ? body(changed) : body;
    const tree = git(root, ["write-tree"], 15_000, env)?.trim();
    if (!tree) return null;
    const ident = own && git(root, ["var", "GIT_COMMITTER_IDENT"]) !== null && git(root, ["var", "GIT_AUTHOR_IDENT"]) !== null ? [] : AGORYX_IDENT;
    const made = gitSays(root, [...ident, "commit-tree", tree, ...(head ? ["-p", head] : []), "-m", subject, ...(text ? ["-m", text] : [])], 15_000, env);
    const sha = made.out?.trim();
    if (!sha) return failed(made.err || "git commit-tree failed");
    // Prepare the real index's update before moving HEAD. Only the selected, previously unstaged
    // entries change; all foreign staged blobs (including partial staging) remain intact.
    if (existsSync(index)) copyIndex(index, preserved);
    const keptEnv = { ...process.env, GIT_INDEX_FILE: preserved };
    if (git(root, ["reset", "-q", sha, "--", ...specs], 15_000, keptEnv) === null) return null;
    copyIndex(preserved, lock);
    // Compare-and-swap: another writer moving HEAD cannot make us overwrite its commit.
    if (git(root, ["update-ref", "-m", subject, "HEAD", sha, head ?? "0".repeat(sha.length)]) === null) return failed("HEAD moved while committing (another commit?); try again");
    renameSync(lock, index);
    locked = false;
    return { sha, files: changed.length };
  } catch {
    return null;
  } finally {
    if (locked) rmSync(lock, { force: true });
    for (const path of [scratch, preserved, `${scratch}.lock`, `${preserved}.lock`]) rmSync(path, { force: true });
  }
};

// ---------------------------------------------------------------------------
// Returning the folder to a checkpoint (and back)
// ---------------------------------------------------------------------------

const refRoom = (roomId: string): string => roomId.replace(/[^\w-]/g, "") || "room";

/** Where the folder as it was just before a return is kept, so gc never drops it and the return can be undone. */
export const revertRef = (roomId: string, n: number): string => `refs/agoryx/revert/${refRoom(roomId)}/${n}`;

/** Where the whole folder at a checkpoint is kept when the checkpoint's commit does not hold all of it. */
export const checkpointRef = (roomId: string, sha: string): string => `refs/agoryx/checkpoint/${refRoom(roomId)}/${sha.slice(0, 12)}`;

/** `tree` as a commit on `parent`, kept under `ref`; its sha, or null when git could not. */
const keepTree = (root: string, tree: string, parent: string | undefined, ref: string, message: string): string | null => {
  const sha = track(root, [...AGORYX_IDENT, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message])?.trim();
  if (!sha || track(root, ["update-ref", "-m", message, ref, sha]) === null) return null;
  return sha;
};

/** A commit or private recovery snapshot, including in a non-git folder's shadow store. */
export const readCheckpoint = (root: string, sha: string): string | null =>
  track(root, ["show", "--stat", "--patch", "--no-color", "--format=%H%n%s%n%n%b", sha]);

/** Recovery point kept off the working branch; staging and HEAD are untouched. */
export const recoverySnapshot = (root: string, room: string, subject: string): string | null => {
  const tree = snapshotTree(root);
  if (!tree) return null;
  return keepTree(root, tree, undefined, `refs/agoryx/checkpoint/${refRoom(room)}/${randomBytes(12).toString("hex")}`, subject);
};

/**
 * The whole folder at a checkpoint, to return to later. A room alone in its folder commits all of it, so
 * the commit is the folder. A room sharing the folder commits only its own files, so the rest (the human's
 * untracked notes, uncommitted edits, other rooms' files) is kept as a commit on top of it under `ref`.
 * Null when git cannot read the folder; the commit then stands for it.
 */
export const checkpointFolder = (root: string, sha: string, ref: string): string | null => {
  const tree = snapshotTree(root);
  const committed = track(root, ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`])?.trim();
  if (!tree || !committed) return null;
  if (tree === committed) return sha;
  return keepTree(root, tree, sha, ref, `agoryx: the folder at checkpoint ${sha.slice(0, 8)}`);
};

/** A path a return may write or remove: inside the workspace, never in .git or .agoryx. */
const restorable = (path: string): boolean =>
  Boolean(path) && !isAbsolute(path) && !path.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git" || part === AGORYX_DIR);

const restorableChanges = (root: string, from: string, to: string): FileChange[] | null => {
  const base = ["-c", "core.quotepath=off", "diff", "--no-renames", "--no-ext-diff", "--relative", from, to];
  const numstat = track(root, [...base, "--numstat", "-z", "--", "."], 30_000);
  const names = track(root, [...base, "--name-status", "-z", "--", "."], 30_000);
  if (numstat === null || names === null) return null;
  return parseChanges(numstat, names).filter((change) => restorable(change.path));
};

export type RevertPreview = { commit: string; tree: string; changes: FileChange[] } | { error: "missing" | "failed" };

/**
 * What returning the workspace to `target` (a commit) would change, from the files as they are now to
 * the target's: A comes back, D goes away, M is rewritten. `tree` is the folder now as snapshotTree sees
 * it (tracked and untracked files, .gitignore respected: ignored files are never part of a return).
 * "missing": the repository has no such commit; "failed": git could not read the folder.
 */
export const revertPreview = (root: string, target: string): RevertPreview => {
  const commit = track(root, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`])?.trim();
  if (!commit) return { error: "missing" };
  const tree = snapshotTree(root);
  if (!tree) return { error: "failed" };
  const changes = restorableChanges(root, tree, commit);
  return changes ? { commit, tree, changes } : { error: "failed" };
};

/**
 * Make the paths in `changes` (from the folder now to `commit`) match `commit`. Removals go first: a file
 * that becomes a folder, or the other way round, needs its old shape gone. git writes the rest from a
 * scratch index: modes and symlinks come out right, nothing is written through a symlinked folder, and the
 * repository's own index is never used, so a lock someone holds on it (an IDE, the human's git) does not
 * matter. The scratch index is built before anything is touched. False when git failed somewhere.
 */
const applyTree = (root: string, commit: string, changes: FileChange[]): boolean => {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const scratch = join(tmpdir(), `agoryx-restore-${process.pid}-${randomBytes(6).toString("hex")}`);
  const env = { ...process.env, GIT_INDEX_FILE: scratch };
  try {
    if (track(root, ["read-tree", commit], 15_000, env) === null) return false;
    const emptied = new Set<string>();
    for (const change of changes.filter((entry) => entry.status === "D")) {
      const parent = resolveInside(root, dirname(change.path));
      if (!parent) continue;
      try {
        const full = join(parent, change.path.split("/").at(-1)!);
        // lstat, and rm of the entry itself: a symlink goes, what it points to stays.
        if (lstatSync(full).isDirectory()) continue;
        rmSync(full, { force: true });
        emptied.add(parent);
      } catch {
        // Already gone.
      }
    }
    for (let dir of emptied) {
      while (dir !== realRoot && dir.startsWith(`${realRoot}${sep}`)) {
        try {
          if (readdirSync(dir).length) break;
          rmdirSync(dir);
        } catch {
          break;
        }
        dir = dirname(dir);
      }
    }
    // checkout-index takes plain paths relative to the workspace (no pathspec magic).
    const writes = changes.filter((entry) => entry.status !== "D").map((entry) => entry.path);
    let ok = true;
    for (let i = 0; i < writes.length; i += MAX_PATHSPECS) {
      if (track(root, ["checkout-index", "-f", "--", ...writes.slice(i, i + MAX_PATHSPECS)], 60_000, env) === null) ok = false;
    }
    return ok;
  } finally {
    rmSync(scratch, { force: true });
    rmSync(`${scratch}.lock`, { force: true });
  }
};

/**
 * Return the workspace's files to `target`'s, all or nothing. The folder as it is now is first kept as a
 * commit under `ref` (the undo point); then every path that differs is written from the target, or removed
 * when the target has no such file. If some path cannot be written, the folder is put back as it was and
 * the return fails ("failed"); only if that too fails is a partial return reported (`left`: what still
 * differs from the target; the undo point has the rest). HEAD, the branch and the index stay as they are.
 * `after`: the folder right after, kept under `${ref}-after`, so an undo can tell what changed since.
 * `expectTree`: the folder as the human saw it in the preview; if it moved on since, nothing is touched.
 */
export const restoreWorkspace = (
  root: string,
  target: string,
  ref: string,
  message: string,
  expectTree?: string,
): { undo: string; after: string | null; changes: FileChange[]; left: string[] } | { error: "missing" | "changed" | "same" | "failed" } => {
  const preview = revertPreview(root, target);
  if ("error" in preview) return preview;
  if (expectTree && expectTree !== preview.tree) return { error: "changed" };
  const { commit, tree, changes } = preview;
  if (!changes.length) return { error: "same" };
  const head = track(root, ["rev-parse", "--verify", "--quiet", "HEAD"])?.trim();
  const undo = keepTree(root, tree, head || undefined, ref, message);
  if (!undo) return { error: "failed" };
  const now = (to: string) => {
    const seen = revertPreview(root, to);
    return "error" in seen ? null : seen;
  };
  applyTree(root, commit, changes);
  let after = now(commit);
  if (!after || after.changes.length) {
    // Not all of it went: back to how the folder was, so a return is whole or does not happen.
    const back = now(undo);
    if (back && (!back.changes.length || (applyTree(root, undo, back.changes) && now(undo)?.changes.length === 0))) {
      track(root, ["update-ref", "-d", ref]);
      return { error: "failed" };
    }
    after = now(commit);
  }
  const left = after ? after.changes.map((entry) => entry.path) : changes.map((entry) => entry.path);
  const kept = after ? keepTree(root, after.tree, undo, `${ref}-after`, `${message} (after)`) : null;
  return { undo, after: kept, changes, left };
};

/** Paths that differ between the folder now and `commit` (what changed since); null when git cannot tell. */
export const changedSince = (root: string, commit: string): string[] | null => {
  const seen = revertPreview(root, commit);
  return "error" in seen ? null : seen.changes.map((change) => change.path);
};

/**
 * A return made from one room, for the other rooms sharing the folder: .agoryx/reverts/<room>.<seq>.json.
 * Each of them records it once (in-process peers right away, a room of another process before its next
 * turn), so their agents learn of it too.
 */
export interface RevertMarker {
  room: string;
  name: string;
  seq: number;
  ts: string;
  to: string;
  undo: string;
  changes: FileChange[];
  total: number;
  undoOf?: number;
  left?: string[];
}

const revertsDir = (root: string): string => join(root, AGORYX_DIR, "reverts");

export const markRevert = (root: string, marker: RevertMarker): void => {
  const dir = roomDirName(marker.room);
  if (!dir) return;
  const target = join(revertsDir(root), `${dir}.${marker.seq}.json`);
  const partial = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(partial, JSON.stringify(marker));
    renameSync(partial, target);
  } catch {
    rmSync(partial, { force: true });
  }
};

/** Returns made from rooms other than `room` in this folder, oldest first. */
export const revertMarkers = (root: string, room: string): RevertMarker[] => {
  const dir = revertsDir(root);
  if (!existsSync(dir)) return [];
  const own = roomDirName(room);
  const found: RevertMarker[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const marker = JSON.parse(readFileSync(join(dir, name), "utf8")) as RevertMarker;
      if (typeof marker?.room !== "string" || typeof marker.seq !== "number" || typeof marker.to !== "string" || !Array.isArray(marker.changes)) continue;
      if (roomDirName(marker.room) !== own) found.push(marker);
    } catch {
      // Half-written or not ours.
    }
  }
  return found.sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
};

// ---------------------------------------------------------------------------
// Files (for previews in the UI)
// ---------------------------------------------------------------------------

export const listWorkspaceFiles = (root: string, limit = 2000): string[] => {
  const fromGit = track(root, ["ls-files", "-co", "--exclude-standard"]);
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
    // Dereference every component: a symlinked directory must not lead out.
    const realRoot = realpathSync(root);
    const real = realpathSync(full);
    if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return null;
    return real;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Agent-side ops inbox
// ---------------------------------------------------------------------------

export interface InboxOp {
  agent: string;
  raw: Record<string, unknown>;
}

/** An op the agent tool queued: `<ms>-<ns>-<nonce>.<agent>.op`, one per file, so it sorts by when it was sent. */
const OP = /^\d+-\d+-[^.]*\.(.+)\.op$/;
/** A file taken by a drain: an op (or a whole `<agent>.jsonl` from an agent tool before ops had files of their own), its taker and when. */
const TAKING = /^(.+\.(?:jsonl|op))\.(\d+)\.\d+\.taking$/;

/** Who queued what a file in the inbox holds, by its name; undefined for one that is not an op. */
const inboxAgent = (name: string): string | undefined => (name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : OP.exec(name)?.[1]);

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** An op the agent tool began to write and never renamed into place (killed, or the disk full) is gone after this. */
const STALE_OP_MS = 60_000;

/**
 * Take every op out of the inbox, oldest first, and hand each to `apply`. An op is
 * a file of its own, renamed in whole by the agent tool; a drain renames it aside
 * first (atomic: two drains never both take it) and deletes it only after applying
 * it. A taken file left behind by a process that died mid-way (or by this one, if
 * `apply` threw) is taken again the same way, by a rename of its own. A
 * `<agent>.jsonl` from an agent tool before ops had files of their own is taken
 * the same way.
 */
export const drainOpsInbox = (paths: WorkspacePaths, apply: (op: InboxOp) => void): void => {
  if (!existsSync(paths.opsDir)) return;
  const names = readdirSync(paths.opsDir).sort();
  const taken: Array<{ agent: string; file: string }> = [];
  for (const name of names) {
    if (name.endsWith(".op.tmp")) {
      try {
        if (Date.now() - statSync(join(paths.opsDir, name)).mtimeMs > STALE_OP_MS) rmSync(join(paths.opsDir, name), { force: true });
      } catch {
        // gone already: renamed into place, or taken by another drain
      }
      continue;
    }
    const orphan = TAKING.exec(name);
    const agent = orphan && inboxAgent(orphan[1]!);
    if (!agent) continue;
    const owner = Number(orphan[2]);
    // Draining is synchronous, so a file of this process found here is one it failed to finish.
    if (owner !== process.pid && processAlive(owner)) continue;
    // Claimed first, as a fresh op is: another drain that listed it too finds it gone and leaves it.
    const file = join(paths.opsDir, `${orphan[1]}.${process.pid}.${Date.now()}.taking`);
    try {
      renameSync(join(paths.opsDir, name), file);
    } catch {
      continue;
    }
    taken.push({ agent, file });
  }
  const take = (name: string): { name: string; agent: string; file: string } | undefined => {
    const agent = inboxAgent(name);
    if (!agent) return undefined;
    const source = join(paths.opsDir, name);
    const file = `${source}.${process.pid}.${Date.now()}.taking`;
    try {
      renameSync(source, file);
    } catch {
      return undefined;
    }
    return { name, agent, file };
  };
  // Those from before ops had files of their own first: they are older.
  for (const name of names) if (name.endsWith(".jsonl")) taken.push(...[take(name)].filter((entry) => entry !== undefined));
  // A folder read while files come into it lists them in the order of its own index (a hash of the name, on APFS and
  // ext4 alike), not by name: an op sent during the read may be listed while one sent just before it is not. Read it
  // again for an op older than one taken of the same agent (a few times at most), so one sent earlier is not applied
  // after a later one; those sent since wait for the next drain.
  const ops: Array<{ name: string; agent: string; file: string }> = [];
  let listed = names;
  for (let pass = 0; pass < 5; pass += 1) {
    const newest = new Map<string, string>();
    for (const op of ops) if (op.name > (newest.get(op.agent) ?? "")) newest.set(op.agent, op.name);
    const found = listed
      .filter((name) => name.endsWith(".op") && (pass === 0 || name < (newest.get(inboxAgent(name) ?? "") ?? "")))
      .map(take)
      .filter((entry) => entry !== undefined);
    if (found.length === 0) break;
    ops.push(...found);
    listed = readdirSync(paths.opsDir);
  }
  taken.push(...ops.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  for (const { agent, file } of taken) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // ignore malformed lines
      }
      if (raw && typeof raw === "object") apply({ agent, raw });
    }
    rmSync(file, { force: true });
  }
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

export const repoRoot = (): string => {
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
