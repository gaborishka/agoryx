import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileChange } from "./types.js";

export const AGORYX_DIR = ".agoryx";

const git = (cwd: string, args: string[], timeout = 15_000, env?: NodeJS.ProcessEnv): string | null => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      ...(env ? { env } : {}),
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
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
    if (code[0] === "R" || code[0] === "C") i += 1; // skip rename source
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
    if (existsSync(index)) copyFileSync(index, scratch);
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
  const specs = files.map((file) => `:(top,literal)${prefix}${file}`);
  // --relative: paths in the counts and the patch are the workspace's, like everywhere else in the room.
  const base = ["-c", "core.quotepath=off", "diff", "--no-renames", "--no-ext-diff", "--no-color", "--relative", before, after];
  const numstat = track(root, [...base, "--numstat", "-z", "--", ...specs]);
  const names = track(root, [...base, "--name-status", "-z", "--", ...specs]);
  if (numstat === null || names === null) return null;
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

const commitAll = (root: string, subject: string, body: string): { sha: string; files: number } | null => {
  if (!isGitRepo(root)) return null;
  // Only the workspace: a room in a subdirectory never stages or commits the rest of the repository.
  const status = git(root, ["status", "--porcelain", "--", "."]);
  if (!status?.trim()) return null;
  if (git(root, ["add", "-A", "--", "."]) === null) return null;
  const staged = git(root, ["diff", "--cached", "--name-only", "--", "."])?.split("\n").filter(Boolean) ?? [];
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
export const checkpointCommit = (root: string, subject: string, body: string, files?: string[], expectedTrees?: ReadonlyMap<string, string>): { sha: string; files: number } | null => {
  if (!files) return commitAll(root, subject, body);
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
    closeSync(openSync(lock, "wx"));
    locked = true;
    const head = git(root, ["rev-parse", "--verify", "HEAD"])?.trim();
    const prefix = repoPrefix(root);
    const staged = git(root, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
    if (staged === null) return null;
    const occupied = new Set(staged.split("\0"));
    const paths = [...new Set(files)].filter((file) =>
      file && !isAbsolute(file) && !file.split("/").some((part) => part === ".." || part === ".git" || part === AGORYX_DIR) &&
      !occupied.has(`${prefix}${file}`),
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
    const changed = git(root, ["diff", "--cached", "--name-only", "-z"], 15_000, env)?.split("\0").filter(Boolean);
    if (!changed?.length) return null;
    const tree = git(root, ["write-tree"], 15_000, env)?.trim();
    if (!tree) return null;
    const sha = git(root, ["-c", "user.name=Agoryx", "-c", "user.email=agoryx@localhost", "-c", "commit.gpgsign=false",
      "commit-tree", tree, ...(head ? ["-p", head] : []), "-m", subject, ...(body ? ["-m", body] : [])], 15_000, env)?.trim();
    if (!sha) return null;
    // Prepare the real index's update before moving HEAD. Only the selected, previously unstaged
    // entries change; all foreign staged blobs (including partial staging) remain intact.
    if (existsSync(index)) copyFileSync(index, preserved);
    const keptEnv = { ...process.env, GIT_INDEX_FILE: preserved };
    if (git(root, ["reset", "-q", sha, "--", ...specs], 15_000, keptEnv) === null) return null;
    copyFileSync(preserved, lock);
    // Compare-and-swap: another writer moving HEAD cannot make us overwrite its commit.
    if (git(root, ["update-ref", "-m", subject, "HEAD", sha, head ?? "0".repeat(sha.length)]) === null) return null;
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

const TAKING = /^(.+)\.jsonl\.(\d+)\.\d+\.taking$/;

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Take every ops file (one per agent) out of the inbox and hand each op to `apply`.
 * A file is renamed aside first (atomic; agents keep appending to a fresh file)
 * and deleted only after all its ops were applied. A taken file left behind by a
 * process that died mid-way (or by this one, if `apply` threw) is picked up again.
 */
export const drainOpsInbox = (paths: WorkspacePaths, apply: (op: InboxOp) => void): void => {
  if (!existsSync(paths.opsDir)) return;
  const names = readdirSync(paths.opsDir).sort();
  const taken: Array<{ agent: string; file: string }> = [];
  for (const name of names) {
    const orphan = TAKING.exec(name);
    if (!orphan) continue;
    const owner = Number(orphan[2]);
    // Draining is synchronous, so a file of this process found here is one it failed to finish.
    if (owner !== process.pid && processAlive(owner)) continue;
    taken.push({ agent: orphan[1]!, file: join(paths.opsDir, name) });
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const source = join(paths.opsDir, name);
    const file = `${source}.${process.pid}.${Date.now()}.taking`;
    try {
      renameSync(source, file);
    } catch {
      continue;
    }
    taken.push({ agent: name.slice(0, -".jsonl".length), file });
  }
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
