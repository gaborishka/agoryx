#!/usr/bin/env node
// Runs the test command it is given and fails the run when the tests left anything behind in the
// person's own Agoryx state (the real state root) or in this repository (worktrees, branches).
//
//   node scripts/test-guard.mjs npx tsx --test 'tests/**/*.test.ts'
//
// Only names are compared, not contents: the person's own daemon keeps writing its database while the
// tests run, and that is not the tests' doing.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const stateRoot = () => {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const home = process.env.HOME?.trim() || homedir();
  return join(xdg || join(home, ".local", "state"), "agoryx");
};

const listTree = (root, dir, depth, out) => {
  if (depth < 0 || !existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    out.push(relative(root, path));
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // vanished between readdir and stat
    }
    if (isDir) listTree(root, path, depth - 1, out);
  }
};

const git = (args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

const snapshot = () => {
  const root = stateRoot();
  const state = [];
  // The top of the state root and its agora home: a new workspace, room or folder entry is the tests'.
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    if (/^agoryx\.db(-.*)?$/.test(name)) continue;
    state.push(name);
  }
  listTree(root, join(root, "workspaces"), 2, state);
  listTree(root, join(root, "agora", "rooms"), 0, state);
  listTree(root, join(root, "agora", "worktrees"), 1, state);
  return {
    state: state.map((entry) => `state: ${entry}`),
    worktrees: git(["worktree", "list", "--porcelain"]).filter((line) => line.startsWith("worktree "))
      .map((line) => `worktree: ${line.slice("worktree ".length)}`),
    branches: git(["for-each-ref", "--format=%(refname)", "refs/heads"]).map((ref) => `branch: ${ref}`),
  };
};

const diff = (before, after) => {
  const was = new Set(before);
  const now = new Set(after);
  return [
    ...after.filter((entry) => !was.has(entry)).map((entry) => `+ ${entry}`),
    ...before.filter((entry) => !now.has(entry)).map((entry) => `- ${entry}`),
  ];
};

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/test-guard.mjs <test command...>");
  process.exit(2);
}

const before = snapshot();
const run = spawnSync(command, args, { stdio: "inherit", shell: false });
const after = snapshot();
if (run.error) {
  console.error(`test-guard: could not run ${command}: ${run.error.message}`);
  process.exit(1);
}

// What only the legacy CLI's tests make (workspaces, agent worktrees and their agoryx/<agent>-* branches)
// fails the run. Rooms, room worktrees and other branches may also be the person's own daemon or another
// checkout at work while the tests run, so a change there is shown, not failed on.
const TESTS_ONLY = /^(state: workspaces(\/|$)|branch: refs\/heads\/agoryx\/(claude|codex|wt)-|worktree: .*\/agoryx\/workspaces\/)/;
const changes = [
  ...diff(before.state, after.state),
  ...diff(before.worktrees, after.worktrees),
  ...diff(before.branches, after.branches),
];
const failing = changes.filter((change) => TESTS_ONLY.test(change.slice(2)));
const shown = changes.filter((change) => !TESTS_ONLY.test(change.slice(2)));
const counts = `${after.state.length} state entries, ${after.worktrees.length} worktrees, ${after.branches.length} branches`;
if (shown.length > 0) {
  console.error(`\ntest-guard: changed while the tests ran (the daemon or another checkout may have done it):`);
  for (const change of shown) console.error(`  ${change}`);
}
if (failing.length > 0) {
  console.error(`\ntest-guard: the tests changed ${stateRoot()} or this repository:`);
  for (const change of failing) console.error(`  ${change}`);
  process.exit(run.status === 0 ? 1 : (run.status ?? 1));
}
console.error(`\ntest-guard: ${stateRoot()}, git worktree list and branches unchanged by the tests (before and after: ${counts})`);
process.exit(run.status ?? 1);
