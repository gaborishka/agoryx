import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * Kept in <AGORYX_HOME>/projects/<hash>/: `events.jsonl` (append-only, every write with who made it) is the
 * truth; `project.json` is what it adds up to, for reading by hand.
 */

export type ProjectField = "name" | "goal" | "instructions";
export const PROJECT_FIELDS: readonly ProjectField[] = ["name", "goal", "instructions"];

/** A goal or instructions are a paragraph, not a document: agents get them with every fresh session. */
export const MAX_PROJECT_TEXT = 4_000;

export type ProjectEventBody = { type: "project.changed"; field: ProjectField; value: string | null };

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
  /** The last event's seq; 0: nothing written yet. */
  seq: number;
  events: ProjectEvent[];
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
  const project: Project = { key, hash: projectHash(key), seq: 0, events };
  for (const event of events) {
    project.seq = Math.max(project.seq, event.seq);
    if (event.type === "project.changed") {
      if (event.value) project[event.field] = event.value;
      else delete project[event.field];
    }
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
  seq: project.seq,
});

/** Append one event; returns the project after it. */
export const appendProjectEvent = (key: string, body: ProjectEventBody, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  const dir = projectDir(key, env);
  mkdirSync(dir, { recursive: true });
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
};

export class ProjectError extends Error {}

/** Set (or, with an empty text, clear) a name, goal or instructions. Nothing is appended when nothing changes. */
export const setProjectField = (key: string, field: ProjectField, text: string, writer: ProjectWriter, env: NodeJS.ProcessEnv = process.env): Project => {
  if (!PROJECT_FIELDS.includes(field)) throw new ProjectError(`a project has a ${PROJECT_FIELDS.join(", ")}; not "${field}"`);
  const value = text.replace(/\r\n/g, "\n").trim();
  if (field === "name" && value.includes("\n")) throw new ProjectError("a project's name is one line");
  if (value.length > MAX_PROJECT_TEXT) throw new ProjectError(`the ${field} is ${value.length} characters; at most ${MAX_PROJECT_TEXT}`);
  const project = readProject(key, env);
  if ((project[field] ?? "") === value) return project;
  return appendProjectEvent(key, { type: "project.changed", field, value: value || null }, writer, env);
};

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
  const last = (field: ProjectField) => [...project.events].reverse().find((event) => event.type === "project.changed" && event.field === field);
  for (const field of PROJECT_FIELDS) {
    const value = project[field];
    if (!value) continue;
    const event = last(field);
    lines.push("", `${field}${event ? ` (by ${event.from ? `${event.by} in "${event.from.roomName}"` : event.by}, ${event.ts.slice(0, 10)})` : ""}:`);
    for (const line of value.split("\n")) lines.push(`  ${line}`);
  }
  lines.push("", rooms.length ? `Work rooms in it: ${rooms.map((room) => `"${room.name}" (${room.id})`).join(", ")}` : "No Work room works in it yet.");
  return lines;
};
