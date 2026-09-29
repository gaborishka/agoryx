import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentKey, loadOrCreateToken } from "./actor.js";
import { baselineRevision, docWritable, normalizeDocPath } from "./doc.js";
import { createRoomWorktree, removeRoomWorktree } from "./folders.js";
import { RoomEngine } from "./engine.js";
import { defaultWorkspaceRoot, roomsDir, shimDir } from "./paths.js";
import { profilePath } from "./profile.js";
import { createClaudeRunner } from "./runners/claude.js";
import { createCodexRunner } from "./runners/codex.js";
import type { AgentRunner } from "./runners/types.js";
import { defaultRoster, parseAgents } from "./roster.js";
import { newRoomId, RoomStore, slugify } from "./store.js";
import { DEFAULT_SETTINGS, type ActorOrigin, type AgentKind, type RoomAgent, type RoomSettings, type RoomWorktree } from "./types.js";
import { ensureAgentShim, prepareWorkspace } from "./workspace.js";
import { jevReadMessage, jevSecondLook, jevThreshold } from "./jev.js";

export { DEFAULT_AGENTS } from "./roster.js";

export const DEFAULT_DOC = "README.md";

/** "Ivan_Habor" / git "Ivan Habor" → "Ivan". */
export const defaultHumanName = (env: NodeJS.ProcessEnv = process.env): string => {
  const fromEnv = env.AGORYX_HUMAN?.trim();
  if (fromEnv) return fromEnv;
  let raw = "";
  try {
    raw = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
  } catch {
    // no git identity
  }
  if (!raw) raw = env.USER ?? env.USERNAME ?? "human";
  const first = raw.split(/[\s_.-]+/).find(Boolean) ?? "human";
  const clean = first.replace(/[^\p{L}\p{N}]/gu, "");
  return clean ? clean[0]!.toUpperCase() + clean.slice(1) : "Human";
};

export interface CreateRoomOptions {
  name: string;
  dir?: string;
  /** Work in a new git worktree of `dir` (its own branch), shared by every agent in the room. */
  worktree?: boolean;
  /** Branch or commit the worktree starts from. Default: the branch checked out in `dir`. */
  base?: string;
  human?: string;
  /** Who sits in the room (see roster.ts). Default: <AGORYX_HOME>/agents.json if it exists, else Claude and Codex. */
  agents?: unknown;
  /** Agent turns per run; null (the default) for no limit. */
  budget?: number | null;
  network?: boolean;
  autoCommit?: boolean;
  access?: RoomSettings["access"];
  /** The canonical file (relative to the workspace). Default: README.md in a workspace Agoryx creates; none in a directory you bring. */
  doc?: string | null;
  models?: Partial<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
  /** An agent opened the room from another room's turn (the room's human is still the human). */
  createdBy?: ActorOrigin;
}

/**
 * A room name from its first message, for rooms started without one: the first
 * line, without markdown or @mentions, cut at a word boundary.
 */
export const roomNameFrom = (text: string): string => {
  const line =
    text
      .split("\n")
      .map((entry) => entry.replace(/[#>*_`~[\]]/g, "").replace(/(^|\s)@[\w-]+/g, " ").replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  if (line.length <= 60) return line || "Нова кімната";
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?—–-]+$/, "")}…`;
};

export const createRoom = (options: CreateRoomOptions): RoomStore => {
  const env = options.env ?? process.env;
  const name = options.name.trim();
  if (!name) throw new Error("a room needs a name");
  // All that can be refused is checked before a workspace folder is claimed, so a refused room leaves nothing behind.
  // The roster is checked here, whoever calls: one that came as JSON is not trusted to be well-formed.
  const agents = (options.agents === undefined ? defaultRoster(env) : parseAgents(options.agents)).map((agent) =>
    options.models?.[agent.id] ? { ...agent, model: options.models[agent.id] } : agent,
  );
  // Same bounds as a settings change: a run must be able to spend at least one turn, and not without limit.
  if (options.budget !== undefined && options.budget !== null && !(Number.isInteger(options.budget) && options.budget >= 1 && options.budget <= 100)) {
    throw new Error(`the turn budget must be a whole number from 1 to 100, or none (got ${options.budget})`);
  }
  // Messages are told apart by author: a human named like an agent would be taken for that agent.
  const human = (options.human?.trim() || defaultHumanName(env)).replace(/^@+/, "");
  if (!human || agents.some((agent) => agent.id === human.toLowerCase() || agent.label.toLowerCase() === human.toLowerCase())) {
    throw new Error(`"${human}" cannot be the human's name in this room: it is taken by an agent`);
  }
  let doc: string | null = null;
  if (options.doc) {
    doc = normalizeDocPath(options.doc);
    if (!doc) throw new Error(`the canonical file must be a path inside the workspace: ${options.doc}`);
  }
  const id = newRoomId(name);
  let workspace: string;
  // True only when Agoryx picked the directory. One the human names stays theirs even if it is empty:
  // no git init, no default document, no automatic commits unless asked.
  let createdWorkspace: boolean;
  if (options.worktree && !options.dir) throw new Error("a worktree needs a folder in a git repository");
  if (options.dir) {
    workspace = resolve(options.dir);
    createdWorkspace = false;
  } else {
    const root = defaultWorkspaceRoot(env);
    // Claim the readable name atomically: two rooms started at once with the same name must not share it.
    const bySlug = join(root, slugify(name));
    mkdirSync(root, { recursive: true });
    try {
      mkdirSync(bySlug);
      workspace = bySlug;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      workspace = join(root, id);
    }
    createdWorkspace = true;
  }
  if (options.doc === undefined && createdWorkspace) doc = DEFAULT_DOC;
  const settings: RoomSettings = {
    ...DEFAULT_SETTINGS,
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    ...(options.network !== undefined ? { network: options.network } : {}),
    ...(options.access ? { access: options.access } : {}),
    // Never auto-commit into a directory the human brought unless asked.
    autoCommit: options.autoCommit ?? createdWorkspace,
    doc,
  };
  // Last, after everything that can refuse the room: a refused room leaves no branch behind.
  let worktree: RoomWorktree | undefined;
  if (options.worktree) {
    const made = createRoomWorktree(workspace, { name, id, ...(options.base ? { base: options.base } : {}), env });
    workspace = made.workspace;
    worktree = made.worktree;
    // The branch is the room's own: checkpoints there touch nothing the human is working on.
    if (options.autoCommit === undefined) settings.autoCommit = true;
  }
  try {
    return finishRoom({ id, name, workspace, createdWorkspace, worktree, human, agents, settings, doc, env, createdBy: options.createdBy });
  } catch (error) {
    if (worktree) removeRoomWorktree(worktree);
    throw error;
  }
};

const finishRoom = ({
  id,
  name,
  workspace,
  createdWorkspace,
  worktree,
  human,
  agents,
  settings,
  doc,
  env,
  createdBy,
}: {
  id: string;
  name: string;
  workspace: string;
  createdWorkspace: boolean;
  worktree: RoomWorktree | undefined;
  human: string;
  agents: RoomAgent[];
  settings: RoomSettings;
  doc: string | null;
  env: NodeJS.ProcessEnv;
  createdBy: ActorOrigin | undefined;
}): RoomStore => {
  prepareWorkspace(workspace, { initGit: createdWorkspace });
  if (doc && !lstatSync(join(workspace, doc), { throwIfNoEntry: false })) {
    // Never through a symlinked folder that leads out of the workspace.
    if (!docWritable(workspace, doc)) throw new Error(`the canonical file must stay inside the workspace: ${doc}`);
    // Only the title: what the file says is up to the room.
    mkdirSync(dirname(join(workspace, doc)), { recursive: true });
    writeFileSync(join(workspace, doc), `# ${name}\n`);
  }
  const store = RoomStore.create(roomsDir(env), {
    id,
    name,
    workspace,
    createdWorkspace,
    ...(worktree ? { worktree } : {}),
    human,
    agents,
    settings,
    ...(createdBy ? { createdBy } : {}),
  });
  const baseline = doc ? baselineRevision(workspace, doc) : null;
  if (baseline) store.append(baseline);
  return store;
};

export const defaultRunners = (env: NodeJS.ProcessEnv = process.env): Record<AgentKind, AgentRunner> => ({
  claude: createClaudeRunner(env.AGORYX_CLAUDE_BIN || "claude"),
  codex: createCodexRunner(env.AGORYX_CODEX_BIN || "codex"),
});

/**
 * Live processes (see EngineOptions.live) are on unless AGORYX_LIVE is 0/off/false/no;
 * AGORYX_LIVE_IDLE_MS sets how long an unused one is kept (default 5 minutes, 0 = close after every turn).
 */
export const liveSetting = (env: NodeJS.ProcessEnv): boolean | { idleMs: number } => {
  if (/^(0|off|false|no)$/i.test(env.AGORYX_LIVE?.trim() ?? "")) return false;
  const idle = Number(env.AGORYX_LIVE_IDLE_MS?.trim());
  return env.AGORYX_LIVE_IDLE_MS?.trim() && Number.isFinite(idle) && idle >= 0 ? { idleMs: idle } : true;
};

export const openEngine = (
  store: RoomStore,
  options: {
    env?: NodeJS.ProcessEnv;
    runners?: Partial<Record<AgentKind, AgentRunner>>;
    log?: (message: string) => void;
    opsPollMs?: number;
    /** Issues each agent's key (see actor.ts). Default: signed with <AGORYX_HOME>/daemon.token, as the daemon does. */
    agentKey?: (agentId: string) => string | undefined;
  } = {},
): RoomEngine => {
  const env = options.env ?? process.env;
  const dir = shimDir(env);
  ensureAgentShim(dir);
  return new RoomEngine({
    store,
    runners: options.runners ?? defaultRunners(env),
    shimDir: dir,
    env,
    profilePath: profilePath(env),
    agentKey: options.agentKey ?? ((agentId) => agentKey(loadOrCreateToken(env), store.id, agentId)),
    live: liveSetting(env),
    secondLook: jevSecondLook(env),
    secondLookThreshold: jevThreshold(env),
    readMessage: jevReadMessage(env),
    ...(options.log ? { log: options.log } : {}),
    ...(options.opsPollMs ? { opsPollMs: options.opsPollMs } : {}),
  });
};

export const resumeCommands = (
  store: RoomStore,
  runners: Partial<Record<AgentKind, AgentRunner>> = defaultRunners(),
): Record<string, string> => {
  const commands: Record<string, string> = {};
  for (const agent of store.state.agents) {
    const session = store.state.sessions[agent.id];
    const runner = runners[agent.kind];
    if (session && runner) commands[agent.id] = runner.resumeCommand(session.sessionId, store.state.workspace, agent.model, agent.effort);
  }
  return commands;
};
