import { execFile } from "node:child_process";
import type { Socket } from "node:net";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface AgentProcessOwner {
  room: string;
  agent: string;
}

/**
 * The processes Agoryx starts for agents (their CLIs; each leads its own process group), so the
 * daemon can tell a request from an agent's process — the CLI, or any shell, tool or background job
 * under it — from the human's own. Agents run as they would in the human's terminal and can read the
 * human's token; what protects Agoryx is that the daemon refuses that token from an agent's process:
 * an agent signs with its own key, never as the human.
 *
 * A group is remembered after its leader exits, while anything in it still runs (a server an agent
 * started keeps the group's id, which no new process can take meanwhile).
 */
const groups = new Map<number, AgentProcessOwner>();

export const trackAgentProcess = (pid: number | undefined, env: NodeJS.ProcessEnv): void => {
  const room = env.AGORYX_ROOM;
  const agent = env.AGORYX_AGENT;
  if (pid === undefined || !room || !agent) return;
  groups.set(pid, { room, agent });
};

export const trackedAgentGroups = (): number => groups.size;

interface Proc {
  ppid: number;
  pgid: number;
}

const processTable = async (): Promise<Map<number, Proc>> => {
  const { stdout } = await run("ps", ["-Ao", "pid=,ppid=,pgid="], { maxBuffer: 16 * 1024 * 1024 });
  const table = new Map<number, Proc>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (pid && Number.isFinite(ppid) && Number.isFinite(pgid)) table.set(pid, { ppid: ppid!, pgid: pgid! });
  }
  return table;
};

/** The processes holding the other end of a loopback connection to this daemon. */
const peerPids = async (socket: Socket): Promise<number[]> => {
  const port = socket.remotePort;
  if (!port) return [];
  const { stdout } = await run("lsof", ["-nP", `-iTCP@127.0.0.1:${port}`, "-Fp"]);
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("p"))
    .map((line) => Number(line.slice(1)))
    .filter((pid) => pid > 0 && pid !== process.pid);
};

/** Which agent's process a pid belongs to, walking up through its parents. */
export const ownerOf = (pid: number, table: Map<number, Proc>): AgentProcessOwner | null => {
  const seen = new Set<number>();
  for (let current: number | undefined = pid; current && current > 1 && !seen.has(current); current = table.get(current)?.ppid) {
    seen.add(current);
    const owner = groups.get(current) ?? groups.get(table.get(current)?.pgid ?? -1);
    if (owner) return owner;
  }
  return null;
};

const byConnection = new WeakMap<Socket, Promise<AgentProcessOwner | null>>();

/**
 * The agent whose process sent this request, or null (the human's terminal or browser, the daemon
 * itself, or no agent process alive). When the lookup itself fails (no lsof), null: the human keeps
 * working, and the attribution rests on the agent's own key as before.
 */
export const agentBehind = (socket: Socket): Promise<AgentProcessOwner | null> => {
  if (groups.size === 0) return Promise.resolve(null);
  const known = byConnection.get(socket);
  if (known) return known;
  const lookup = (async () => {
    try {
      const pids = await peerPids(socket);
      if (pids.length === 0) return null;
      const table = await processTable();
      const live = new Set<number>();
      for (const [pid, proc] of table) live.add(pid).add(proc.pgid);
      for (const pgid of groups.keys()) if (!live.has(pgid)) groups.delete(pgid);
      for (const pid of pids) {
        const owner = ownerOf(pid, table);
        if (owner) return owner;
      }
      return null;
    } catch {
      return null;
    }
  })();
  byConnection.set(socket, lookup);
  return lookup;
};
