import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What an agent's tools need to know about the turn it is in.
 *
 * A process started for one turn gets it in its environment (AGORYX_TURN, AGORYX_SEEN, the agent's key).
 * A live process (one CLI kept up across the agent's turns) cannot: its environment was fixed when it
 * started. It gets one variable, AGORYX_TURN_FILE, naming a small file the engine rewrites at the start of
 * every turn and removes at its end; the agent's tools read it each time they run. Outside a turn there is
 * no file, so no turn, no key, and the tools refuse rather than act under a stale turn or as someone else.
 *
 * bin/agoryx-agent.mjs (zero dependencies, runs in the agents' sandboxes) reads the same file with the same
 * rules; keep the two in step.
 */
export const TURN_FILE_ENV = "AGORYX_TURN_FILE";
const KEY_ENV = "AGORYX_AGENT_KEY";

export interface TurnContext {
  room: string;
  agent: string;
  turn: string;
  /** The last message the turn's delta covered (`m<n>`): `agoryx read new` prints what came after. */
  seen: string;
  /** The agent's key to the daemon, when the room issues one. */
  key?: string;
}

/** Where the engine keeps `agent`'s turn context, inside the room's own directory (not the workspace). */
export const turnContextPath = (roomDir: string, agent: string): string => join(roomDir, "live", `${agent}.json`);

export const writeTurnContext = (path: string, context: TurnContext): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Renamed into place: a tool reading it mid-write sees the whole old one or the whole new one.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(context), { mode: 0o600 });
  renameSync(tmp, path);
};

export const clearTurnContext = (path: string): void => {
  rmSync(path, { force: true });
};

export const readTurnContext = (path: string): TurnContext | null => {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<TurnContext>;
    if (typeof value.room !== "string" || typeof value.agent !== "string" || typeof value.turn !== "string" || typeof value.seen !== "string") return null;
    return { room: value.room, agent: value.agent, turn: value.turn, seen: value.seen, ...(typeof value.key === "string" && value.key ? { key: value.key } : {}) };
  } catch {
    return null;
  }
};

/**
 * In a process started under a live agent: replace the turn variables with the current turn's, or remove
 * them when there is none (or the file is another agent's or room's). Changes `env` in place.
 */
export const applyTurnContext = (env: NodeJS.ProcessEnv = process.env): void => {
  const file = env[TURN_FILE_ENV];
  if (!file) return;
  const context = readTurnContext(file);
  const valid = context && context.agent === env.AGORYX_AGENT && context.room === env.AGORYX_ROOM;
  if (valid) {
    env.AGORYX_TURN = context.turn;
    env.AGORYX_SEEN = context.seen;
    if (context.key) env[KEY_ENV] = context.key;
    else delete env[KEY_ENV];
    return;
  }
  delete env.AGORYX_TURN;
  delete env.AGORYX_SEEN;
  delete env[KEY_ENV];
};
