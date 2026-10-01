import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agoraHome } from "./paths.js";
import type { Actor, ActorOrigin, RoomSettings, RoomState } from "./types.js";

/**
 * Agents' keys to the daemon.
 *
 * Every agent in a room has its own key: "agx1.<room>.<agent>.<mac>", the mac an HMAC of the room and
 * the agent under the daemon's token. The daemon issues it (the engine puts it in the turn's
 * environment as AGORYX_AGENT_KEY) and checks it by computing the mac again, so nothing is stored and
 * a key outlives daemon restarts, like the token it comes from. With it, the human's own CLI in an
 * agent's shell works as it does for the human — same commands, nothing refused — and the daemon
 * records what it does as that agent's, never as the human's.
 *
 * It is attribution, not a sandbox: an agent can still read the human's token file, as the human
 * decided (agents work like ordinary Claude Code and Codex, without prohibitions the human does not have).
 * What guards the human's name is the daemon: it refuses the human's token from an agent's process
 * (agentprocs.ts), so the token read from the file signs nothing.
 */
export const AGENT_KEY_ENV = "AGORYX_AGENT_KEY";

const TOKEN_FILE = "daemon.token";

/** The daemon's token (the human's): it survives daemon restarts so an open browser tab keeps working. Agents' keys are signed with it. */
export const loadOrCreateToken = (env: NodeJS.ProcessEnv = process.env): string => {
  const path = join(agoraHome(env), TOKEN_FILE);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // create below
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
};

const KEY_PREFIX = "agx1";
const AGENT_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const ROOM_ID = /^[\w.-]+$/;

const keyMac = (secret: string, room: string, agent: string): string =>
  createHmac("sha256", secret).update(`agoryx agent key\0${room}\0${agent}`).digest("base64url");

export const agentKey = (secret: string, room: string, agent: string): string => `${KEY_PREFIX}.${room}.${agent}.${keyMac(secret, room, agent)}`;

export const isAgentKey = (value: string): boolean => value.startsWith(`${KEY_PREFIX}.`);

/** The room and agent a key names, if this secret signed it; null for anything else. */
export const readAgentKey = (secret: string, key: string): { room: string; agent: string } | null => {
  const parts = key.split(".");
  if (parts.length < 4 || parts[0] !== KEY_PREFIX) return null;
  const mac = parts.at(-1)!;
  const agent = parts.at(-2)!;
  const room = parts.slice(1, -2).join(".");
  if (!ROOM_ID.test(room) || !AGENT_ID.test(agent)) return null;
  const want = Buffer.from(keyMac(secret, room, agent));
  const given = Buffer.from(mac);
  return want.length === given.length && timingSafeEqual(want, given) ? { room, agent } : null;
};

/** What a room calls an agent of another room that acted in it. */
export const guestHandle = (origin: Pick<ActorOrigin, "agent" | "room">): string => `${origin.agent}@${origin.room}`;

export const originName = (origin: ActorOrigin): string => `${origin.label} (from room "${origin.roomName}")`;

/** The origin of an agent seated in `state`, as another room records it. */
export const originOf = (state: Pick<RoomState, "id" | "name" | "agents">, agentId: string): ActorOrigin | null => {
  const agent = state.agents.find((entry) => entry.id === agentId);
  return agent ? { room: state.id, roomName: state.name, agent: agent.id, label: agent.label, kind: agent.kind } : null;
};

/** Who `origin` is in the room `target`: one of its own agents when it is that room's, else a guest. */
export const actorIn = (target: Pick<RoomState, "id">, origin: ActorOrigin): Actor =>
  origin.room === target.id ? { by: origin.agent } : { by: guestHandle(origin), from: origin };

/** `by` (and `from`, for a guest) as an event carries them. */
export const actorFields = (actor: Actor): { by: string; from?: ActorOrigin } => ({ by: actor.by, ...(actor.from ? { from: actor.from } : {}) });

/** How the room names someone in the lines it writes: an agent's label, a guest with its room, the human by name. */
export const actorLabel = (state: Pick<RoomState, "agents" | "guests"> & { former?: RoomState["former"] }, handle: string): string => {
  const agent = state.agents.find((entry) => entry.id === handle) ?? state.former?.find((entry) => entry.id === handle);
  if (agent) return agent.label;
  const guest = state.guests?.[handle];
  return guest ? originName(guest) : handle;
};

const onOff = (value: boolean) => (value ? "on" : "off");

/** A settings patch in words: "budget 5 turns per run", "network off"… (the UI translates each). */
export const describeSettings = (patch: Partial<RoomSettings>): string[] => {
  const parts: string[] = [];
  if (patch.budget !== undefined) parts.push(patch.budget === null ? "no turn budget" : `budget ${patch.budget} turns per run`);
  if (patch.access !== undefined) parts.push(`access ${patch.access}`);
  if (patch.network !== undefined) parts.push(`network ${onOff(patch.network)}`);
  if (patch.autoCommit !== undefined) parts.push(`autocommit ${onOff(patch.autoCommit)}`);
  if (patch.turnTimeoutMs !== undefined) parts.push(`turn limit ${Math.round(patch.turnTimeoutMs / 60_000)} min`);
  if (patch.doc !== undefined) parts.push(patch.doc ? `canonical file ${patch.doc}` : "no canonical file");
  return parts;
};
