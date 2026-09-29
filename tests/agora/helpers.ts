import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RoomEngine } from "../../internal/agora/engine.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { RoomStore } from "../../internal/agora/store.js";
import { DEFAULT_SETTINGS, type RoomAgent, type RoomSettings } from "../../internal/agora/types.js";
import { ensureAgentShim } from "../../internal/agora/workspace.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// An agent running these tests from inside a room inherits that room's variables (and its CLI's shell
// hints), which would point the rooms under test at the real one and sign ops as that agent.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("AGORYX_") || key === "CLAUDECODE" || key.startsWith("CODEX_SANDBOX")) delete process.env[key];
}

export const AGENTS: RoomAgent[] = [
  { id: "claude", kind: "claude", label: "Claude" },
  { id: "codex", kind: "codex", label: "Codex" },
];

export interface FakeLogEntry {
  kind: string;
  turn: number;
  args?: string[];
  prompt?: string;
  cwd?: string;
  sessionId?: string;
  resumed?: boolean;
  env?: Record<string, string | undefined>;
  tableOutputs?: string[];
}

export interface TestRoom {
  home: string;
  store: RoomStore;
  engine: RoomEngine;
  env: NodeJS.ProcessEnv;
  roomsRoot: string;
  shimDir: string;
  fakeClaude: string;
  fakeCodex: string;
  invocations(kind?: string): FakeLogEntry[];
  cleanup(): Promise<void>;
}

export const writeFakeBins = (home: string) => {
  const binDir = join(home, "fakebin");
  mkdirSync(binDir, { recursive: true });
  const make = (kind: string) => {
    const path = join(binDir, `fake-${kind}`);
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, "fake-agent.mjs")}" ${kind} "$@"\n`);
    chmodSync(path, 0o755);
    return path;
  };
  return { fakeClaude: make("claude"), fakeCodex: make("codex") };
};

export const createTestRoom = (options: {
  rules?: unknown[];
  settings?: Partial<RoomSettings>;
  agents?: RoomAgent[];
  name?: string;
  env?: NodeJS.ProcessEnv;
  /** The human's profile file, as the daemon passes <AGORYX_HOME>/profile.md; none when not given. */
  profilePath?: string;
} = {}): TestRoom => {
  const home = mkdtempSync(join(tmpdir(), "agora-test-"));
  const roomsRoot = join(home, "rooms");
  const workspace = join(home, "ws");
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  const rulesPath = join(home, "rules.json");
  writeFileSync(rulesPath, JSON.stringify(options.rules ?? []));
  const logPath = join(home, "fake.log");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_LOG: logPath,
    FAKE_STATE: join(home, "fake-state"),
    FAKE_RULES: rulesPath,
    CLAUDECODE: "1",
    // Native session files (written by the fake CLIs) stay inside the test home.
    CLAUDE_CONFIG_DIR: join(home, "claude-config"),
    CODEX_HOME: join(home, "codex-home"),
    ...options.env,
  };
  const shimDir = join(home, "shim");
  ensureAgentShim(shimDir);
  const store = RoomStore.create(roomsRoot, {
    name: options.name ?? "Test room",
    workspace,
    createdWorkspace: true,
    human: "Ivan",
    agents: options.agents ?? AGENTS,
    settings: { ...DEFAULT_SETTINGS, network: false, ...options.settings },
  });
  const engine = new RoomEngine({
    store,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
    shimDir,
    env,
    ...(options.profilePath ? { profilePath: options.profilePath } : {}),
    opsPollMs: 50,
    nativePollMs: 50,
  });
  return {
    home,
    store,
    engine,
    env,
    roomsRoot,
    shimDir,
    fakeClaude,
    fakeCodex,
    invocations(kind?: string) {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeLogEntry)
        .filter((entry) => entry.prompt !== undefined && (!kind || entry.kind === kind));
    },
    async cleanup() {
      await engine.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
};

export const tableOutputs = (room: TestRoom): FakeLogEntry[] => {
  const logPath = room.env.FAKE_LOG!;
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLogEntry)
    .filter((entry) => entry.tableOutputs);
};

export const withTimeout = <T>(promise: Promise<T>, ms = 20_000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]);
