import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checksResult, forcePushed, ghReady, gitPushes, githubRepo, joinedPushes, prCreate, prLinks, prStatus, readRepo } from "../../internal/agora/github.js";
import { applyEvent, initialState } from "../../internal/agora/projection.js";
import { forHumanOnly } from "../../internal/agora/prompts.js";
import { createClaudeRunner } from "../../internal/agora/runners/claude.js";
import { describeCodexItem } from "../../internal/agora/runners/codex.js";
import { createCodexRunner } from "../../internal/agora/runners/codex.js";
import { shellCommands, shellSteps, shellWriteTargets } from "../../internal/agora/shell-writes.js";
import type { SystemNote } from "../../internal/agora/types.js";
import { sysError, sysLine, sysRisk } from "../../ui/src/lib/system.js";
import { createTestRoom, withTimeout, writeFakeBins } from "./helpers.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HUMAN = { by: "Ivan" };
const FIELDS = "number,url,title,state,isDraft,mergeable,additions,deletions,headRefName,baseRefName,reviewDecision,latestReviews,statusCheckRollup,mergedBy,createdAt,headRepositoryOwner";

type GhState = { prs: Array<Record<string, any>>; calls: string[][]; loggedOut?: boolean; authUnsure?: boolean; defaultBranch?: string; noRepoView?: boolean; failCreate?: string; createRepo?: string };

/** A `gh` that answers from a JSON file, first in PATH. */
const fakeGh = (home: string, prs: unknown[] = [], extra: Partial<GhState> = {}) => {
  const bin = join(home, "ghbin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, "fake-gh.mjs")}" "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const file = join(home, "gh.json");
  writeFileSync(file, JSON.stringify({ repo: "acme/widgets", prs, calls: [], ...extra }));
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, FAKE_GH: file },
    read: () => JSON.parse(readFileSync(file, "utf8")) as GhState,
    edit(change: (state: GhState) => void) {
      const state = this.read();
      change(state);
      writeFileSync(file, JSON.stringify(state));
    },
    /** What gh was asked, as command lines, leaving out its login checks. */
    asked(): string[] {
      return this.read()
        .calls.map((call) => call.join(" "))
        .filter((call) => !call.startsWith("auth status"));
    },
  };
};

/**
 * The room's folder on a branch of a github.com repository whose pushes go to a local bare one, which has the
 * folder's first commit as main.
 */
const onGithub = (workspace: string, home: string, branch = "feat") => {
  const bare = join(home, `remote-${Math.random().toString(36).slice(2, 8)}.git`);
  git(home, "init", "--bare", "--quiet", bare);
  git(workspace, "config", "user.name", "Ivan Test");
  git(workspace, "config", "user.email", "ivan@test");
  git(workspace, "checkout", "--quiet", "-B", "main");
  writeFileSync(join(workspace, "README.md"), "# Widgets\n");
  git(workspace, "add", "README.md");
  git(workspace, "commit", "--quiet", "-m", "Start");
  git(workspace, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  // Only pushes: `git remote get-url` would show where an insteadOf leads.
  git(workspace, "config", `url.${bare}.pushInsteadOf`, "https://github.com/acme/widgets.git");
  git(workspace, "push", "--quiet", "origin", "main");
  git(workspace, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(workspace, "checkout", "--quiet", "-B", branch);
  writeFileSync(join(workspace, "widget.ts"), "export const widget = 1;\n");
  git(workspace, "add", "widget.ts");
  git(workspace, "commit", "--quiet", "-m", "Add widgets");
  return bare;
};

const lines = (messages: Array<{ author: string; sys?: SystemNote; text: string }>, prefix: string) =>
  messages.filter((message) => message.author === "agoryx" && message.sys?.code.startsWith(prefix)).map((message) => [message.text, message.sys]);

test("what the room reads of GitHub: remotes, pull request links, gh pr create, pushes, checks, reviews", () => {
  assert.equal(githubRepo("https://github.com/acme/widgets.git"), "acme/widgets");
  assert.equal(githubRepo("git@github.com:acme/widgets.git"), "acme/widgets");
  assert.equal(githubRepo("ssh://git@github.com/acme/wid.gets"), "acme/wid.gets");
  assert.equal(githubRepo("https://x-access-token:abc@github.com/acme/widgets"), "acme/widgets");
  assert.equal(githubRepo("https://gitlab.com/acme/widgets.git"), null);
  assert.equal(githubRepo("/tmp/remote.git"), null);

  assert.deepEqual(prLinks("See https://github.com/acme/widgets/pull/12 and https://github.com/Acme/Widgets/pull/12#discussion, https://github.com/other/repo/pull/3, https://github.com/acme/widgets/issues/4", "acme/widgets"), [
    { number: 12, url: "https://github.com/Acme/Widgets/pull/12" },
  ]);

  // The commands as the shell runs them: what is only said, asked about or tried out opens nothing.
  assert.deepEqual(shellCommands("cd /x && GH_DEBUG=1 sudo gh pr create --fill 2>/dev/null | tee log; echo 'gh pr create'"), [
    ["cd", "/x"],
    ["gh", "pr", "create", "--fill"],
    ["tee", "log"],
    ["echo", "gh pr create"],
  ]);
  assert.deepEqual(prCreate("gh pr create --fill"), {});
  assert.deepEqual(prCreate("git push -u origin feat && gh pr create --title 'x' --body-file /tmp/b"), {});
  assert.deepEqual(prCreate("/opt/homebrew/bin/gh pr create --head acme:feat --fill"), { head: "feat", owner: "acme" });
  assert.deepEqual(prCreate("gh pr create --repo=github.com/Acme/Widgets --fill"), { repo: "acme/widgets" });
  assert.deepEqual(prCreate("gh pr create -R upstream/widgets --fill"), { repo: "upstream/widgets" }, "another repository's: the room tells");
  assert.deepEqual(prCreate("gh pr create -Hfeat -Racme/widgets --fill"), { repo: "acme/widgets", head: "feat" });
  assert.deepEqual(prCreate('gh pr create --title "--web" --body -w --fill'), {}, "a title or body that reads like an option is a value");
  assert.deepEqual(prCreate(`bash -c "cd sub && gh pr create --fill --head feat"`), { head: "feat" });
  assert.deepEqual(prCreate("nohup gh pr create --fill > log &"), {});
  assert.deepEqual(prCreate("time -p gh pr create --fill"), {});
  assert.deepEqual(prCreate(`bash -euo pipefail -c "gh pr create --fill"`), {});
  assert.deepEqual(prCreate(`bash --rcfile ~/.rc -c "gh pr create --fill"`), {}, "--rcfile's file is no script");
  assert.equal(prCreate("bash ./open.sh -c 'gh pr create --fill'"), null, "after a script's name the words are the script's");
  assert.equal(prCreate("gh pr view 12"), null);
  assert.equal(prCreate("echo 'run gh pr create'"), null);
  assert.equal(prCreate("echo gh pr create --fill"), null);
  assert.equal(prCreate("gh pr create --help"), null);
  assert.equal(prCreate("gh pr create --dry-run --fill"), null);
  assert.equal(prCreate("gh pr create --web"), null);
  assert.equal(prCreate("bash -c 'echo gh pr create'"), null);
  assert.equal(prCreate("git commit -m 'then gh pr create'"), null);

  const push = (command: string) => gitPushes(command).map(({ command: _command, trailed: _trailed, ...rest }) => rest);
  assert.deepEqual(push("git push --force origin feat"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false }]);
  assert.deepEqual(push("git --no-pager push -f"), [{ refspecs: [], force: true, all: false }]);
  assert.deepEqual(push("cd repo && git -C sub -c core.x=1 push -uf origin feat"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false, chained: true }]);
  assert.deepEqual(push("git push -o ci.skip --follow-tags origin +main:main"), [{ remote: "origin", refspecs: ["+main:main"], force: true, all: false }]);
  assert.deepEqual(push("git push origin feat && git push --force-with-lease=feat:abc upstream feat"), [
    { remote: "origin", refspecs: ["feat"], force: false, all: false },
    { remote: "upstream", refspecs: ["feat"], force: true, all: false, chained: true, after: "&&" },
  ]);
  assert.deepEqual(push("git push --mirror backup"), [{ remote: "backup", refspecs: [], force: true, all: true }]);
  assert.deepEqual(push("git push -ofoo origin feat"), [{ remote: "origin", refspecs: ["feat"], force: false, all: false }], "-o's value is no -f");
  assert.deepEqual(push("git push --recurse-submodules on-demand -q origin feat"), [{ remote: "origin", refspecs: ["feat"], force: false, all: false, quiet: true }]);
  assert.deepEqual(push("git push --dry-run -f origin feat"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false, dry: true }], "a dry run pushes nothing");
  for (const command of ["git push origin feat || git push -f origin feat", "git push origin feat || (git push -f origin feat)"]) {
    assert.deepEqual(push(command), [
      { remote: "origin", refspecs: ["feat"], force: false, all: false },
      { remote: "origin", refspecs: ["feat"], force: true, all: false, orElse: true, after: "||" },
    ]);
  }
  assert.deepEqual(push("git push origin feat || echo no && git push -f origin feat")[1], { remote: "origin", refspecs: ["feat"], force: true, all: false, chained: true });
  // `||` at a line's end, a comment after it: the next line's push still runs only when the first failed.
  for (const command of ["git push origin feat ||\n  git push -f origin feat", "git push origin feat || # with force then\n\ngit push -f origin feat"]) {
    assert.deepEqual(push(command)[1], { remote: "origin", refspecs: ["feat"], force: true, all: false, orElse: true, after: "||" }, command);
  }
  // Its stderr sent away: git says nothing of what it pushed, nor of what failed. Not when only stdout went.
  for (const command of [
    "git push -f origin feat 2>/dev/null",
    "git push -f origin feat >/dev/null 2>&1",
    "git push -f origin feat &>/dev/null",
    "git push -f origin feat >& push.log",
    "sh -c 'git push -f origin feat' 2>/dev/null",
    "(git push -f origin feat) 2>/dev/null",
    "((git push -f origin feat) 2>&1) >/dev/null",
    "bash -c 'git push -f origin feat 2>&1' >/dev/null",
  ]) {
    assert.deepEqual(push(command), [{ remote: "origin", refspecs: ["feat"], force: true, all: false, quiet: true, hushed: true }], command);
  }
  for (const command of [
    "git push -f origin feat 2>&1 >/dev/null",
    "git push -f origin feat 2>&1>/dev/null",
    "git push -f origin feat >/dev/null",
    "git push -f origin feat 2>&1 | tee log",
    "git push -f origin feat 1>out.log",
    "git push -f origin feat 3>&1 1>&2 2>&3",
    "bash -c 'git push -f origin feat 2>&1' 2>/dev/null",
    "(git push -f origin feat 2>&1) 2>/dev/null",
    "git push -f origin feat 2>/dev/stdout >/dev/null",
  ]) {
    assert.deepEqual(push(command), [{ remote: "origin", refspecs: ["feat"], force: true, all: false }], command);
  }
  assert.deepEqual(shellSteps("a 2>/dev/null; b\nc || d"), [{ words: ["a"], hushed: true }, { words: ["b"], after: ";" }, { words: ["c"], after: ";" }, { words: ["d"], after: "||" }]);
  // A subshell's redirections are its commands', not the next command's; a redirection with no command is nobody's.
  assert.deepEqual(shellSteps("(cd ui && npm run build) > build.log 2>&1; git push --force-with-lease origin feat"), [
    { words: ["cd", "ui"], hushed: true },
    { words: ["npm", "run", "build"], after: "&&", hushed: true },
    { words: ["git", "push", "--force-with-lease", "origin", "feat"], after: ";" },
  ]);
  assert.deepEqual(shellSteps("2>/dev/null; git push -f"), [{ words: ["git", "push", "-f"], after: ";" }]);
  // The command shown: a new line after a subshell is a new line; a dry run between two pushes is something between.
  assert.equal(joinedPushes(gitPushes("(cd x && git push origin feat)\ngit push -f origin feat")), "git push origin feat; git push -f origin feat");
  assert.equal(joinedPushes(gitPushes("git push -f origin a && git push -n origin b && git push -f origin c")), "git push -f origin a … git push -f origin c");
  assert.equal(joinedPushes(gitPushes("git push origin a || git push -f origin a")), "git push origin a || git push -f origin a");
  // A quoted word that looks like an operator is a word; a dup's descriptor is not the next redirection's.
  assert.deepEqual(shellCommands("grep -n '1|' f"), [["grep", "-n", "1|", "f"]]);
  assert.deepEqual(shellWriteTargets("sed -i 's/a/b/' '2>'"), ["2>"]);
  assert.deepEqual(shellWriteTargets("cmd 2>&1>out.txt"), ["out.txt"]);
  // A secret given to git is not repeated either.
  assert.equal(gitPushes("git -c http.extraHeader='Authorization: Bearer abc123' push -f origin feat")[0]!.command, "git -c http.extraHeader=… push -f origin feat");
  // A URL's user and password (or token) are not repeated in the command the room shows.
  assert.equal(gitPushes("git push -f https://bot:ghp_secret@github.com/me/fork.git feat")[0]!.command, "git push -f https://github.com/me/fork.git feat");
  assert.deepEqual(push("git push -nf origin feat"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false, dry: true }]);
  assert.deepEqual(gitPushes("git commit -m 'git push --force is risky'"), []);
  assert.deepEqual(gitPushes("echo git push -f"), []);
  assert.deepEqual(gitPushes("git fetch origin && git rebase origin/main"), []);

  // What a push rewrote is what git said of it, in the command's own output (as git prints it).
  const repo = { remote: "origin", branch: "feat" };
  const forced = (command: string, output?: string) => forcePushed(gitPushes(command), output, repo);
  assert.deepEqual(forced("git push -f origin feat", "To github.com:acme/widgets.git\n + 158b427...feeb294 feat -> feat (forced update)\n"), { said: ["origin/feat"] });
  assert.deepEqual(
    forced("git push --porcelain --force-with-lease origin feat", "To github.com:acme/widgets.git\n+\trefs/heads/feat:refs/heads/feat\tfeeb294...935b379 (forced update)\nDone\n"),
    { said: ["origin/feat"] },
  );
  assert.deepEqual(forced("git push origin +feat:topic", "To /tmp/remote.git\n + 054006b...0c2df52 feat -> topic (forced update)\n"), { said: ["origin/topic"] });
  // A teammate's force-push the agent's own pull brought in is not the agent's: its push was a fast-forward.
  const pulled = [
    "From github.com:acme/widgets",
    " + f3b34e9...ec4fad9 alice      -> origin/alice  (forced update)",
    "Successfully rebased and updated refs/heads/feat.",
    "To github.com:acme/widgets.git",
    "   088b5c0..158b427  feat -> feat",
  ].join("\n");
  assert.equal(forced("git pull --rebase && git push origin feat", pulled), null);
  assert.equal(forced("git fetch && git push -f origin feat", "From github.com:acme/widgets\n + f3b34e9...ec4fad9 alice -> origin/alice  (forced update)\nTo github.com:acme/widgets.git\n   088b5c0..158b427  feat -> feat\n"), null, "forced, yet a fast-forward");
  assert.equal(forced("git push origin feat", "Everything up-to-date"), null);
  assert.equal(forced("git push -f origin feat", "Everything up-to-date\n"), null, "forced, yet it pushed nothing");
  // Each push's own `To`: the second push's forced update is of the second remote.
  assert.deepEqual(
    forced(
      "git push -f origin feat && git push -f backup feat",
      "To github.com:acme/widgets.git\n + 1111111...2222222 feat -> feat (forced update)\nTo /srv/backup.git\n + 3333333...4444444 feat -> feat (forced update)\n",
    ),
    { said: ["origin/feat", "backup/feat"] },
  );
  // git said nothing of what it pushed: a push that forces still is one, named by what it pushed.
  assert.deepEqual(forced("git push -q -f origin feat", ""), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(forced("git push -f", undefined), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(forced("git push --force upstream HEAD", ""), { said: [], unsaid: ["upstream/feat"] });
  assert.deepEqual(forced("git push --mirror --force backup", ""), { said: [], unsaid: [] });
  assert.equal(forced("git push -q origin feat", ""), null);
  // A quiet forced push after a loud one: git's `To` is the first one's, the second said nothing.
  assert.deepEqual(forced("git push origin main && git push -q -f origin feat", "To github.com:acme/widgets.git\n   088b5c0..158b427  main -> main\n"), { said: [], unsaid: ["origin/feat"] });
  // "Everything up-to-date" is one push's report: the next push's `To` is its own.
  assert.deepEqual(
    forced("git push upstream main && git push -f origin feat", "Everything up-to-date\nTo ../remote.git\n + 1111111...2222222 feat -> feat (forced update)\n"),
    { said: ["origin/feat"] },
  );
  assert.deepEqual(forced("git push -f origin feat 2>/dev/null; git push origin --tags", "Everything up-to-date\n"), { said: [], unsaid: ["origin/feat"] });
  // With -v, git closes a push's `To` of refs up to date with "Everything up-to-date": still that one push.
  const verbose = "Pushing to ../r.git\nTo ../r.git\n = [up to date]      main -> main\nupdating local tracking ref 'refs/remotes/origin/main'\nEverything up-to-date\n";
  assert.deepEqual(
    forced("git push -v upstream main && git push -f origin feat", `${verbose}To ../remote.git\n + 1111111...2222222 feat -> feat (forced update)\n`),
    { said: ["origin/feat"] },
  );
  assert.equal(forced("git push -v -f origin feat", verbose), null, "forced, yet it pushed nothing");
  // A push with force that may not have run, or not gone through, is still one, said to be uncertain: the command failed
  // (`npm test && git push -f`, or a later step: `git push -fq && npm test`), or git printed an error.
  assert.deepEqual(forcePushed(gitPushes("npm test && git push -f origin feat"), "1 failing", repo, true), { said: [], unsaid: ["origin/feat"], failed: "command" });
  assert.deepEqual(forcePushed(gitPushes("git push -q -f origin feat && npm test"), "1 failing\n", repo, true), { said: [], unsaid: ["origin/feat"], failed: "command" });
  // Its report scrolled out of the end of the output the room keeps (a long failing test run after it): it still forced.
  assert.deepEqual(forcePushed(gitPushes("git push --force-with-lease origin feat && npm test"), `${"  at Object.<anonymous> (test.js:1:1)\n".repeat(60)}1 failing\n`, repo, true), {
    said: [],
    unsaid: ["origin/feat"],
    failed: "command",
  });
  assert.deepEqual(forced("git push --force-with-lease origin feat", "fatal: unable to access 'https://github.com/acme/widgets.git/': Could not resolve host: github.com\n"), {
    said: [],
    unsaid: ["origin/feat"],
    failed: "git",
  });
  assert.deepEqual(forced("git push -f origin feat || true", "error: failed to push some refs to 'github.com:acme/widgets.git'\n"), { said: [], unsaid: ["origin/feat"], failed: "git" }, "a pre-push hook refused it");
  // Another git command's error, in a command that went through: the quiet push did run, and may have rewritten.
  assert.deepEqual(forced("git fetch nowhere; git push -q -f origin feat", "fatal: 'nowhere' does not appear to be a git repository\nfatal: Could not read from remote repository.\n"), {
    said: [],
    unsaid: ["origin/feat"],
    failed: "git",
  });
  // What git said it rewrote, it did, failed or not.
  assert.deepEqual(forcePushed(gitPushes("git push -f origin feat && npm test"), "To x\n + 1111111...2222222 feat -> feat (forced update)\n1 failing", repo, true), { said: ["origin/feat"] });
  // --porcelain ends its report with "Done": the next push's "Everything up-to-date" is that push's own.
  assert.equal(forced("git push --porcelain origin main && git push -f upstream feat", "To ../o.git\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone\nEverything up-to-date\n"), null);
  // A dry run prints what it would have done: no forced update of it is one.
  assert.equal(forced("git push -n -f origin feat && git push origin main", "To ../o.git\n + 1111111...2222222 feat -> feat (forced update)\nTo ../o.git\n   3333333..4444444  main -> main\n"), null);
  assert.equal(forced("git push --dry-run --force origin feat", "To ../o.git\n + 1111111...2222222 feat -> feat (forced update)\n"), null);
  // Not git's: npm's "To address all issues, run:" is no push's report.
  assert.deepEqual(forced("npm install && git push -f origin feat >/dev/null 2>&1", "To address all issues, run:\n  npm audit fix\n"), { said: [], unsaid: ["origin/feat"] });
  // Reports and pushes out of line: a report is the push's to the URL git printed (each remote's push URL, as git says).
  const remotes = { ...repo, urls: { origin: "../o.git", upstream: "https://x-access-token:secret@github.com/acme/upstream.git" } };
  const placed = (command: string, output: string, failed = false) => forcePushed(gitPushes(command), output, remotes, failed);
  assert.deepEqual(placed("git push -f upstream feat 2>/dev/null; git push -f origin feat", "To ../o.git\n + 1111111...2222222 feat -> feat (forced update)\n"), {
    said: ["origin/feat"],
    unsaid: ["upstream/feat"],
  });
  // Another push's error before a forced one's report: that one is the forced push's.
  assert.deepEqual(
    placed("git push origin main; git push -f upstream feat", "fatal: unable to access '../o.git/'\nTo https://github.com/acme/upstream.git\n + 1111111...2222222 feat -> feat (forced update)\n"),
    { said: ["upstream/feat"] },
  );
  // A quiet push prints its report when part of it failed: git said what it did, a refused ref rewrote nothing.
  const refused = "To https://github.com/acme/upstream.git\n + 1111111...2222222 feat -> feat (forced update)\n ! [remote rejected] main -> main (hook declined)\nerror: failed to push some refs to 'https://github.com/acme/upstream.git'\n";
  assert.deepEqual(placed("git push -q -f upstream feat main", refused, true), { said: ["upstream/feat"] });
  assert.equal(placed("git push -q -f upstream main", refused.replace(/^ \+ .*\n/m, ""), true), null, "refused whole");
  // A dry run first, a quiet push's failure, then a loud push: each report is its own push's.
  assert.deepEqual(
    placed(
      "git push -n origin main; git push -q -f upstream feat main; git push -f origin feat",
      `To ../o.git\n   3333333..4444444  main -> main\n${refused}To ../o.git\n + 5555555...6666666 feat -> feat (forced update)\n`,
      true,
    ),
    { said: ["upstream/feat", "origin/feat"] },
  );
  // Without the remotes' URLs, a forced update is of the one push that could print it (the other's stderr went away),
  // of the pushes' one remote, or named by the URL git printed.
  assert.deepEqual(forced("git push -f upstream feat 2>/dev/null; git push -f origin feat", "To ../o.git\n + 1111111...2222222 feat -> feat (forced update)\n"), {
    said: ["origin/feat"],
    unsaid: ["upstream/feat"],
  });
  assert.deepEqual(forced("git push -f upstream feat; git push -f origin feat", "To ../o.git\n + 1111111...2222222 feat -> feat (forced update)\n"), {
    said: ["feat at ../o.git"],
    unsaid: ["upstream/feat", "origin/feat"],
  });
  assert.deepEqual(forced("git push -q -f upstream feat main", refused)?.said, ["upstream/feat"]);
  // A push to a URL or a path is to it, not to the room's remote.
  assert.deepEqual(forced("git push -f ../fork.git feat", "To ../fork.git\n + 1111111...2222222 feat -> feat (forced update)\n"), { said: ["feat at ../fork.git"] });
  assert.deepEqual(forced("git push -q -f https://bot:token@github.com/me/fork.git feat", ""), { said: [], unsaid: ["feat at https://github.com/me/fork.git"] });
  // `a || b`: b runs only when a failed. A report of a that went through says b did not run; one that was refused, that it did.
  assert.equal(placed("git push origin feat || git push --force-with-lease origin feat", "To ../o.git\n   37fefec..29b1872  feat -> feat\n"), null);
  assert.deepEqual(
    placed(
      "git push origin feat || git push --force-with-lease origin feat",
      "To ../o.git\n ! [rejected]        feat -> feat (non-fast-forward)\nerror: failed to push some refs to '../o.git'\nTo ../o.git\n + 37fefec...29b1872 feat -> feat (forced update)\n",
    ),
    { said: ["origin/feat"] },
  );
  assert.deepEqual(placed("git push origin feat || git push -q -f origin feat", "To ../o.git\n ! [rejected]        feat -> feat (fetch first)\nerror: failed to push some refs to '../o.git'\n"), {
    said: [],
    unsaid: ["origin/feat"],
    failed: "git",
  });
  // A push that went through, as git says it with no URL ("Everything up-to-date"): the one after `||` never ran.
  assert.equal(placed("git push origin feat || git push -f origin feat", "Everything up-to-date\n"), null);
  assert.equal(placed("git push origin feat || git push -f origin feat || git push -f upstream feat", "Everything up-to-date\n"), null);
  // One that could not reach its remote: the next one ran.
  assert.deepEqual(placed("git push origin feat || git push -q -f origin feat", "fatal: unable to access '../o.git/': not there\n"), { said: [], unsaid: ["origin/feat"], failed: "git" });
  // `a || b || c`: c runs only when b ran and failed — not when b, after a was refused, went through.
  const rejected = "To ../o.git\n ! [rejected]        feat -> feat (non-fast-forward)\nerror: failed to push some refs to '../o.git'\n";
  assert.deepEqual(placed("git push origin feat || git push -f origin feat || git push -f upstream feat", `${rejected}To ../o.git\n + 37fefec...29b1872 feat -> feat (forced update)\n`), {
    said: ["origin/feat"],
  });
  // A refusal git printed with no report the room could read: the push after `||` may have run.
  assert.deepEqual(placed("git push origin feat || git push -q -f origin feat", "error: failed to push some refs to '../o.git'\n"), { said: [], unsaid: ["origin/feat"], failed: "git" });
  // An earlier push's stderr sent away: the report printed is the later push's, not one taken by the hushed one.
  assert.deepEqual(forced("git push -f origin feat 2>/dev/null; git push origin main", "To github.com:acme/widgets.git\n   088b5c0..158b427  main -> main\n"), {
    said: [],
    unsaid: ["origin/feat"],
  });
  // A URL's credentials are not repeated.
  assert.deepEqual(forced("git push -f a feat; git push -f b feat", "To https://x-access-token:secret@github.com/acme/widgets.git\n + 1111111...2222222 feat -> feat (forced update)\n")?.said, [
    "feat at https://github.com/acme/widgets.git",
  ]);
  // Out of line too, a hushed push takes no report: the one printed is the next loud push's to that URL.
  assert.deepEqual(placed("git push -f origin feat 2>/dev/null; git push origin main; git push origin v1 || git push -f origin v1", "To ../o.git\n   088b5c0..158b427  main -> main\nEverything up-to-date\n"), {
    said: [],
    unsaid: ["origin/feat"],
  });
  // A refusal of no push the room can tell (no URLs): any push without a report of its own may have failed.
  const refusedNoUrl = "To ../o.git\n ! [rejected]        feat -> feat (fetch first)\nerror: failed to push some refs to '../o.git'\nTo ../o.git\n   1111111..2222222  v1 -> v1\n";
  assert.deepEqual(forced("git push origin feat || git push -q -f origin feat; git push origin v1 || git push -f origin v1", refusedNoUrl)?.unsaid?.includes("origin/feat"), true);
  // `x && a || b`: the `||` is the whole list's: when x failed, a never ran and b did.
  assert.deepEqual(forced("npm test && git push -q origin feat || git push -q -f origin feat", "npm ERR! Test failed.\n"), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(placed("git push origin main && git push origin feat || git push -q -f origin feat", "To ../o.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '../o.git'\n"), {
    said: [],
    unsaid: ["origin/feat"],
    failed: "git",
  });
  assert.equal(placed("npm test && git push origin feat || git push -q -f origin feat", "To ../o.git\n   1111111..2222222  feat -> feat\n"), null, "a pushed, so x passed");
  assert.equal(placed("(npm run build) >/dev/null 2>&1 && git push origin feat || git push -q -f origin feat", "To ../o.git\n   1111111..2222222  feat -> feat\n"), null);
  // Output cut short (the runner keeps its end): a push with no report there may have failed.
  const tail = "  1 passing\n";
  assert.deepEqual(forcePushed(gitPushes("git push origin feat || git push -q -f origin feat; npm test"), tail, remotes, false, true), { said: [], unsaid: ["origin/feat"] });
  assert.equal(forcePushed(gitPushes("git push origin feat || git push -q -f origin feat; npm test"), tail, remotes, false), null);
  // Nothing printed at all: a quiet push went through.
  assert.equal(forced("git push -q origin feat || git push -q -f origin feat", ""), null);
  // A push's own report says what it did, whatever else printed an error before it.
  assert.equal(placed("npm run lint; git push origin feat || git push -q -f origin feat", "error: 'x' is defined but never used\nTo ../o.git\n   088b5c0..158b427  feat -> feat\n"), null);
  assert.equal(placed("git fetch upstream; git push origin feat || git push -q -f origin feat", "fatal: couldn't find remote ref nope\nTo ../o.git\n   088b5c0..158b427  feat -> feat\n"), null);
  // The runners: a command that printed nothing printed "", and one that printed more than is kept says so.
  assert.equal(describeCodexItem({ type: "command_execution", status: "completed", exit_code: 0, aggregated_output: "", command: "git push -q origin feat" })?.output, "");
  const long = describeCodexItem({ type: "command_execution", status: "completed", exit_code: 0, aggregated_output: `${"x".repeat(2500)}\n`, command: "npm test" });
  assert.deepEqual([long?.output?.length, long?.outputCut], [2000, true]);

  const status = prStatus({
    number: 3,
    url: "https://github.com/acme/widgets/pull/3",
    title: "Quotes",
    state: "OPEN",
    isDraft: true,
    mergeable: "CONFLICTING",
    additions: 40,
    deletions: 2,
    headRefName: "feat",
    baseRefName: "main",
    reviewDecision: "CHANGES_REQUESTED",
    latestReviews: [{ author: { login: "bob" }, state: "COMMENTED" }, { author: { login: "carol" }, state: "CHANGES_REQUESTED" }, { author: { login: "dan" }, state: "APPROVED" }],
    statusCheckRollup: [
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "StatusContext", context: "ci/legacy", state: "PENDING" },
      { __typename: "CheckRun", name: "old", status: "COMPLETED", conclusion: "STALE" },
      { __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "ACTION_REQUIRED" },
    ],
    mergedBy: null,
  });
  assert.deepEqual(status, {
    title: "Quotes",
    state: "draft",
    mergeable: "conflicts",
    additions: 40,
    deletions: 2,
    head: "feat",
    base: "main",
    checks: [
      { name: "test", result: "pass" },
      { name: "lint", result: "fail" },
      { name: "docs", result: "pass" },
      { name: "ci/legacy", result: "pending" },
      { name: "old", result: "pending" },
      { name: "deploy", result: "fail" },
    ],
    review: "changes",
    reviewer: "carol",
  });
  // With no review required GitHub gives no decision: the reviews say it. Changes requested by anyone stand.
  const reviewed = (latestReviews: Array<{ author: { login: string }; state: string }>) =>
    prStatus({ number: 1, url: "", title: "", state: "OPEN", reviewDecision: "", latestReviews });
  assert.deepEqual(
    [
      reviewed([{ author: { login: "dan" }, state: "APPROVED" }, { author: { login: "carol" }, state: "CHANGES_REQUESTED" }, { author: { login: "erin" }, state: "APPROVED" }]),
      reviewed([{ author: { login: "dan" }, state: "APPROVED" }, { author: { login: "bob" }, state: "COMMENTED" }]),
      reviewed([{ author: { login: "bob" }, state: "COMMENTED" }]),
    ].map((entry) => [entry.review, entry.reviewer]),
    [
      ["changes", "carol"],
      ["approved", "dan"],
      [null, undefined],
    ],
  );
  assert.equal(checksResult(status.checks), "pending");
  assert.equal(checksResult(status.checks.slice(0, 3)), "fail");
  assert.equal(checksResult([status.checks[0]!]), "pass");
  assert.equal(checksResult([]), null);
});

test("an agent opens a pull request: the room shows it, keeps asking gh while it is open, and tells the human what changed", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home, [
    // Mentioned in passing, merged long ago from another branch: not the room's.
    { number: 9, title: "Old", state: "MERGED", headRefName: "old", baseRefName: "main", statusCheckRollup: [], latestReviews: [] },
  ]);
  const room = createTestRoom({
    env: gh.env,
    rules: [
      {
        agent: "codex",
        match: "Open the PR",
        run: [["git", "push", "--quiet", "-u", "origin", "feat"], ["gh", "pr", "create", "--fill", "--head", "feat", "--base", "main"]],
        // What gh printed: the pull request it opened.
        command: { command: "git push -u origin feat && gh pr create --fill --base main", output: "{run1}" },
        reply: "Opened https://github.com/acme/widgets/pull/10",
      },
      {
        agent: "claude",
        match: "Rebase it",
        run: [["git", "commit", "--quiet", "--amend", "-m", "Add widgets, reworded"], ["sh", "-c", "git push --force-with-lease origin feat 2>&1"]],
        // What git printed of the push: the branch it rewrote.
        command: { command: "git commit --amend -m 'Add widgets, reworded' && git push --force-with-lease origin feat", output: "{run1}" },
        reply: "Rebased and pushed https://github.com/acme/widgets/pull/10 (like https://github.com/acme/widgets/pull/9, and https://github.com/other/repo/pull/2).",
      },
      { agent: "claude", match: "What now", reply: "Waiting." },
    ],
  });
  try {
    const bare = onGithub(room.store.state.workspace, home);
    await withTimeout(room.engine.syncGithub());
    const { seq: _seq, ...repo } = room.store.state.repo!;
    assert.deepEqual(repo, { repo: "acme/widgets", remote: "origin", branch: "feat", base: "main" });

    room.engine.postHuman("@codex Open the PR");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    const turn = room.store.state.turns.find((entry) => entry.agent === "codex")!;
    const [pr, ...more] = room.store.state.prs ?? [];
    assert.equal(more.length, 0);
    assert.deepEqual([pr!.number, pr!.url, pr!.by, pr!.via, pr!.turnId], [10, "https://github.com/acme/widgets/pull/10", "codex", undefined, turn.id]);
    assert.deepEqual(pr!.status, {
      title: "Add widgets",
      state: "open",
      mergeable: "yes",
      additions: 3,
      deletions: 1,
      head: "feat",
      base: "main",
      checks: [{ name: "test", result: "pending" }],
      review: "required",
    });
    assert.deepEqual(lines(room.store.state.messages, ""), [], "where it started is no news, and a first push rewrites nothing");
    assert.ok(gh.asked().includes(`pr view https://github.com/acme/widgets/pull/10 --json ${FIELDS}`));

    // What gh says of it again is the room's news only when it changes: the room does not move up the list for it.
    const updatedAt = room.store.summary().updatedAt;
    await sleep(20);
    gh.edit((state) => {
      state.prs.find((entry) => entry.number === 10)!.additions = 5;
    });
    await withTimeout(room.engine.syncGithub());
    assert.equal(room.store.state.prs![0]!.status!.additions, 5);
    assert.equal(room.store.summary().updatedAt, updatedAt);

    room.engine.postHuman("@claude Rebase it");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    assert.equal(git(bare, "log", "-1", "--format=%s", "feat"), "Add widgets, reworded");
    assert.deepEqual(lines(room.store.state.messages, "git."), [
      [
        "Claude force-pushed origin/feat: git push --force-with-lease origin feat",
        { code: "git.force_pushed", agent: "Claude", command: "git push --force-with-lease origin feat", refs: ["origin/feat"] },
      ],
    ]);
    assert.deepEqual(
      room.store.state.prs?.map((entry) => entry.number),
      [10],
      "a merged pull request of another branch is only mentioned; another repository's is not asked about",
    );
    assert.ok(gh.asked().some((call) => call.startsWith("pr view https://github.com/acme/widgets/pull/9 ")));
    assert.ok(!gh.asked().some((call) => call.includes("other/repo")));

    gh.edit((state) => {
      const open = state.prs.find((entry) => entry.number === 10)!;
      open.statusCheckRollup = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
      open.reviewDecision = "APPROVED";
      open.latestReviews = [{ author: { login: "alice" }, state: "APPROVED" }];
    });
    await withTimeout(room.engine.syncGithub());
    gh.edit((state) => {
      const open = state.prs.find((entry) => entry.number === 10)!;
      open.state = "MERGED";
      open.mergedBy = { login: "alice" };
    });
    await withTimeout(room.engine.syncGithub());
    const asked = gh.asked().length;
    await withTimeout(room.engine.syncGithub());
    assert.equal(gh.asked().length, asked, "a merged pull request is not asked about again");
    assert.deepEqual(lines(room.store.state.messages, "pr."), [
      ["PR #10: the check passed.", { code: "pr.checks", n: 10, result: "pass", total: 1 }],
      ["PR #10 approved by alice.", { code: "pr.review", n: 10, review: "approved", by: "alice" }],
      ["PR #10 merged into main by alice.", { code: "pr.merged", n: 10, base: "main", by: "alice" }],
    ]);
    assert.equal(room.store.state.prs![0]!.status!.state, "merged");
    // In the UI's words: a force-push stands out as a risk, the rest are quiet.
    const shown = room.store.state.messages.filter((entry) => entry.author === "agoryx").map((entry) => [sysLine(entry), sysRisk(entry), sysError(entry)]);
    assert.deepEqual(shown, [
      ["Claude force-pushed, rewriting the history of `origin/feat`: `git push --force-with-lease origin feat`", true, false],
      ["PR #10: the check passed.", false, false],
      ["PR #10 approved by alice.", false, false],
      ["PR #10 merged into `main` by alice.", false, false],
    ]);

    // The lines are the human's: no agent is told of them.
    for (const message of room.store.state.messages.filter((entry) => entry.author === "agoryx")) assert.ok(forHumanOnly(message), message.text);
    room.engine.postHuman("@claude What now?");
    await withTimeout(room.engine.waitIdle());
    const prompt = room.invocations("claude").at(-1)!.prompt!;
    assert.match(prompt, /What now\?/);
    assert.doesNotMatch(prompt, /force-pushed|checks passed|approved by|merged into/);
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a pull request is the room's only when it is of the room's branch and repository: links in code or quotes, help and dry runs are not", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home, [
    { number: 5, title: "Other branch", state: "OPEN", headRefName: "other", baseRefName: "main", statusCheckRollup: [], latestReviews: [] },
    { number: 6, title: "In code", state: "MERGED", headRefName: "feat", baseRefName: "main", statusCheckRollup: [], latestReviews: [] },
  ]);
  const room = createTestRoom({
    env: gh.env,
    rules: [
      {
        agent: "claude",
        match: "LINK",
        once: true,
        reply: "See https://github.com/acme/widgets/pull/5.\n\nNot this one: `https://github.com/acme/widgets/pull/6`\n\n> https://github.com/acme/widgets/pull/6",
      },
      {
        agent: "claude",
        match: "TRY",
        once: true,
        commands: ["gh pr create --help", "echo gh pr create --fill", "gh pr create --dry-run --fill", "gh pr create --repo upstream/widgets --fill"],
        reply: "Tried.",
      },
      // gh printed nothing the room reads: the open pull request of the branch it named.
      { agent: "codex", match: "OPEN", once: true, run: [["gh", "pr", "create", "--fill", "--head", "feat"]], command: "gh pr create --fill --head feat", reply: "Opened it." },
    ],
  });
  try {
    onGithub(room.store.state.workspace, home);
    await withTimeout(room.engine.syncGithub());
    for (const word of ["@claude LINK", "@claude TRY"]) {
      room.engine.postHuman(word);
      await withTimeout(room.engine.waitIdle());
      await withTimeout(room.engine.syncGithub());
    }
    assert.equal(room.store.state.prs, undefined);
    assert.deepEqual(
      gh.asked().filter((call) => call.startsWith("pr ")),
      // Into the upstream, gh printing nothing: the branch's open one there is looked for (there is none).
      [`pr view https://github.com/acme/widgets/pull/5 --json ${FIELDS}`, `pr view acme:feat --repo upstream/widgets --json ${FIELDS}`],
      "a link in code or a quote is not asked about; a pull request nobody opened is not looked for",
    );

    room.engine.postHuman("@codex OPEN");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    const prs = () => room.store.state.prs ?? [];
    assert.deepEqual(
      prs().map((pr) => [pr.number, pr.by, pr.status?.head]),
      [[7, "codex", "feat"]],
    );
    assert.ok(gh.asked().some((call) => call.startsWith("pr view feat --repo acme/widgets --json")));

    // Closed, then reopened on GitHub: the room hears both (a closed one is asked about while someone looks).
    gh.edit((state) => {
      state.prs.find((entry) => entry.number === 7)!.state = "CLOSED";
    });
    await withTimeout(room.engine.syncGithub());
    gh.edit((state) => {
      state.prs.find((entry) => entry.number === 7)!.state = "OPEN";
    });
    await withTimeout(room.engine.syncGithub());
    assert.deepEqual(lines(room.store.state.messages, "pr."), [
      ["PR #7 closed without merging.", { code: "pr.closed", n: 7 }],
      ["PR #7 reopened.", { code: "pr.reopened", n: 7 }],
    ]);
    for (const message of room.store.state.messages.filter((entry) => entry.author === "agoryx")) assert.ok(forHumanOnly(message), message.text);
    assert.equal(prs()[0]!.status!.state, "open");
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a gh pr create that opened none is not credited: the branch's own (`|| true` hid gh's refusal), one from before the turn, a fork's of the same name", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const pr = (number: number, head: string, owner: string, createdAt: string) => ({ number, title: `#${number}`, state: "OPEN", headRefName: head, baseRefName: "main", headRepositoryOwner: { login: owner }, createdAt, statusCheckRollup: [], latestReviews: [] });
  const gh = fakeGh(home, [
    // The human opened it from the terminal just before the turn (within the clock's slack): only gh's refusal tells.
    pr(20, "feat", "acme", new Date(Date.now() - 30_000).toISOString()),
    // Opened long ago.
    pr(22, "old", "acme", "2026-01-01T00:00:00Z"),
    // A fork's, of a branch with the same name, opened just now.
    pr(21, "topic", "fork", new Date().toISOString()),
  ]);
  const quiet = "gh pr create --fill > /dev/null 2>&1 || true";
  const room = createTestRoom({
    env: gh.env,
    rules: [
      {
        agent: "claude",
        match: "REFUSED",
        once: true,
        run: [["sh", "-c", "gh pr create --fill --head feat 2>&1 || true"]],
        command: { command: "gh pr create --fill --head feat || true", output: "{run0}" },
        reply: "Done.",
      },
      { agent: "claude", match: "QUIET", once: true, run: [["sh", "-c", quiet]], command: quiet, reply: "Done." },
      { agent: "claude", match: "FORK", once: true, run: [["sh", "-c", quiet]], command: quiet, reply: "Done." },
    ],
  });
  try {
    const ws = room.store.state.workspace;
    onGithub(ws, home);
    await withTimeout(room.engine.syncGithub());
    const ask = async (word: string, branch: string) => {
      git(ws, "checkout", "--quiet", "-B", branch);
      room.engine.postHuman(`@claude ${word}`);
      await withTimeout(room.engine.waitIdle());
      await withTimeout(room.engine.syncGithub());
    };
    await ask("REFUSED", "feat");
    assert.ok(gh.asked().includes("pr create --fill --head feat"));
    assert.equal(gh.read().prs.length, 3, "gh refused: it printed the branch's own (#20) and opened none");

    await ask("QUIET", "old");
    assert.ok(gh.asked().some((call) => call.startsWith("pr view old --repo acme/widgets --json")), "looked up by branch: older than the turn");

    gh.edit((state) => {
      state.failCreate = "pull request create failed: GraphQL: No commits between main and topic (createPullRequest)";
    });
    await ask("FORK", "topic");
    assert.ok(gh.asked().some((call) => call.startsWith("pr view topic --repo acme/widgets --json")));
    assert.equal(room.store.state.prs, undefined, "none of them is an agent's");
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a force-push in a command that then failed is still one: `git push -f && npm test`", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home);
  const command = "git push --force origin feat && npm test";
  const room = createTestRoom({
    env: gh.env,
    rules: [{ agent: "codex", match: "PUSH", run: [["sh", "-c", "git push --force origin feat 2>&1"]], command: { command, output: "{run0}\n1 failing", fail: true }, reply: "Tests fail." }],
  });
  const ws = room.store.state.workspace;
  try {
    onGithub(ws, home);
    git(ws, "push", "--quiet", "origin", "feat");
    git(ws, "commit", "--quiet", "--amend", "-m", "Add widgets, reworded");
    await withTimeout(room.engine.syncGithub());
    room.engine.postHuman("@codex PUSH");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    assert.equal(room.store.state.turns.at(-1)!.activity?.at(-1)?.status, "fail");
    assert.deepEqual(lines(room.store.state.messages, "git."), [
      ["Codex force-pushed origin/feat: git push --force origin feat", { code: "git.force_pushed", agent: "Codex", command: "git push --force origin feat", refs: ["origin/feat"] }],
    ]);
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a quiet push with force in a command that then failed is shown as uncertain: `git push -qf && npm test`", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home);
  const command = "git push -q --force origin feat && npm test";
  const room = createTestRoom({
    env: gh.env,
    rules: [{ agent: "codex", match: "PUSH", run: [["sh", "-c", "git push -q --force origin feat 2>&1"]], command: { command, output: "{run0}1 failing", fail: true }, reply: "Tests fail." }],
  });
  const ws = room.store.state.workspace;
  try {
    onGithub(ws, home);
    git(ws, "push", "--quiet", "origin", "feat");
    git(ws, "commit", "--quiet", "--amend", "-m", "Add widgets, reworded");
    await withTimeout(room.engine.syncGithub());
    room.engine.postHuman("@codex PUSH");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    assert.deepEqual(lines(room.store.state.messages, "git."), [
      [
        "Codex pushed with force to origin/feat, or tried to (the command failed; git did not say whether it rewrote history): git push -q --force origin feat",
        { code: "git.force_pushed", agent: "Codex", command: "git push -q --force origin feat", refs: ["origin/feat"], rewrote: false, failed: "command" },
      ],
    ]);
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a push's report is its own by the URL git printed: another remote's push with its output sent away; `git push || git push -f` that went through the first time", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home);
  const two = "git push -f backup feat 2>/dev/null; git push -f origin feat";
  const either = "git push origin feat || git push --force-with-lease origin feat";
  const room = createTestRoom({
    env: gh.env,
    rules: [
      { agent: "codex", match: "TWO", run: [["sh", "-c", `${two} 2>&1`]], command: { command: two, output: "{run0}" }, reply: "Pushed." },
      { agent: "codex", match: "EITHER", run: [["sh", "-c", "git push origin feat 2>&1 || git push --force-with-lease origin feat 2>&1"]], command: { command: either, output: "{run0}" }, reply: "Pushed." },
    ],
  });
  const ws = room.store.state.workspace;
  try {
    const bare = onGithub(ws, home);
    const backup = join(home, "backup.git");
    git(home, "init", "--bare", "--quiet", backup);
    git(ws, "remote", "add", "backup", backup);
    git(ws, "push", "--quiet", "origin", "feat");
    git(ws, "push", "--quiet", "backup", "feat");
    git(ws, "commit", "--quiet", "--amend", "-m", "Add widgets, reworded");
    await withTimeout(room.engine.syncGithub());
    room.engine.postHuman("@codex TWO");
    await withTimeout(room.engine.waitIdle());
    const said = [
      [
        `Codex force-pushed origin/feat: git push -f backup feat; git push -f origin feat`,
        { code: "git.force_pushed", agent: "Codex", command: "git push -f backup feat; git push -f origin feat", refs: ["origin/feat"] },
      ],
      [
        "Codex pushed with force to backup/feat (git did not say whether it rewrote history): git push -f backup feat; git push -f origin feat",
        { code: "git.force_pushed", agent: "Codex", command: "git push -f backup feat; git push -f origin feat", refs: ["backup/feat"], rewrote: false },
      ],
    ];
    assert.deepEqual(lines(room.store.state.messages, "git."), said);
    // A fast-forward the first time: the push with force after `||` never ran.
    git(ws, "commit", "--quiet", "--allow-empty", "-m", "More widgets");
    room.engine.postHuman("@codex EITHER");
    await withTimeout(room.engine.waitIdle());
    assert.equal(git(bare, "rev-parse", "feat"), git(ws, "rev-parse", "HEAD"), "it pushed");
    assert.deepEqual(lines(room.store.state.messages, "git."), said);
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("gh's login: signed in, signed out, not there, or it could not tell (then the room keeps what it knew)", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  try {
    const env = (extra: Partial<GhState>) => ({ ...process.env, ...fakeGh(join(home, Math.random().toString(36).slice(2)), [], extra).env });
    assert.equal(await ghReady(env({})), true);
    assert.equal(await ghReady(env({ loggedOut: true })), false);
    assert.equal(await ghReady(env({ authUnsure: true })), undefined);
    assert.equal(await ghReady({ PATH: join(home, "nothing-here") }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("without a github.com remote, without gh or with gh signed out, the room shows nothing of GitHub; a remote that goes takes it away", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(join(home, "in"));
  const out = fakeGh(join(home, "out"), [], { loggedOut: true });
  const rules = [{ agent: "claude", command: "gh pr create --fill && git push --force", reply: "https://github.com/acme/widgets/pull/10" }];
  const noRemote = createTestRoom({ env: gh.env, rules });
  // gh is not installed: its PATH has no gh, though the folder is on GitHub.
  const noGh = createTestRoom({ env: { PATH: join(home, "nothing-here"), FAKE_GH: gh.env.FAKE_GH }, rules });
  const signedOut = createTestRoom({ env: out.env, rules });
  const leaving = createTestRoom({ env: gh.env, rules: [{ reply: "ok" }] });
  try {
    onGithub(noGh.store.state.workspace, home);
    onGithub(signedOut.store.state.workspace, home);
    for (const room of [noRemote, noGh, signedOut]) {
      room.engine.postHuman("@claude go");
      await withTimeout(room.engine.waitIdle());
      await withTimeout(room.engine.syncGithub());
      assert.equal(room.store.state.repo, undefined);
      assert.equal(room.store.state.prs, undefined);
      assert.deepEqual(lines(room.store.state.messages, ""), []);
      await assert.rejects(room.engine.prPlan(), /no GitHub remote, or gh is not signed in/);
    }
    assert.deepEqual(gh.read().calls, [], "a folder with no GitHub remote never asks gh");
    assert.deepEqual(out.asked(), [], "a gh signed out is asked nothing else");

    onGithub(leaving.store.state.workspace, home);
    await withTimeout(leaving.engine.syncGithub());
    assert.equal(leaving.store.state.repo?.repo, "acme/widgets");
    git(leaving.store.state.workspace, "remote", "remove", "origin");
    await withTimeout(leaving.engine.syncGithub());
    assert.equal(leaving.store.state.repo, undefined);
    assert.ok(leaving.store.events.some((event) => event.type === "repo.gone"));
  } finally {
    for (const room of [noRemote, noGh, signedOut, leaving]) await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the human's Open PR says first what it would push, and pushes only that: the base from gh when git has none, not while a turn runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home, [], { defaultBranch: "trunk" });
  const room = createTestRoom({ env: gh.env, rules: [{ agent: "claude", match: "SLOW", sleepMs: 1500, reply: "Slow." }] });
  const ws = room.store.state.workspace;
  try {
    const bare = onGithub(ws, home);
    // git no longer knows the remote's default branch: gh does.
    git(ws, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    gh.edit((state) => {
      state.noRepoView = true;
    });
    await assert.rejects(room.engine.prPlan(), /neither git nor gh can tell acme\/widgets's default branch/);
    gh.edit((state) => {
      delete state.noRepoView;
    });
    const plan = await room.engine.prPlan();
    const sha = git(ws, "rev-parse", "HEAD");
    // git pushes to the local bare one (a pushInsteadOf): the human is shown where.
    assert.deepEqual(plan, { repo: "acme/widgets", remote: "origin", branch: "feat", base: "trunk", sha, pushUrl: bare });
    assert.ok(gh.asked().includes("repo view acme/widgets --json defaultBranchRef --jq .defaultBranchRef.name"));
    assert.equal(room.store.state.repo?.base, "trunk", "what gh told is the room's base: the header knows main from a branch of its own");
    git(ws, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    assert.deepEqual(await room.engine.prPlan(), { repo: "acme/widgets", remote: "origin", branch: "feat", base: "main", sha, ahead: 1, pushUrl: bare });

    // A room's worktree goes back into the branch it was made from, when the remote has it.
    git(ws, "update-ref", "refs/remotes/origin/dev", git(ws, "rev-parse", "main"));
    assert.equal((await readRepo(ws, "dev"))?.base, "dev");
    assert.equal((await readRepo(ws, "origin/dev"))?.base, "dev");
    assert.equal((await readRepo(ws, git(ws, "rev-parse", "main")))?.base, "main", "made from a commit: the remote's default branch");
    assert.equal((await readRepo(ws, "nowhere"))?.base, "main");

    // The folder moved on since the human looked: nothing is pushed.
    writeFileSync(join(ws, "more.ts"), "export const more = 1;\n");
    git(ws, "add", "more.ts");
    git(ws, "commit", "--quiet", "-m", "More");
    await assert.rejects(room.engine.openPr(HUMAN, { branch: "feat", sha }), new RegExp(`the folder moved on since you looked: it is now feat at ${git(ws, "rev-parse", "--short=7", "HEAD")} — look again`));
    assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/feat"], { cwd: bare }).status, 1, "nothing was pushed");

    // A turn is running: it may still be committing.
    room.engine.postHuman("@claude SLOW");
    await sleep(300);
    const now = (await room.engine.prPlan()).sha;
    await assert.rejects(room.engine.openPr(HUMAN, { branch: "feat", sha: now }), /a turn is running; open the pull request once it has ended/);
    await assert.rejects(room.engine.openPr({ by: "claude" }, { branch: "feat", sha: now }), /only the human opens a pull request/);
    await withTimeout(room.engine.waitIdle());

    // Where git really pushes is part of what the human saw: a plan without the push URL is not this one.
    await assert.rejects(room.engine.openPr(HUMAN, { branch: "feat", sha: now, repo: "acme/widgets", remote: "origin", base: "main" }), /where it goes changed since you looked/);
    // Someone opened one for the branch from their terminal: the room never heard of it, gh has.
    gh.edit((state) => {
      state.prs.push({ number: 30, title: "Theirs", state: "OPEN", headRefName: "feat", baseRefName: "main", headRepositoryOwner: { login: "acme" }, statusCheckRollup: [], latestReviews: [] });
    });
    await assert.rejects(room.engine.openPr(HUMAN, { branch: "feat", sha: now }), /pull request #30 is already open for feat: https:\/\/github\.com\/acme\/widgets\/pull\/30/);
    assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/feat"], { cwd: bare }).status, 1, "nothing was pushed");
    gh.edit((state) => {
      state.prs = state.prs.filter((entry) => entry.number !== 30);
    });

    const pr = await room.engine.openPr(HUMAN, { branch: "feat", sha: now });
    assert.deepEqual([pr.number, pr.by, pr.status?.head, pr.status?.base], [1, "Ivan", "feat", "main"]);
    assert.equal(git(bare, "rev-parse", "refs/heads/feat"), now, "the branch was pushed first, at the commit the human saw");
    assert.ok(gh.asked().includes("pr create --repo acme/widgets --fill --head feat --base main"));
    await assert.rejects(room.engine.prPlan(), /pull request #1 is already open for feat/);

    // A branch with nothing the base lacks: nothing is pushed for a pull request gh would refuse.
    git(ws, "checkout", "--quiet", "-B", "empty", "origin/main");
    await assert.rejects(room.engine.prPlan(), /empty has no commits that origin\/main does not have/);
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("nobody looking and no pull request open: git and gh are not asked again until someone opens the room", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home);
  let viewing = false;
  const room = createTestRoom({ env: gh.env, viewed: () => viewing, githubPollMs: 50 });
  const ws = room.store.state.workspace;
  const branch = () => room.store.state.repo?.branch;
  try {
    onGithub(ws, home);
    await withTimeout(room.engine.syncGithub());
    assert.equal(branch(), "feat");
    git(ws, "checkout", "--quiet", "-B", "next");
    await sleep(400);
    assert.equal(branch(), "feat", "not asked while nobody looks");
    viewing = true;
    const until = Date.now() + 5_000;
    while (branch() !== "next" && Date.now() < until) await sleep(50);
    assert.equal(branch(), "next");
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("over HTTP: the human sees what Open PR would push, then opens it through gh; an agent's key is refused; one per branch", async () => {
  const { request } = await import("node:http");
  const { AgoraDaemon } = await import("../../internal/agora/daemon.js");
  const { agentKey } = await import("../../internal/agora/actor.js");
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const gh = fakeGh(home);
  // Never the real CLIs: the room's agents are fake ones.
  const { fakeClaude, fakeCodex } = writeFakeBins(home);
  writeFileSync(join(home, "rules.json"), JSON.stringify([{ reply: "::pass::" }]));
  const daemon = new AgoraDaemon({
    env: {
      ...process.env,
      ...gh.env,
      AGORYX_HOME: join(home, "agora"),
      AGORYX_USER: "Ivan",
      AGORYX_WORKSPACES: join(home, "ws"),
      AGORYX_JEV: "off",
      FAKE_LOG: join(home, "fake.log"),
      FAKE_STATE: join(home, "fake-state"),
      FAKE_RULES: join(home, "rules.json"),
      CLAUDE_CONFIG_DIR: join(home, "claude-config"),
      CODEX_HOME: join(home, "codex-home"),
    },
    port: 0,
    advertise: false,
    watchDays: 0,
    runners: { claude: createClaudeRunner(fakeClaude), codex: createCodexRunner(fakeCodex) },
  });
  const { port } = await daemon.start();
  const call = (method: string, path: string, body?: unknown, token = daemon.token): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: { host: `127.0.0.1:${port}`, "x-agoryx-token": token, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  try {
    const room = (await call("POST", "/api/rooms", { name: "Widgets", mode: "work" })).json.room as { id: string };
    const workspace = (await call("GET", `/api/rooms/${room.id}`)).json.state.workspace as string;
    const noRemote = await call("GET", `/api/rooms/${room.id}/pr`);
    assert.equal(noRemote.status, 409);
    assert.match(noRemote.json.error, /no GitHub remote/);

    const bare = onGithub(workspace, home);
    const plan = await call("GET", `/api/rooms/${room.id}/pr`);
    assert.equal(plan.status, 200, JSON.stringify(plan.json));
    assert.deepEqual(plan.json, { repo: "acme/widgets", remote: "origin", branch: "feat", base: "main", sha: git(workspace, "rev-parse", "HEAD"), ahead: 1, pushUrl: bare });
    assert.ok(!gh.asked().some((call) => call.startsWith("pr create")), "looking pushes and opens nothing");

    const asAgent = await call("POST", `/api/rooms/${room.id}/pr`, { branch: "feat", sha: plan.json.sha }, agentKey(daemon.token, room.id, "codex"));
    assert.equal(asAgent.status, 403);
    assert.match(asAgent.json.error, /an agent runs gh itself/);
    const unseen = await call("POST", `/api/rooms/${room.id}/pr`, {});
    assert.equal(unseen.status, 409);
    assert.match(unseen.json.error, /the folder moved on since you looked/);

    // Where it goes is part of what the human saw.
    const elsewhere = await call("POST", `/api/rooms/${room.id}/pr`, { ...plan.json, base: "dev" });
    assert.equal(elsewhere.status, 409);
    assert.match(elsewhere.json.error, /where it goes changed since you looked: now origin \(.*\), into main on acme\/widgets — look again/);

    const made = await call("POST", `/api/rooms/${room.id}/pr`, plan.json);
    assert.equal(made.status, 201, JSON.stringify(made.json));
    assert.equal(made.json.pr.number, 1);
    assert.equal(made.json.pr.by, "Ivan");
    assert.equal(git(bare, "rev-parse", "refs/heads/feat"), git(workspace, "rev-parse", "HEAD"), "the branch was pushed first");
    assert.equal(git(workspace, "config", "branch.feat.remote"), "origin");
    assert.ok(gh.asked().includes("pr create --repo acme/widgets --fill --head feat --base main"));
    const state = (await call("GET", `/api/rooms/${room.id}`)).json.state;
    assert.equal(state.repo.branch, "feat");
    assert.equal(state.prs[0].status.state, "open");

    const again = await call("GET", `/api/rooms/${room.id}/pr`);
    assert.equal(again.status, 409);
    assert.match(again.json.error, /#1 is already open for feat/);

    git(workspace, "checkout", "--quiet", "-B", "main");
    const onBase = await call("GET", `/api/rooms/${room.id}/pr`);
    assert.equal(onBase.status, 409);
    assert.match(onBase.json.error, /the base branch/);
  } finally {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a force-push after `||`: a report matched out of line, or in output cut short, does not say the push before it went through", () => {
  const remotes = { remote: "origin", branch: "feat", urls: { origin: "../o.git" } };
  const placed = (command: string, output: string, cut = false) => forcePushed(gitPushes(command), output, remotes, false, cut);
  // The first push failed with no report of its own; the report printed is the tag's, a later push's to the same URL.
  assert.deepEqual(placed("git push || git push -q -f origin HEAD:feat; git push origin v1.0", "fatal: The current branch feat has no upstream branch.\nTo ../o.git\n * [new tag]         v1.0 -> v1.0\n"), {
    said: [],
    unsaid: ["origin/feat"],
    failed: "git",
  });
  assert.deepEqual(placed("git push origin feat || git push -q -f origin feat; npm test; git push origin v1.0", "  12 passing\nTo ../o.git\n * [new tag]         v1.0 -> v1.0\n", true), {
    said: [],
    unsaid: ["origin/feat"],
  });
  // In line, a push's own report still says it went through.
  assert.equal(placed("git push origin feat || git push -q -f origin feat; git push origin v1.0", "To ../o.git\n   1111111..2222222  feat -> feat\nTo ../o.git\n * [new tag]         v1.0 -> v1.0\n", true), null);
  // `a && b || c`: a pushed, so b ran; quiet, it printed nothing: it went through, and c never ran.
  assert.equal(placed("git push origin main && git push -q origin feat || git push -q -f origin feat", "To ../o.git\n   1111111..2222222  main -> main\n"), null);
});

test("the shell around a push: /dev/fd/N is a descriptor, a braced group's redirections and a case's arms, a proxy's password not shown, nested subshells read in linear time", () => {
  const push = (command: string) => gitPushes(command).map(({ command: _command, trailed: _trailed, ...rest }) => rest);
  assert.deepEqual(push("git push -f origin feat 2>/dev/fd/1"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false }]);
  assert.deepEqual(push("git push -f origin feat 2>/dev/fd/1 >/dev/null"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false }]);
  assert.deepEqual(push("git push -f origin feat 1>/dev/fd/2 2>/dev/null"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false, quiet: true, hushed: true }]);
  // A braced group's redirections are its commands', as a subshell's are; a case's arm ends at `;;`.
  assert.deepEqual(push("{ git push origin feat || git push -q -f origin feat; } 2>/dev/null")[1], { remote: "origin", refspecs: ["feat"], force: true, all: false, quiet: true, hushed: true, orElse: true, after: "||" });
  assert.deepEqual(push("case $x in a) git push -f origin feat 2>/dev/null;; b) echo;; esac"), [{ remote: "origin", refspecs: ["feat"], force: true, all: false, quiet: true, hushed: true }]);
  assert.equal(gitPushes("git -c http.proxy=bot:hunter2@proxy:8080 push -f origin feat")[0]!.command, "git -c http.proxy=proxy:8080 push -f origin feat");
  for (const command of [
    `${"(".repeat(10_000)}${"git push -f;".repeat(5_000)}${") 2>&1".repeat(10_000)}`,
    `${"(".repeat(20_000)}${"a;".repeat(15_000)}${") >/dev/null".repeat(20_000)}`,
    `${"(a; ".repeat(8_000)}git push -f origin feat${") 2>/dev/null".repeat(8_000)}`,
    `${"git push;".repeat(5_550)}${":;".repeat(25_000)}`,
  ]) {
    const started = Date.now();
    const pushes = gitPushes(command);
    const ms = Date.now() - started;
    assert.ok(ms < 1_000, `${command.slice(0, 20)}… took ${ms} ms`);
    assert.ok(pushes.every((one) => (command.includes("2>/dev/null") ? one.hushed : !one.hushed)), command.slice(0, 20));
  }
});

test("pushes read in the order the shell ran them: a command before them, `!`, an if's, a loop's or a case's redirections, two quiet pushes to one branch, output cut inside a report", () => {
  const remotes = { remote: "origin", branch: "feat", urls: { origin: "../o.git" } };
  const placed = (command: string, output: string, failed = false, cut = false) => forcePushed(gitPushes(command), output, remotes, failed, cut);
  const pushed = (branch: string) => `To ../o.git\n   1111111..2222222  ${branch} -> ${branch}\n`;
  const refused = (branch: string) => `To ../o.git\n ! [rejected]        ${branch} -> ${branch} (fetch first)\nerror: failed to push some refs to '../o.git'\n`;
  // A command before the pushes, or after them: the first push's report says it went through, so the one after `||` never ran.
  assert.equal(placed("git rebase main && git push || git push --force-with-lease", `Current branch feat is up to date.\n${pushed("feat")}`), null);
  assert.equal(placed("npm test; git push origin feat || git push -f origin feat", pushed("feat"), false, true), null);
  assert.equal(placed("git push origin feat || git push -f origin feat; git push origin v1.0", `${pushed("feat")}error: src refspec v1.0 does not match any\nerror: failed to push some refs to '../o.git'\n`), null);
  assert.equal(placed("git pull --rebase && git push origin feat || git push -f origin feat", `From ../o\n * branch            feat       -> FETCH_HEAD\nCurrent branch feat is up to date.\n${pushed("feat")}`), null);
  // `a && b -q || c`: a's report, b quiet: b went through, so c (loud) never ran.
  assert.equal(placed("git push origin main && git push -q origin feat || git push -f origin feat", pushed("main")), null);
  // `!` turns what follows sees: `a && ! b || c` — b went through, so c ran.
  assert.deepEqual(placed("git push -q origin main && ! git push -q origin feat || git push -q -f origin feat", ""), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(placed("! git push -q origin main && git push -q origin feat || git push -q -f origin feat", ""), { said: [], unsaid: ["origin/feat"] });
  // An if's, a loop's or a case's commands inside a group whose stderr went away printed nothing of theirs.
  assert.deepEqual(placed("( if true; then { git push origin feat || git push -f origin feat; }; fi ) 2>/dev/null", ""), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(placed("(for b in a; do { git push -f origin $b; }; done) 2>/dev/null", ""), { said: [], unsaid: ["origin/$b"] });
  assert.deepEqual(placed("( case $x in a) git push origin feat || git push -f origin feat;; esac ) 2>/dev/null", ""), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(placed("{ case $x in a) git push origin feat || git push -f origin feat;; esac; } 2>/dev/null", ""), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(placed("case $x in (a) git push -f origin feat;; *) echo;; esac 2>/dev/null", ""), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(gitPushes("case $x in a) git push -f origin feat;; esac; git push -f origin main").map((push) => Boolean(push.hushed)), [false, false]);
  assert.deepEqual(shellSteps("case $x in a) git push;; esac; echo hi").map((step) => step.words.join(" ")), ["case $x in a", "git push", "echo hi"]);
  // A quiet force-push that printed nothing went through: what git printed is the push's after it.
  assert.deepEqual(placed("git push -q -f origin b || git push -f origin b && git push origin b || git pull --rebase", pushed("b")), { said: [], unsaid: ["origin/b"] });
  // Two quiet pushes to one branch, one refused: either one's refusal, so the forced one may have gone through.
  assert.deepEqual(placed("git push origin feat; git push -q -f origin b && git push -q origin b", `${pushed("feat")}${refused("b")}`, true), {
    said: [],
    unsaid: ["origin/b"],
    failed: "command",
  });
  // A report is of the branches it names: feat's refusal is not b's, so the quiet forced b may have gone through.
  assert.deepEqual(placed("git push -q -f origin b; git push -q origin b && git push -q -f origin feat; git push -q -f origin a", refused("feat")), {
    said: [],
    unsaid: ["origin/b", "origin/a"],
    failed: "git",
  });
  // Cut short inside a report: its refusal (git's error after it) is still one; a fetch's line is not a push's.
  assert.deepEqual(placed("npm test; git push -f origin b || git push -q -f origin a", "rejected]        b -> b (fetch first)\nerror: failed to push some refs to '../o.git'\n", false, true), {
    said: [],
    unsaid: ["origin/a"],
    failed: "git",
  });
  assert.deepEqual(
    placed("git push origin a 2>/dev/null; git push -q -f origin a; git pull --rebase && git push origin a && git push -f origin feat", `         feat       -> FETCH_HEAD\n${refused("a")}`, true, true),
    { said: [], unsaid: ["origin/a"], failed: "command" },
  );
});

test("output cut short or read more than one way: a test run's lines are no report, a loud push's may be cut away, a dry run's may be the real push's, a hook's refusal is the next push's", () => {
  const remotes = { remote: "origin", branch: "feat", urls: { origin: "../o.git" } };
  const placed = (command: string, output: string, failed = false, cut = false) => forcePushed(gitPushes(command), output, remotes, failed, cut);
  const pushed = (branch: string) => `To ../o.git\n   1111111..2222222  ${branch} -> ${branch}\n`;
  const forced = (branch: string) => `To ../o.git\n + 1111111...2222222 ${branch} -> ${branch} (forced update)\n`;
  const unsure = { said: [], unsaid: ["origin/feat"] };
  // Cut short after the push's report: what is left is another command's, not a report the push printed.
  assert.deepEqual(placed("git push -f origin feat && npm test", `${"    ✓ renders a widget (12ms)\n".repeat(5)}\n  80 passing (1s)\n`, false, true), unsure);
  assert.deepEqual(placed("git push --force-with-lease origin feat && npm test", `${"    at Object.<anonymous> (test.js:1:1)\n".repeat(3)}  1 failing\n`, true, true), { ...unsure, failed: "command" });
  assert.deepEqual(placed("git push -f origin feat && npx babel src -d lib", "file17.js -> lib/file17.js\nsrc/file18.js -> lib/file18.js\nSuccessfully compiled 80 files with Babel (812ms).\n", false, true), unsure);
  assert.deepEqual(placed("git push -f origin feat; git status", "\trenamed:    a.ts -> b.ts\n\tmodified:   x.ts\n", false, true), unsure);
  assert.deepEqual(placed("git push -f origin feat && cat NOTES.md", " - first\n - second\ntext\n", false, true), unsure);
  // Cut short, a loud push may have printed its report before the end that was kept, as a quiet one prints none.
  assert.deepEqual(placed("git push -q origin feat || git push -f origin feat; npm test", "  ✓ test 1\n  42 passing\n", false, true), unsure);
  assert.deepEqual(placed("git push -q origin main && git push -q origin feat || git push --force-with-lease origin feat; npm test", "  42 passing\n", false, true), unsure);
  // A refusal whose `To` was cut away may be the second push's: the first one's report was cut away with it.
  assert.deepEqual(placed("git push -f origin feat && git push origin feat", "rejected]        feat -> feat (fetch first)\nerror: failed to push some refs to '../o.git'\n", true, true), { ...unsure, failed: "command" });
  assert.deepEqual(placed("git push -f origin feat && git push origin feat", " ! [rejected]        feat -> feat (fetch first)\nerror: failed to push some refs to '../o.git'\n", true, true), { ...unsure, failed: "command" });
  // A forced update that may be a dry run's (`npm test` failed) or the real push's (it went through): not known to be either.
  assert.deepEqual(placed("npm test && git push --dry-run origin feat || git push -f origin feat", `  1 failing\n${forced("feat")}`), unsure);
  assert.deepEqual(placed("git pull --rebase && git push -n origin feat || git push --force-with-lease origin feat", `There is no tracking information for the current branch.\n${forced("feat")}`), unsure);
  // A pre-push hook's refusal after a report that went through is the next push's: the quiet one after `||` then ran.
  const hook = "husky - pre-push script failed (code 1)\nerror: failed to push some refs to '../o.git'\n";
  assert.deepEqual(placed("git push origin main; git push origin feat || git push -q --no-verify -f origin feat", `${pushed("main")}${hook}`), { ...unsure, failed: "git" });
  assert.deepEqual(placed("git push origin main; git push origin feat || git push --no-verify -f origin feat", `${pushed("main")}${hook}${forced("feat")}`), { said: ["origin/feat"] });
  // Not cut short, a loud push that ran printed its report: one that went through left nothing to read otherwise.
  assert.equal(placed("git push -q origin feat || git push -f origin feat", ""), null);
  // Read every way, it is still quick: 64 quiet force-pushes and 220 errors, cut short.
  const started = Date.now();
  placed(Array.from({ length: 64 }, (_, at) => `git push -q -f origin b${at}`).join("; "), "fatal: x\n".repeat(220), true, true);
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
});

test("output cut short at a report's start: its forced updates may be what the cut took; a refusal closed once, a fetch of another remote", () => {
  const remotes = { remote: "origin", branch: "feat", urls: { origin: "../o.git", upstream: "../u.git" } };
  const placed = (command: string, output: string, failed = false, cut = false) => forcePushed(gitPushes(command), output, remotes, failed, cut);
  const tests = `${"  ✓ renders\n".repeat(3)}  3 passing\n`;
  const refused = (branch: string) => `To ../o.git\n ! [rejected]        ${branch} -> ${branch} (fetch first)\nerror: failed to push some refs to '../o.git'\n`;
  const hook = "husky - pre-push script failed (code 1)\nerror: failed to push some refs to '../o.git'\n";
  // git prints a report's refs that went through before those it refused: what the cut left of it may have lost the forced ones.
  assert.deepEqual(placed("git push --force-with-lease origin feat main; npm test", ` ! [rejected]        main -> main (stale info)\nerror: failed to push some refs to '../o.git'\n${tests}`, true, true), {
    said: [],
    unsaid: ["origin/feat", "origin/main"],
    failed: "command",
  });
  assert.deepEqual(placed("git push -f origin feat main && npm test", `   3333333..4444444  main -> main\n${tests}`, false, true), { said: [], unsaid: ["origin/feat", "origin/main"] });
  assert.deepEqual(placed("git push -f origin main && npm test", "  ✓ redirects feat -> main\n  3 passing\n", false, true), { said: [], unsaid: ["origin/main"] });
  // What the cut left of an up-to-date ref's line keeps -v's "Everything up-to-date" in its report; of a forced one, not.
  const current = "    main -> main\n = [up to date]      feat -> feat\nEverything up-to-date\n";
  assert.deepEqual(placed("git push --force-with-lease origin feat && git push -v -f origin main feat", current, false, true), { said: [], unsaid: ["origin/feat"] });
  assert.equal(placed("cat NOTES.md && git push -n --force-with-lease origin feat; git push origin main || git push origin feat", "11...2222222 feat -> feat (forced update)\nEverything up-to-date\n", false, true), null);
  // "failed to push" once more after a refusal it closed is a pre-push hook's refusal of the next push: the quiet one ran.
  const fallback = "git push origin main; make || git push origin feat || git push -q --no-verify -f origin feat";
  assert.deepEqual(placed(fallback, `${refused("main")}make: *** [all] Error 2\n${hook}`, true), { said: [], unsaid: ["origin/feat"], failed: "command" });
  assert.deepEqual(
    placed("git push origin feat main; git push --force-with-lease origin main && git push origin main; git push -n -f origin main", `${refused("main")}${hook}To ../o.git\n + 1111111...2222222 main -> main (forced update)\n`, true),
    { said: [], unsaid: ["origin/main"], failed: "command" },
  );
  // Cut short after a whole line that went through, the report refused nothing: the `!` would have come after it.
  assert.deepEqual(placed(fallback, `   1111111..2222222  main -> main\nmake: *** [all] Error 2\n${hook}`, true, true), { said: [], unsaid: ["origin/feat"], failed: "command" });
  // A fetch's forced update of a known remote, its `From` cut away, is no push's.
  const fetched = " + 1111111...2222222 main       -> upstream/main  (forced update)\nfatal: unable to access '../o.git': Could not resolve host\n";
  assert.deepEqual(placed("git fetch upstream; git push -f", fetched, true, true), { said: [], unsaid: ["origin/feat"], failed: "command" });
  assert.deepEqual(placed("git fetch upstream; git push -f --all", fetched, true, true), { said: [], unsaid: [], failed: "command" });
});

test("output cut short: a fetch's line a pre-push hook's refusal follows, what a cut leaves of a moved ref's line, a branch named like a remote", () => {
  const remotes = { remote: "origin", branch: "feat", urls: { origin: "../o.git", upstream: "../u.git" } };
  const placed = (command: string, output: string, failed = false, cut = false) => forcePushed(gitPushes(command), output, remotes, failed, cut);
  const tests = `${"  ✓ renders\n".repeat(3)}  3 passing\n`;
  const hook = "husky - pre-push script failed (code 1)\nerror: failed to push some refs to '../o.git'\n";
  // A fetch's line, its `From` cut away, then the hook's refusal of the push: the hushed fallback ran.
  assert.deepEqual(
    placed("git fetch upstream main:main && git push origin main || git push --no-verify --force-with-lease origin main 2>/dev/null", `om ../u.git\n   1111111..2222222  main       -> main\n${hook}`, false, true),
    { said: [], unsaid: ["origin/main"], failed: "git" },
  );
  assert.deepEqual(
    placed("git fetch upstream --tags && git push origin v1.2 || git push -q --no-verify -f origin v1.2", `.1       -> v1.1\n * [new tag]         v1.2       -> v1.2\n${hook}`, false, true),
    { said: [], unsaid: ["origin/v1.2"], failed: "git" },
  );
  // What a cut leaves of a ref's line that went through is that push's report: the fallback did not run.
  assert.equal(placed("git push origin feat || git push --force-with-lease origin feat", "11..2222222  feat -> feat\n", false, true), null);
  // Unless a command after the push may have printed it (a script's push, a fetch's long name, unpadded): the push's
  // report may have been cut away before it.
  assert.deepEqual(gitPushes("npm test && git push -f origin feat && ./scripts/mirror.sh; git push origin v1").map((push) => Boolean(push.trailed)), [true, false]);
  assert.deepEqual(placed("git push origin feat || git push --force-with-lease origin feat && npm test", `11..2222222  feat -> feat\n${tests}`, false, true), {
    said: [],
    unsaid: ["origin/feat"],
  });
  assert.deepEqual(placed("git push -f origin feat && ./scripts/mirror.sh", "11..2222222  feat -> feat\n", false, true), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(placed("git push -f origin feat && hub push upstream feat", "  feat -> feat\n", false, true), { said: [], unsaid: ["origin/feat"] });
  assert.deepEqual(placed("git push -f origin production && git fetch upstream production:production", "11..2222222  production -> production\n", false, true), {
    said: [],
    unsaid: ["origin/production"],
  });
  // A line cut at its ref's name, or another command's, does not keep the next push's "Everything up-to-date" in it.
  assert.equal(placed("git push origin main; git push origin feat || git push -f origin feat", "main -> main\nEverything up-to-date\n", false, true), null);
  assert.equal(placed("cp -v dist/a.js public/a.js && git push origin feat || git push --force-with-lease origin feat", "'dist/a.js' -> 'public/a.js'\nEverything up-to-date\n", false, true), null);
  // Cut at its ref's name, the line may also be what is left of -v's up-to-date one: the push before it may have forced.
  assert.deepEqual(placed("git push --force-with-lease upstream main; git push -v -f origin main", "main -> main\nEverything up-to-date\n", false, true), {
    said: [],
    unsaid: ["upstream/main"],
  });
  // A push's line names its branch twice, a fetch's of a remote not: `ivan/feat -> ivan/feat` is a push's.
  const ivan = { remote: "origin", branch: "feat", urls: { origin: "../o.git", ivan: "../i.git" } };
  assert.deepEqual(forcePushed(gitPushes("git push -f origin ivan/feat"), "11...2222222 ivan/feat -> ivan/feat (forced update)\n", ivan, false, true), { said: ["origin/ivan/feat"] });
});

test("what a push shows of the command: a setting that is no secret, a proxy's or URL's password holding `@` or `/`, /dev/fd/01 and 2>&01 as descriptors, `;;` as it was", () => {
  const shown = (command: string) => gitPushes(command)[0]!.command;
  assert.equal(shown("git -c user.email=bot@example.com push origin feat"), "git -c user.email=bot@example.com push origin feat");
  assert.equal(shown("git -c http.proxy=bot:p@ss@proxy:8080 push -f origin feat"), "git -c http.proxy=proxy:8080 push -f origin feat");
  assert.equal(shown("git -c http.proxy=bot:pa/ss@proxy:8080 push -f origin feat"), "git -c http.proxy=proxy:8080 push -f origin feat");
  assert.equal(shown("git -c http.proxy=http://bot:p@ss@proxy:8080 push -f origin feat"), "git -c http.proxy=http://proxy:8080 push -f origin feat");
  assert.equal(shown("git push https://bot:p@ss@github.com/a/b.git feat"), "git push https://github.com/a/b.git feat");
  assert.deepEqual(gitPushes("git push -f origin feat 2>/dev/fd/01").map((push) => Boolean(push.hushed)), [false]);
  assert.deepEqual(gitPushes("git push -f origin feat 2>&01").map((push) => Boolean(push.hushed)), [false]);
  assert.equal(joinedPushes(gitPushes("git push origin a;; git push origin b")), "git push origin a;; git push origin b");
});

test("a pull request an agent opens into the fork's upstream is the room's too: named with its repository, kept apart from the folder's of the same number", async () => {
  const home = mkdtempSync(join(tmpdir(), "agora-gh-"));
  const pr = (number: number, repo: string | undefined, head: string, owner: string) => ({
    number,
    ...(repo ? { repo } : {}),
    title: `${repo ?? "fork"} #${number}`,
    state: "OPEN",
    headRefName: head,
    baseRefName: "main",
    headRepositoryOwner: { login: owner },
    createdAt: new Date().toISOString(),
    statusCheckRollup: [],
    latestReviews: [],
  });
  // The folder's own repository (acme/widgets, a fork) already has #1 and #2, of other branches; upstream has #1.
  const gh = fakeGh(home, [pr(1, undefined, "docs", "acme"), pr(2, undefined, "fix", "acme"), pr(1, "upstream/widgets", "theirs", "upstream")]);
  const room = createTestRoom({
    env: gh.env,
    rules: [
      // --repo names the upstream; gh prints the URL there.
      { agent: "claude", match: "UPSTREAM", once: true, run: [["gh", "pr", "create", "--repo", "upstream/widgets", "--fill", "--head", "acme:feat"]], command: { command: "gh pr create --repo upstream/widgets --fill --head acme:feat", output: "{run0}" }, reply: "Opened upstream." },
      // No --repo: gh chose the upstream itself, as it does for a fork.
      { agent: "codex", match: "DEFAULT", once: true, run: [["gh", "pr", "create", "--fill"]], command: { command: "gh pr create --fill", output: "{run0}" }, reply: "Opened." },
      // No --repo and nothing printed the room reads: looked up by branch in the repository the room knows.
      { agent: "claude", match: "OWN", once: true, run: [["gh", "pr", "create", "--fill"]], command: { command: "gh pr create --fill && gh pr view 1 --repo upstream/widgets", output: "{run0}\nhttps://github.com/upstream/widgets/pull/1" }, reply: "Opened ours." },
      { agent: "codex", match: "SILENT", once: true, run: [["sh", "-c", "gh pr create --repo upstream/widgets --fill --head acme:fix2 > /dev/null"]], command: "gh pr create --repo upstream/widgets --fill --head acme:fix2 > /dev/null", reply: "Opened." },
    ],
  });
  try {
    const ws = room.store.state.workspace;
    onGithub(ws, home);
    await withTimeout(room.engine.syncGithub());
    room.engine.postHuman("@claude UPSTREAM");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    const prs = () => (room.store.state.prs ?? []).map((entry) => [entry.repo, entry.number, entry.by, entry.status?.title]);
    assert.deepEqual(prs(), [["upstream/widgets", 3, "claude", "Add widgets"]]);
    assert.equal(room.store.state.prs![0]!.url, "https://github.com/upstream/widgets/pull/3");

    gh.edit((state) => {
      state.createRepo = "upstream/widgets";
    });
    git(ws, "checkout", "--quiet", "-B", "next");
    room.engine.postHuman("@codex DEFAULT");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    assert.deepEqual(prs().at(-1), ["upstream/widgets", 4, "codex", "Add widgets"]);

    git(ws, "checkout", "--quiet", "-B", "fix2");
    room.engine.postHuman("@codex SILENT");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    assert.deepEqual(prs().at(-1), ["upstream/widgets", 5, "codex", "Add widgets"]);
    // Asked for with its owner: another fork's fix2 in upstream is not it.
    assert.ok(gh.asked().some((call) => call.startsWith("pr view acme:fix2 --repo upstream/widgets --json")));
    // The folder's own pull request can still be opened from the branch: upstream's is another repository's.
    assert.equal((await room.engine.prPlan()).branch, "fix2");

    // The folder's #3, opened by the human from a terminal and then linked: another pull request than upstream's #3.
    gh.edit((state) => {
      state.prs.push({ ...pr(3, undefined, "fix2", "acme"), title: "fork #3" });
      state.prs.find((entry) => entry.repo === "upstream/widgets" && entry.number === 3)!.state = "MERGED";
    });
    room.engine.post("Also https://github.com/acme/widgets/pull/3", "claude");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    assert.deepEqual(
      (room.store.state.prs ?? []).filter((entry) => entry.number === 3).map((entry) => [entry.repo, entry.status?.title, entry.status?.state]),
      [
        ["upstream/widgets", "Add widgets", "merged"],
        ["acme/widgets", "fork #3", "open"],
      ],
    );
    assert.deepEqual(lines(room.store.state.messages, "pr."), [
      ["PR upstream/widgets#3 merged into main.", { code: "pr.merged", n: 3, repo: "upstream/widgets", base: "main" }],
    ]);
    // And the other way round: the folder's #3 closed, upstream's stays merged.
    gh.edit((state) => {
      state.prs.find((entry) => !entry.repo && entry.number === 3)!.state = "CLOSED";
    });
    await withTimeout(room.engine.syncGithub());
    assert.deepEqual(lines(room.store.state.messages, "pr.").at(-1), ["PR #3 closed without merging.", { code: "pr.closed", n: 3 }]);
    assert.equal(room.store.state.prs!.find((entry) => entry.repo === "upstream/widgets" && entry.number === 3)!.status!.state, "merged");

    // gh opened one in the folder's repository, and a later command printed upstream's: the folder's is the one opened.
    gh.edit((state) => {
      delete state.createRepo;
    });
    git(ws, "checkout", "--quiet", "-B", "own");
    room.engine.postHuman("@claude OWN");
    await withTimeout(room.engine.waitIdle());
    await withTimeout(room.engine.syncGithub());
    assert.deepEqual(prs().at(-1), ["acme/widgets", 6, "claude", "Add widgets"]);
  } finally {
    await room.cleanup();
    rmSync(home, { recursive: true, force: true });
  }
});

test("pull requests are their repository and number: the same number of two repositories is two of them, an older room's are read by number", () => {
  const state = initialState({ type: "room.created", seq: 1, ts: "2026-10-02T00:00:00Z", id: "r", title: "t", workspace: "/w", human: "Ivan", agents: [], settings: {} } as never);
  const status = (title: string) => ({ title, state: "open" as const, mergeable: "yes" as const, additions: 0, deletions: 0, head: "feat", base: "main", checks: [], review: null });
  let seq = 1;
  const apply = (event: Record<string, unknown>) => applyEvent(state, { ...event, seq: (seq += 1), ts: "2026-10-02T00:00:00Z" } as never);
  apply({ type: "pr.linked", number: 7, url: "https://github.com/acme/widgets/pull/7", by: "claude" });
  apply({ type: "pr.status", number: 7, status: status("old room's") });
  apply({ type: "pr.linked", repo: "upstream/widgets", number: 7, url: "https://github.com/upstream/widgets/pull/7", by: "codex" });
  apply({ type: "pr.status", repo: "upstream/widgets", number: 7, status: status("upstream's") });
  apply({ type: "pr.status", repo: "acme/widgets", number: 7, status: status("the fork's, again") });
  assert.deepEqual(
    state.prs!.map((pr) => [pr.repo, pr.number, pr.by, pr.status?.title]),
    [
      ["acme/widgets", 7, "claude", "the fork's, again"],
      ["upstream/widgets", 7, "codex", "upstream's"],
    ],
  );
});
