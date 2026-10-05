import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDefaultStateRoot } from "../config/paths.js";

/** Root for agora state (rooms, daemon file, agent shim). AGORYX_HOME overrides. */
export const agoraHome = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env.AGORYX_HOME?.trim();
  return override ? resolve(override) : join(resolveDefaultStateRoot(env), "agora");
};

export const roomsDir = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "rooms");

export const roomDir = (roomId: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(roomsDir(env), roomId);

export const daemonInfoPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(agoraHome(env), "daemon.json");

export const shimDir = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "bin");

/** Where new room workspaces are created when no --dir is given. */
export const defaultWorkspaceRoot = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = env.AGORYX_WORKSPACES?.trim();
  if (explicit) return resolve(explicit);
  const home = env.AGORYX_HOME?.trim();
  if (home) return join(resolve(home), "workspaces");
  return join(env.HOME?.trim() || homedir(), "agoryx");
};

export const DEFAULT_PORT = 7717;
