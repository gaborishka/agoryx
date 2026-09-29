import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkpointCommit, prepareWorkspace, snapshotTree } from "../../internal/agora/workspace.js";

const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

test("checkpoint includes only credited files and preserves foreign partial staging", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-checkpoint-"));
  try {
    prepareWorkspace(root, { initGit: true });
    for (const path of ["ours", "foreign", "shared", "deleted"]) writeFileSync(join(root, path), "base\n");
    git(root, "add", ".");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    for (const path of ["foreign", "shared"]) writeFileSync(join(root, path), "staged\n");
    git(root, "add", "foreign", "shared");
    for (const path of ["foreign", "shared"]) writeFileSync(join(root, path), "unstaged\n");
    writeFileSync(join(root, "ours"), "ours\n");
    writeFileSync(join(root, "uncredited"), "other room\n");
    writeFileSync(join(root, "new [file]"), "ours new\n");
    rmSync(join(root, "deleted"));
    const staged = git(root, "diff", "--cached");
    const result = checkpointCommit(root, "room A", "", ["ours", "new [file]", "deleted", "shared"]);
    assert.equal(result?.files, 3);
    assert.deepEqual(git(root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim().split("\n"), ["deleted", "new [file]", "ours"]);
    assert.equal(git(root, "diff", "--cached"), staged);
    assert.equal(readFileSync(join(root, "foreign"), "utf8"), "unstaged\n");
    assert.equal(checkpointCommit(root, "empty", "", []), null);
    assert.equal(checkpointCommit(root, "staged", "", ["shared"]), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("checkpoint supports an unborn repository and literal paths inside a subdirectory", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-checkpoint-"));
  try {
    prepareWorkspace(root, { initGit: true });
    const sub = join(root, "sub");
    mkdirSync(sub);
    writeFileSync(join(root, "outside"), "outside\n");
    git(root, "add", "outside");
    writeFileSync(join(sub, "[a].txt"), "inside\n");
    writeFileSync(join(sub, "a.txt"), "uncredited\n");
    assert.equal(checkpointCommit(sub, "first", "", ["[a].txt"])?.files, 1);
    assert.equal(git(root, "ls-tree", "-r", "--name-only", "HEAD").trim(), "sub/[a].txt");
    assert.equal(git(root, "diff", "--cached", "--name-only").trim(), "outside");
    writeFileSync(join(root, ".git", "index.lock"), "busy");
    assert.equal(checkpointCommit(sub, "busy", "", ["a.txt"]), null);
    assert.equal(readFileSync(join(root, ".git", "index.lock"), "utf8"), "busy");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("checkpoint skips credited files changed since the turn snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "agora-checkpoint-"));
  try {
    prepareWorkspace(root, { initGit: true });
    writeFileSync(join(root, "shared"), "room A\n");
    writeFileSync(join(root, "ours"), "room A stable\n");
    const after = snapshotTree(root)!;
    writeFileSync(join(root, "shared"), "room B unfinished\n");
    const result = checkpointCommit(root, "A", "", ["shared", "ours"], new Map([["shared", after], ["ours", after]]));
    assert.equal(result?.files, 1);
    assert.equal(git(root, "ls-tree", "--name-only", "HEAD").trim(), "ours");
    assert.equal(readFileSync(join(root, "shared"), "utf8"), "room B unfinished\n");
    assert.equal(git(root, "diff", "--cached"), "");
    // The same protection applies after the repository has a HEAD, too.
    writeFileSync(join(root, "ours"), "room A next\n");
    const next = snapshotTree(root)!;
    writeFileSync(join(root, "ours"), "room B newer\n");
    assert.equal(checkpointCommit(root, "A next", "", ["ours"], new Map([["ours", next]])), null);
    assert.equal(git(root, "show", "HEAD:ours"), "room A stable\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
