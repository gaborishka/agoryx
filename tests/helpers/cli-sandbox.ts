// A home and a git repository of a test's own for the CLI it starts. The CLI keeps its workspace state
// (memory, agent worktrees) under the state root of $HOME, keyed by the folder it runs in, and creates
// agent branches in the repository of that folder; run from this checkout with the real $HOME, it wrote
// both into the person's own state and this repository.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_ENTRY = join(REPO_ROOT, "cmd", "agoryx", "main.ts");
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;

/** Node arguments that run the CLI from source with `args`, wherever the child's cwd is. */
export const cliArgv = (args: string[]): string[] => ["--import", TSX_LOADER, CLI_ENTRY, ...args];

export interface CliSandbox {
  /** A temporary $HOME: the CLI's state root resolves under it. */
  home: string;
  /** A temporary git repository with one commit, to run the CLI in. */
  repo: string;
  /** The environment for the CLI: this one, with $HOME and every state-root override pointing at `home`. */
  env: NodeJS.ProcessEnv;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Agoryx Test",
  GIT_AUTHOR_EMAIL: "test@agoryx.invalid",
  GIT_COMMITTER_NAME: "Agoryx Test",
  GIT_COMMITTER_EMAIL: "test@agoryx.invalid",
};

/** A sandbox removed when the test file finishes; `extraEnv` is laid over its environment. */
export const makeCliSandbox = (extraEnv: NodeJS.ProcessEnv = {}): CliSandbox => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agoryx-cli-sandbox-")));
  const home = join(base, "home");
  const repo = join(base, "repo");
  mkdirSync(home);
  mkdirSync(repo);

  const env: NodeJS.ProcessEnv = { ...process.env, ...IDENTITY, HOME: home };
  // Whatever points elsewhere goes: the state root's overrides, a room's variables (tests run inside an
  // agent's turn would act in that room), the CLIs' homes, and a git hook's repository.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("AGORYX_") ||
      key.startsWith("XDG_") ||
      ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"].includes(key)
    ) {
      delete env[key];
    }
  }
  Object.assign(env, extraEnv);

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# sandbox\n", "utf8");
  git("add", "README.md");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  return { home, repo, env };
};
