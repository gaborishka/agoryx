#!/usr/bin/env node
// A stand-in for GitHub's `gh`, for the room's GitHub tests. State lives in $FAKE_GH (JSON):
//   { repo: "owner/name", prs: [gh's own pull request fields, plus `repo` when not the default one], calls: [argv, ...],
//     loggedOut?: true, authUnsure?: true (it can't reach GitHub), defaultBranch?: "main", noRepoView?: true,
//     failCreate?: "what gh says", createRepo?: "owner/name" (where `pr create` opens one without --repo: a fork's
//     upstream, as gh chooses for a fork) }
// It knows `--version`, `auth status`, `repo view R --json defaultBranchRef --jq …`, `pr view [url|n|branch] [--repo R] --json …`
// (no ref: the folder's branch) and `pr create [--repo R] --fill --head b [--base x]`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const path = process.env.FAKE_GH;
const state = path ? JSON.parse(readFileSync(path, "utf8")) : { repo: "acme/widgets", prs: [], calls: [] };
const args = process.argv.slice(2);
state.calls = [...(state.calls ?? []), args];
const save = () => path && writeFileSync(path, JSON.stringify(state, null, 2));
const fail = (text) => {
  save();
  process.stderr.write(`${text}\n`);
  process.exit(1);
};
const done = (text) => {
  save();
  process.stdout.write(`${text}\n`);
  process.exit(0);
};
const flag = (...names) => {
  const at = args.findIndex((arg) => names.includes(arg));
  return at >= 0 ? args[at + 1] : undefined;
};
const branch = () => {
  try {
    return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};
const repoOf = (pr) => pr.repo ?? state.repo;
const url = (repo, number) => `https://github.com/${repo}/pull/${number}`;

if (args[0] === "--version") done("gh version 2.0.0 (fake)");
if (args[0] === "auth" && args[1] === "status") {
  if (state.loggedOut) fail("You are not logged into any GitHub hosts. To log in, run: gh auth login");
  if (state.authUnsure) fail("github.com\n  X Timeout trying to log in to github.com account fake (keyring)");
  done("github.com\n  ✓ Logged in to github.com account fake (keyring)");
}
if (args[0] === "repo" && args[1] === "view") {
  if (state.noRepoView) fail("HTTP 502: Bad Gateway");
  done(state.defaultBranch ?? "main");
}
if (args[0] === "pr" && args[1] === "view") {
  const ref = args[2] && !args[2].startsWith("-") ? args[2] : undefined;
  const link = ref && /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref);
  const repo = link ? link[1] : (flag("-R", "--repo") ?? state.repo);
  const mine = state.prs.filter((entry) => repoOf(entry).toLowerCase() === repo.toLowerCase());
  const number = link ? Number(link[2]) : ref && /^\d+$/.test(ref) ? Number(ref) : undefined;
  // A branch may be `owner:branch`: of that owner's fork only.
  const named = number ? undefined : (ref ?? branch());
  const head = named?.replace(/^[^:]*:/, "");
  const owner = named?.includes(":") ? named.split(":")[0] : undefined;
  const pr = number
    ? mine.find((entry) => entry.number === number)
    : mine.findLast((entry) => entry.headRefName === head && (!owner || entry.headRepositoryOwner?.login === owner));
  if (!pr) fail(number ? `GraphQL: Could not resolve to a PullRequest with the number of ${number}.` : `no pull requests found for branch "${head}"`);
  const { repo: _repo, ...fields } = pr;
  done(JSON.stringify({ url: url(repoOf(pr), pr.number), ...fields }));
}
if (args[0] === "pr" && args[1] === "create") {
  const repo = flag("-R", "--repo") ?? state.createRepo ?? state.repo;
  const named = flag("-H", "--head") ?? branch();
  const head = named.replace(/^[^:]*:/, "");
  const owner = named.includes(":") ? named.split(":")[0] : state.repo.split("/")[0];
  const base = flag("-B", "--base") ?? state.defaultBranch ?? "main";
  if (state.failCreate) fail(state.failCreate);
  const open = state.prs.find((entry) => repoOf(entry) === repo && entry.headRefName === head && (entry.headRepositoryOwner?.login ?? repo.split("/")[0]) === owner && entry.state === "OPEN");
  if (open) fail(`a pull request for branch "${head}" into branch "${base}" already exists:\n${url(repo, open.number)}`);
  const number = Math.max(0, ...state.prs.map((entry) => entry.number)) + 1;
  const title = execFileSync("git", ["log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  state.prs.push({
    number,
    ...(repo === state.repo ? {} : { repo }),
    title,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    additions: 3,
    deletions: 1,
    headRefName: head,
    baseRefName: base,
    reviewDecision: "REVIEW_REQUIRED",
    latestReviews: [],
    statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }],
    mergedBy: null,
    createdAt: new Date().toISOString(),
    headRepositoryOwner: { login: owner },
  });
  done(url(repo, number));
}
fail(`fake gh: unknown command ${args.join(" ")}`);
