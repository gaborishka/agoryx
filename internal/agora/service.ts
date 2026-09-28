import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { baselineRevision, docWritable, normalizeDocPath } from "./doc.js";
import { RoomEngine } from "./engine.js";
import { defaultWorkspaceRoot, roomsDir, shimDir } from "./paths.js";
import { createClaudeRunner } from "./runners/claude.js";
import { createCodexRunner } from "./runners/codex.js";
import type { AgentRunner } from "./runners/types.js";
import { newRoomId, RoomStore, slugify } from "./store.js";
import { DEFAULT_SETTINGS, type AgentKind, type RoomAgent, type RoomSettings } from "./types.js";
import { ensureAgentShim, prepareWorkspace } from "./workspace.js";

export const DEFAULT_DOC = "README.md";

export const DEFAULT_AGENTS: RoomAgent[] = [
  { id: "claude", kind: "claude", label: "Claude" },
  { id: "codex", kind: "codex", label: "Codex" },
];

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
  human?: string;
  agents?: RoomAgent[];
  budget?: number;
  network?: boolean;
  autoCommit?: boolean;
  access?: RoomSettings["access"];
  /** The canonical file (relative to the workspace). Default: README.md in a workspace Agoryx creates; none in a directory you bring. */
  doc?: string | null;
  models?: Partial<Record<string, string>>;
  env?: NodeJS.ProcessEnv;
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
  const id = newRoomId(name);
  let workspace: string;
  // True only when Agoryx picked the directory. One the human names stays theirs even if it is empty:
  // no git init, no default document, no automatic commits unless asked.
  let createdWorkspace: boolean;
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
  let doc: string | null = null;
  if (options.doc) {
    doc = normalizeDocPath(options.doc);
    if (!doc) throw new Error(`the canonical file must be a path inside the workspace: ${options.doc}`);
  } else if (options.doc === undefined && createdWorkspace) {
    doc = DEFAULT_DOC;
  }
  const agents = (options.agents ?? DEFAULT_AGENTS).map((agent) =>
    options.models?.[agent.id] ? { ...agent, model: options.models[agent.id] } : agent,
  );
  // Same bounds as a settings change: a run must be able to spend at least one turn, and not without limit.
  if (options.budget !== undefined && !(Number.isInteger(options.budget) && options.budget >= 1 && options.budget <= 100)) {
    throw new Error(`the turn budget must be a whole number from 1 to 100 (got ${options.budget})`);
  }
  // Messages are told apart by author: a human named like an agent would be taken for that agent.
  const human = (options.human?.trim() || defaultHumanName(env)).replace(/^@+/, "");
  if (!human || agents.some((agent) => agent.id.toLowerCase() === human.toLowerCase())) {
    throw new Error(`"${human}" cannot be the human's name in this room: it is taken by an agent`);
  }
  const settings: RoomSettings = {
    ...DEFAULT_SETTINGS,
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
    ...(options.network !== undefined ? { network: options.network } : {}),
    ...(options.access ? { access: options.access } : {}),
    // Never auto-commit into a directory the human brought unless asked.
    autoCommit: options.autoCommit ?? createdWorkspace,
    doc,
  };
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
    human,
    agents,
    settings,
  });
  const baseline = doc ? baselineRevision(workspace, doc) : null;
  if (baseline) store.append(baseline);
  return store;
};

export const defaultRunners = (env: NodeJS.ProcessEnv = process.env): Record<AgentKind, AgentRunner> => ({
  claude: createClaudeRunner(env.AGORYX_CLAUDE_BIN || "claude"),
  codex: createCodexRunner(env.AGORYX_CODEX_BIN || "codex"),
});

export const openEngine = (
  store: RoomStore,
  options: {
    env?: NodeJS.ProcessEnv;
    runners?: Partial<Record<AgentKind, AgentRunner>>;
    log?: (message: string) => void;
    opsPollMs?: number;
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
    if (session && runner) commands[agent.id] = runner.resumeCommand(session.sessionId, store.state.workspace);
  }
  return commands;
};
