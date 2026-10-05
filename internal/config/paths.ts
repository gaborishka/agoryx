import { existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const APP_NAME = "agoryx";

const resolveHomeDir = (env: NodeJS.ProcessEnv): string => {
  const fromEnv = env.HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return homedir();
};

const resolveXdgBase = (
  env: NodeJS.ProcessEnv,
  key: "XDG_CONFIG_HOME" | "XDG_STATE_HOME",
  fallbackSuffix: string,
): string => {
  const fromEnv = env[key]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveHomeDir(env), fallbackSuffix);
};

export const resolveXdgConfigHome = (env: NodeJS.ProcessEnv = process.env): string =>
  resolveXdgBase(env, "XDG_CONFIG_HOME", ".config");

export const resolveXdgStateHome = (env: NodeJS.ProcessEnv = process.env): string =>
  resolveXdgBase(env, "XDG_STATE_HOME", ".local/state");

export const resolveDefaultConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(resolveXdgConfigHome(env), APP_NAME, "config.json");

export const resolveLegacyConfigPath = (cwd: string = process.cwd()): string =>
  resolve(cwd, "agoryx.json");

export const resolveConfigPathForLoad = (
  configPath?: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (configPath) {
    return resolve(configPath);
  }

  const legacy = resolveLegacyConfigPath(cwd);
  if (existsSync(legacy)) {
    return legacy;
  }

  return resolveDefaultConfigPath(env);
};

export const resolveDefaultStateRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  join(resolveXdgStateHome(env), APP_NAME);

export const resolveDefaultDbPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(resolveDefaultStateRoot(env), "agoryx.db");

const normalizeWorkspaceSlug = (cwd: string): string => {
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return base || "workspace";
};

const workspaceHash = (cwd: string): string =>
  createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 10);

export const resolveWorkspaceStateRoot = (
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const workspace = resolve(cwd);
  return join(
    resolveDefaultStateRoot(env),
    "workspaces",
    `${normalizeWorkspaceSlug(workspace)}-${workspaceHash(workspace)}`,
  );
};

export const resolveDefaultWorktreeDir = (
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string => join(resolveWorkspaceStateRoot(cwd, env), "worktrees");

export const ensureParentDirectory = (targetPath: string): void => {
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true });
};
