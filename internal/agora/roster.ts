import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agoraHome } from "./paths.js";
import type { AgentKind, RoomAgent } from "./types.js";

/**
 * Who sits in a room. A third voice costs a few lines of JSON, not code:
 *
 *   [
 *     { "id": "opus", "kind": "claude", "model": "opus" },
 *     { "id": "sonnet", "kind": "claude", "model": "sonnet" },
 *     { "kind": "codex" }
 *   ]
 *
 * `kind` picks the CLI (claude or codex); `id` is the @handle and defaults to the kind;
 * `label` is the display name and defaults to the id, capitalised; `model` is passed to the CLI;
 * `effort` too ("high", "xhigh", … — Claude's --effort, Codex's model_reasoning_effort);
 * `"profile": false` keeps the human's profile (<AGORYX_HOME>/profile.md) from this agent — it is on otherwise.
 * The list may also come wrapped as { "agents": [...] }. A room keeps the roster it was
 * created with (it is in its event log): changing the file later changes only new rooms.
 */

export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex"];

export const DEFAULT_AGENTS: RoomAgent[] = [
  { id: "claude", kind: "claude", label: "Claude" },
  { id: "codex", kind: "codex", label: "Codex" },
];

/** The roster every new room gets unless it is given its own: <AGORYX_HOME>/agents.json. */
export const rosterPath = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "agents.json");

/** What `@handle` can reach (see parseMentions): a letter, then 1–31 of letters, digits, _ and -. Lower-case, since mentions are. */
const ID = /^[a-z][a-z0-9_-]{1,31}$/;
/** Handles that already mean something in a room. */
const RESERVED = new Set(["all", "agoryx"]);
const KEYS = new Set(["id", "kind", "label", "model", "effort", "profile"]);
/** A level name for the CLI, never a flag or anything with quotes: it ends up inside -c key="…". */
const EFFORT = /^[a-z][a-z0-9-]{0,19}$/;

export class RosterError extends Error {}

const capitalise = (id: string): string => id[0]!.toUpperCase() + id.slice(1);

/** Checks a roster and fills in the defaults. Throws RosterError, naming the entry, on anything a room could not work with. */
export const parseAgents = (raw: unknown, source = "agents"): RoomAgent[] => {
  const list = raw && typeof raw === "object" && !Array.isArray(raw) && "agents" in raw ? (raw as { agents: unknown }).agents : raw;
  if (!Array.isArray(list) || list.length === 0) throw new RosterError(`${source}: expected a non-empty list of agents`);
  const agents: RoomAgent[] = [];
  list.forEach((entry, index) => {
    const at = `${source}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RosterError(`${at}: expected an object like { "id": "opus", "kind": "claude" }`);
    const fields = entry as Record<string, unknown>;
    const unknown = Object.keys(fields).filter((key) => !KEYS.has(key));
    if (unknown.length) throw new RosterError(`${at}: unknown field ${unknown.map((key) => `"${key}"`).join(", ")} (allowed: id, kind, label, model, effort, profile)`);
    const kind = fields.kind;
    if (typeof kind !== "string" || !AGENT_KINDS.includes(kind as AgentKind)) {
      throw new RosterError(`${at}: "kind" must be one of ${AGENT_KINDS.join(", ")}`);
    }
    const id = fields.id === undefined ? kind : fields.id;
    if (typeof id !== "string" || !ID.test(id)) {
      throw new RosterError(`${at}: "id" must be 2–32 lower-case letters, digits, _ or -, starting with a letter (it is the @handle), got ${JSON.stringify(id)}`);
    }
    if (RESERVED.has(id)) throw new RosterError(`${at}: "${id}" is reserved in a room`);
    const label = fields.label === undefined ? capitalise(id) : fields.label;
    if (typeof label !== "string" || !label.trim() || label.trim().length > 40) throw new RosterError(`${at}: "label" must be 1–40 characters`);
    const model = fields.model;
    if (model !== undefined && (typeof model !== "string" || !model.trim() || model.trim().startsWith("-") || model.trim().length > 100)) {
      throw new RosterError(`${at}: "model" must be a model name for the ${kind} CLI`);
    }
    const effort = fields.effort;
    if (effort !== undefined && (typeof effort !== "string" || !EFFORT.test(effort.trim()))) {
      throw new RosterError(`${at}: "effort" must be a level name for the ${kind} CLI, like "high" or "xhigh"`);
    }
    const profile = fields.profile;
    if (profile !== undefined && typeof profile !== "boolean") {
      throw new RosterError(`${at}: "profile" must be true or false (false: this agent is not given your profile)`);
    }
    if (agents.some((agent) => agent.id === id)) {
      throw new RosterError(`${at}: two agents are called "${id}" — give each its own "id" (messages and @mentions tell agents apart by it)`);
    }
    if (agents.some((agent) => agent.label.toLowerCase() === label.trim().toLowerCase())) {
      throw new RosterError(`${at}: two agents are labelled "${label.trim()}" — the others could not tell whose message is whose`);
    }
    agents.push({ id, kind: kind as AgentKind, label: label.trim(), ...(model !== undefined ? { model: (model as string).trim() } : {}), ...(effort !== undefined ? { effort: (effort as string).trim() } : {}), ...(profile === false ? { profile: false as const } : {}) });
  });
  return agents;
};

/** A roster from inline JSON (starts with [ or {) or from a JSON file. */
export const readRoster = (value: string, cwd = process.cwd()): RoomAgent[] => {
  const inline = /^\s*[[{]/.test(value);
  const source = inline ? "agents" : resolve(cwd, value);
  let text = value;
  if (!inline) {
    try {
      text = readFileSync(source, "utf8");
    } catch (error) {
      throw new RosterError(`cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new RosterError(`${source}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseAgents(raw, source);
};

/** The roster for a new room that was not given one: the file, if there is one, else Claude and Codex. */
export const defaultRoster = (env: NodeJS.ProcessEnv = process.env): RoomAgent[] => {
  const path = rosterPath(env);
  return existsSync(path) ? readRoster(path) : DEFAULT_AGENTS;
};
