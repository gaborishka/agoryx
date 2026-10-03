import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pidAlive } from "./daemoninfo.js";
import { foldMemoryEvent, memoryBriefing, memoryUpdateLine, type MemoryEntry, type MemoryEventBody } from "./memory.js";
import { agoraHome } from "./paths.js";
import type { ActorOrigin, RoomState } from "./types.js";

/**
 * A project: the folder Work rooms work in, with what outlives one room — a name, a goal, instructions for the
 * agents and (memory.ts) what the rooms decided and still disagree about.
 *
 * Its key is the folder: the source folder for a room in a worktree, so every worktree of a repository shares
 * its project. Membership is derived, never stored on a room. Chat rooms have no project. Nothing is written
 * until someone writes something: a folder without data is a project with nothing in it.
 *
 * Context folders: other folders the project's agents work with besides its own (another repository, a folder of
 * material). Agents of its Work rooms get access to them and are told where they are. Added and removed by
 * someone, like everything else here.
 *
 * Its library: files someone added to the project (an attached file, a paper), by path, where they are; nothing is
 * copied. Its agents are told where they are.
 *
 * Kept in <AGORYX_HOME>/projects/<hash>/: `events.jsonl` (append-only, every write with who made it) is the
 * truth; `project.json` is what it adds up to, for reading by hand.
 */

export type ProjectField = "name" | "goal" | "instructions";
export const PROJECT_FIELDS: readonly ProjectField[] = ["name", "goal", "instructions"];

/** A goal or instructions are a paragraph, not a document: agents get them with every fresh session. */
export const MAX_PROJECT_TEXT = 4_000;

export type ProjectEventBody =
  | { type: "project.changed"; field: ProjectField; value: string | null }
  | { type: "context.added"; path: string }
  | { type: "context.removed"; path: string }
  | { type: "library.added"; path: string }
  | { type: "library.removed"; path: string }
  | MemoryEventBody;

export type ProjectEvent = ProjectEventBody & {
  seq: number;
  ts: string;
  /** The human's name or an agent's id. */
  by: string;
  /** An agent wrote it: which one, from which room. */
  from?: ActorOrigin;
};

export interface Project {
  key: string;
  hash: string;
  name?: string;
  goal?: string;
  instructions?: string;
  /** Context folders, absolute, in the order they were added. */
  context: string[];
  /** Files added to the project, absolute, oldest first: who added each, when. */
  library: LibraryFile[];
  /** What its rooms keep (memory.ts), in the order it was written. */
  memory: MemoryEntry[];
  /** The last event's seq; 0: nothing written yet. */
  seq: number;
  /** The last name/goal/instructions change's seq: an edit of them made against an older one is refused. */
  fieldsSeq: number;
  events: ProjectEvent[];
}

export interface LibraryFile {
  path: string;
  by: string;
  from?: ActorOrigin;
  at: string;
}

/** Who writes: the human (by name), or an agent from one of its rooms. */
export type ProjectWriter = { by: string; from?: ActorOrigin };

/** The project a room belongs to: its folder (a worktree's source folder); null in Chat. */
export const projectKey = (state: Pick<RoomState, "mode" | "workspace" | "worktree">): string | null =>
  state.mode === "chat" ? null : (state.worktree?.source ?? state.workspace);

export const projectHash = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 12);

export const projectsDir = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "projects");

export const projectDir = (key: string, env: NodeJS.ProcessEnv = process.env): string => join(projectsDir(env), projectHash(key));

const eventsFile = (key: string, env: NodeJS.ProcessEnv) => join(projectDir(key, env), "events.jsonl");

const readEvents = (file: string): ProjectEvent[] => {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: ProjectEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as ProjectEvent);
    } catch {
      // A partial line from a crash mid-write: what came before it still stands.
    }
  }
  return events;
};

/** The project as its events add up to. */
export const foldProject = (key: string, events: ProjectEvent[]): Project => {
  const project: Project = { key, hash: projectHash(key), context: [], library: [], memory: [], seq: 0, fieldsSeq: 0, events };
  for (const event of events) {
    project.seq = Math.max(project.seq, event.seq);
    if (event.type === "project.changed") {
      project.fieldsSeq = event.seq;
      if (event.value) project[event.field] = event.value;
      else delete project[event.field];
    } else if (event.type === "context.added") {
      if (!project.context.includes(event.path)) project.context = [...project.context, event.path];
    } else if (event.type === "context.removed") {
      project.context = project.context.filter((path) => path !== event.path);
    } else if (event.type === "library.added") {
      if (!project.library.some((file) => file.path === event.path)) {
        project.library = [...project.library, { path: event.path, by: event.by, ...(event.from ? { from: event.from } : {}), at: event.ts }];
      }
    } else if (event.type === "library.removed") {
      project.library = project.library.filter((file) => file.path !== event.path);
    } else project.memory = foldMemoryEvent(project.memory, event);
  }
  return project;
};

export const readProject = (key: string, env: NodeJS.ProcessEnv = process.env): Project => foldProject(key, readEvents(eventsFile(key, env)));

/** Whether anyone has written anything for this folder. */
export const hasProjectData = (key: string, env: NodeJS.ProcessEnv = process.env): boolean => existsSync(eventsFile(key, env));

const summaryOf = (project: Project) => ({
  key: project.key,
  ...(project.name ? { name: project.name } : {}),
  ...(project.goal ? { goal: project.goal } : {}),
  ...(project.instructions ? { instructions: project.instructions } : {}),
  ...(project.context.length ? { context: project.context } : {}),
  ...(project.library.length ? { library: project.library.map((file) => file.path) } : {}),
  memory: project.memory.length,
  seq: project.seq,
});

export class ProjectError extends Error {}

/** A lock its holder left behind: the holder is gone, or has held it far longer than any write takes. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const held = new Set<string>();
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` while this process alone writes the project's log: rooms driven by separate processes (no daemon) share it,
 * and each write reads the log, numbers its event (and a memory entry's id) and appends — two at once would number
 * alike. Reentrant within a process. A lock left by a process that died is taken over.
 */
export const lockProject = <T>(key: string, env: NodeJS.ProcessEnv, fn: () => T): T => {
  const dir = projectDir(key, env);
  if (held.has(dir)) return fn();
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "events.lock");
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let text = "";
    let age = 0;
    try {
      text = readFileSync(lock, "utf8");
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile
    }
    const pid = Number(text);
    if ((text && Number.isInteger(pid) && pid !== process.pid && !pidAlive(pid)) || age > STALE_LOCK_MS) {
      // Set aside, and delete only if it is still the lock judged stale; a fresh one another process took meanwhile goes back.
      const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
      try {
        renameSync(lock, aside);
      } catch {
        continue;
      }
      let moved = "";
      try {
        moved = readFileSync(aside, "utf8");
      } catch {
        // gone
      }
      if (moved !== text) {
        try {
          linkSync(aside, lock);
        } catch {
          // the lock there now stands
        }
      }
      rmSync(aside, { force: true });
      continue;
    }
    if (Date.now() > until) throw new ProjectError(`another process (${text || "?"}) is writing this project; try again`);
    pause(15);
  }
  held.add(dir);
  try {
    return fn();
  } finally {
    held.delete(dir);
    rmSync(lock, { force: true });
  }
};

/** Append one event; returns the project after it. */
export const appendProjectEvent = (key: string, body: ProjectEventBody, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project =>
  lockProject(key, env, () => {
    const dir = projectDir(key, env);
    const file = join(dir, "events.jsonl");
    const before = readEvents(file);
    const seq = before.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
    const event = { ...body, seq, ts: new Date().toISOString(), by: writer.by, ...(writer.from ? { from: writer.from } : {}) } as ProjectEvent;
    appendFileSync(file, `${JSON.stringify(event)}\n`);
    const project = foldProject(key, [...before, event]);
    const tmp = join(dir, "project.json.tmp");
    writeFileSync(tmp, `${JSON.stringify(summaryOf(project), null, 2)}\n`);
    renameSync(tmp, join(dir, "project.json"));
    return project;
  });

/** Set (or, with an empty text, clear) a name, goal or instructions. Nothing is appended when nothing changes. */
export const setProjectField = (key: string, field: ProjectField, text: string, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  if (!PROJECT_FIELDS.includes(field)) throw new ProjectError(`a project has a ${PROJECT_FIELDS.join(", ")}; not "${field}"`);
  const value = text.replace(/\r\n/g, "\n").trim();
  if (field === "name" && value.includes("\n")) throw new ProjectError("a project's name is one line");
  if (value.length > MAX_PROJECT_TEXT) throw new ProjectError(`the ${field} is ${value.length} characters; at most ${MAX_PROJECT_TEXT}`);
  return lockProject(key, env, () => {
    const project = readProject(key, env);
    if ((project[field] ?? "") === value) return project;
    return appendProjectEvent(key, { type: "project.changed", field, value: value || null }, writer, env);
  });
};

/** A context folder as written: absolute, `~` expanded, no trailing separator. */
const contextPath = (path: string, env: NodeJS.ProcessEnv): string => {
  const home = env.HOME ?? process.env.HOME ?? "";
  const raw = path.trim().replace(/^~(?=$|[\\/])/, home);
  if (!raw || !isAbsolute(raw)) throw new ProjectError(`a context folder is an absolute path (or ~/…); not "${path}"`);
  return resolve(raw).replace(/[\\/]+$/, "") || sep;
};

/** `path` is `dir` or inside it — by `relative`, so a root (`/`, `C:\\`) holds everything under it. */
const within = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

/** The folder `path` names, if it can be a context folder of the project in `key`; else why not. */
export const checkContextFolder = (key: string, path: string, env: NodeJS.ProcessEnv = process.env): string => {
  const folder = contextPath(path, env);
  let isDir = false;
  try {
    isDir = statSync(folder).isDirectory();
  } catch {
    // not there
  }
  if (!isDir) throw new ProjectError(`no folder at ${folder}`);
  if (within(key, folder)) throw new ProjectError(`${folder} is inside the project's own folder: its agents work there already`);
  if (within(folder, key)) throw new ProjectError(`${folder} holds the project's own folder: name a folder beside it, not above it`);
  return folder;
};

/**
 * Add a context folder: an existing folder outside the project's own (inside it the agents have it already).
 * `path` is absolute or `~/…`; returns the project after it. Nothing is appended for a folder already there.
 */
export const addProjectContext = (key: string, path: string, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  const folder = checkContextFolder(key, path, env);
  return lockProject(key, env, () => {
    const project = readProject(key, env);
    if (project.context.includes(folder)) return project;
    return appendProjectEvent(key, { type: "context.added", path: folder }, writer, env);
  });
};

export const removeProjectContext = (key: string, path: string, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  const asked = contextPath(path, env);
  return lockProject(key, env, () => {
    const folder = readProject(key, env).context.find((entry) => entry === asked);
    if (!folder) throw new ProjectError(`${path} is not a context folder of this project`);
    return appendProjectEvent(key, { type: "context.removed", path: folder }, writer, env);
  });
};

/** A file added to the library: absolute, `~` expanded. */
const libraryPath = (path: string, env: NodeJS.ProcessEnv): string => {
  const home = env.HOME ?? process.env.HOME ?? "";
  const raw = path.trim().replace(/^~(?=$|[\\/])/, home);
  if (!raw || !isAbsolute(raw)) throw new ProjectError(`a library file is an absolute path (or ~/…); not "${path}"`);
  return resolve(raw);
};

/** Add a file to the project's library, where it is; nothing is appended for a file already there. */
export const addLibraryFile = (key: string, path: string, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  const file = libraryPath(path, env);
  let isFile = false;
  try {
    isFile = statSync(file).isFile();
  } catch {
    // not there
  }
  if (!isFile) throw new ProjectError(`no file at ${file}`);
  return lockProject(key, env, () => {
    const project = readProject(key, env);
    if (project.library.some((entry) => entry.path === file)) return project;
    return appendProjectEvent(key, { type: "library.added", path: file }, writer, env);
  });
};

/** Take a file out of the library; the file itself stays where it is. */
export const removeLibraryFile = (key: string, path: string, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  const file = libraryPath(path, env);
  return lockProject(key, env, () => {
    if (!readProject(key, env).library.some((entry) => entry.path === file)) throw new ProjectError(`${path} is not in this project's library`);
    return appendProjectEvent(key, { type: "library.removed", path: file }, writer, env);
  });
};

/** The context folders the project's agents are given: those still there. */
export const contextFolders = (project: Pick<Project, "context">): string[] =>
  project.context.filter((folder) => {
    try {
      return statSync(folder).isDirectory();
    } catch {
      return false;
    }
  });

/** Every folder someone has written something for. */
export const listProjects = (env: NodeJS.ProcessEnv = process.env): Project[] => {
  const root = projectsDir(env);
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const projects: Project[] = [];
  for (const dir of dirs) {
    let key: string | undefined;
    try {
      key = (JSON.parse(readFileSync(join(root, dir, "project.json"), "utf8")) as { key?: string }).key;
    } catch {
      continue;
    }
    if (key && projectHash(key) === dir) projects.push(readProject(key, env));
  }
  return projects;
};

/** A project's display name: the one written for it, else the folder's own name. */
export const projectTitle = (project: Pick<Project, "key" | "name">): string =>
  project.name ?? (project.key.split(/[\\/]/).filter(Boolean).at(-1) || project.key);

/** The project a folder belongs to: the folder itself, unless it is a room's worktree (then the folder it was made from). */
export const projectKeyOfFolder = (folder: string, rooms: Array<{ workspace: string; folder?: string; branch?: string }>): string =>
  rooms.find((room) => room.branch && room.folder && room.workspace === folder)?.folder ?? folder;

/** `agoryx project`: what a project holds, and who wrote it last. */
export const describeProject = (project: Project, rooms: Array<{ id: string; name: string }>): string[] => {
  const lines = [`Project: ${projectTitle(project)}`, `  folder  ${project.key}`];
  if (project.seq === 0) {
    lines.push("  nothing written yet — `agoryx project set goal|instructions|name \"…\"` (agents of its Work rooms get the goal and instructions)");
  }
  for (const field of PROJECT_FIELDS) {
    const value = project[field];
    if (!value) continue;
    const event = lastChange(project.events, field);
    lines.push("", `${field}${event ? ` (by ${event.from ? `${event.by} in "${event.from.roomName}"` : event.by}, ${event.ts.slice(0, 10)})` : ""}:`);
    for (const line of value.split("\n")) lines.push(`  ${line}`);
  }
  if (project.context.length) {
    lines.push("", "context folders (its agents work with them too):");
    for (const folder of project.context) lines.push(`  ${folder}${existsSync(folder) ? "" : "  (not there now)"}`);
  }
  if (project.library.length) {
    lines.push("", "library (files added to the project, where they are):");
    for (const file of project.library) lines.push(`  ${file.path}${existsSync(file.path) ? "" : "  (not there now)"}`);
  }
  if (project.memory.length) lines.push("", `memory: ${project.memory.length} entr${project.memory.length === 1 ? "y" : "ies"} — \`agoryx memory\``);
  lines.push("", rooms.length ? `Work rooms in it: ${rooms.map((room) => `"${room.name}" (${room.id})`).join(", ")}` : "No Work room works in it yet.");
  return lines;
};

const writerOf = (event: ProjectEvent): string => (event.from ? `${event.by} in "${event.from.roomName}"` : event.by);

const lastChange = (events: ProjectEvent[], field: ProjectField) =>
  [...events].reverse().find((event): event is ProjectEvent & { type: "project.changed" } => event.type === "project.changed" && event.field === field);

const block = (text: string): string => text.split("\n").map((line) => `    ${line}`).join("\n");

/**
 * The project for a fresh Work session's briefing: what was written for this folder, each part with who wrote it,
 * its memory (an index, disagreements first), and how to change them. With nothing written, one line on how to.
 */
export const projectBriefing = (project: Project, cli: string, env: NodeJS.ProcessEnv = process.env): string => {
  const lines = [`Project: ${projectTitle(project)} — this folder's project, shared by every Work room in it (${project.key}).`];
  if (project.seq === 0) {
    lines.push(
      `  Nothing is written for it yet. \`${cli} project set goal|instructions "…"\` and \`${cli} memory note "…"\` (or \`${cli} memory promote S3|D1|Q1\` from the table) keep what every Work room here starts with — anyone may, you included.`,
    );
    return lines.join("\n");
  }
  const written = (["goal", "instructions"] as const).filter((field) => project[field]);
  if (written.length) lines.push("  Written by those who work here, each part by someone; Agoryx adds nothing to it:");
  for (const field of written) {
    const event = lastChange(project.events, field);
    lines.push(`  ${field === "goal" ? "Goal" : "Instructions"}${event ? ` — by ${writerOf(event)}` : ""}:`, block(project[field]!));
  }
  const context = contextFolders(project);
  if (context.length) {
    lines.push("  Context folders — you can read and write them as you do this folder:");
    for (const folder of context) lines.push(`    ${folder}`);
  }
  const library = project.library.filter((file) => existsSync(file.path));
  if (library.length) {
    lines.push("  Library — files added to the project, each where it is:");
    for (const file of library) lines.push(`    ${file.path} — added by ${file.from ? `${file.by} in "${file.from.roomName}"` : file.by}`);
  }
  lines.push(`  \`${cli} project\` shows it; \`${cli} project set goal|instructions|name "…"\` changes it for every Work room in this folder.`);
  lines.push(...memoryBriefing(project, cli, env));
  return lines.join("\n");
};

/**
 * What changed in the project since this agent's session last got it (`seen`: the project's seq then), for a running
 * session's delta: each part someone else changed, with its new text. Its own writes it already knows. Null: nothing new.
 */
export const projectUpdate = (project: Project, seen: number, reader: { room: string; agent: string }, cli = "agoryx"): string | null => {
  const fresh = project.events.filter((event) => event.seq > seen && !(event.by === reader.agent && event.from?.room === reader.room));
  if (fresh.length === 0) return null;
  const lines = [`── The project (${projectTitle(project)}) changed since your last turn:`];
  for (const field of PROJECT_FIELDS) {
    const event = lastChange(fresh, field);
    if (!event) continue;
    const now = project[field];
    if (!now) lines.push(`  ${writerOf(event)} cleared the ${field}.`);
    else if (field === "name") lines.push(`  ${writerOf(event)} named it "${now}".`);
    else lines.push(`  ${writerOf(event)} wrote the ${field}:`, block(now));
  }
  for (const event of fresh) {
    if (event.type === "context.added") lines.push(`  ${writerOf(event)} added the context folder ${event.path} — you can read and write it from this turn on.`);
    if (event.type === "context.removed") lines.push(`  ${writerOf(event)} removed the context folder ${event.path}.`);
    if (event.type === "library.added") lines.push(`  ${writerOf(event)} added ${event.path} to the project's library.`);
    if (event.type === "library.removed") lines.push(`  ${writerOf(event)} took ${event.path} out of the project's library (the file stays where it is).`);
  }
  const memory = memoryUpdateLine(fresh, cli);
  if (memory) lines.push(memory);
  return lines.length > 1 ? lines.join("\n") : null;
};
