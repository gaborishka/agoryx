import { execFile } from "node:child_process";
import { prose } from "./mentions.js";
import { shellCommands, shellSteps } from "./shell-writes.js";
import type { Activity, MessageEntry, PrCheck, PrPlan, PrState, PrStatus, RepoState, RoomAgent, RoomEventBody, RoomState, SystemNote } from "./types.js";

export type { PrPlan };

// GitHub in a room: what the room's folder says about its repository (a github.com remote, the branch), and
// what `gh`, already signed in by the human, says about a pull request. Nothing here signs in, and without gh
// signed in or a github.com remote there is nothing to show.

/** `owner/name` of a github.com remote URL (https, ssh or git@), or null. */
export const githubRepo = (url: string): string | null => {
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
};

/** The repository gh's `--repo` names: `owner/name`, `github.com/owner/name` or its URL. */
const repoArg = (value: string): string => (githubRepo(value) ?? value.replace(/^github\.com\//, "")).toLowerCase();

/** `missing`: the program is not there to run. */
const run = (file: string, cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; out: string; err: string; missing: boolean }> =>
  new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        out: String(stdout),
        err: (String(stderr) || (error?.message ?? "")).trim(),
        missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
      }),
    );
  });

/** The daemon's git takes no optional locks: its reads never make an agent's `git add` fail on index.lock. */
const gitEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, GIT_OPTIONAL_LOCKS: "0" });

const git = async (cwd: string, args: string[]): Promise<string | null> => {
  const result = await run("git", cwd, args, gitEnv(process.env), 5_000);
  return result.ok ? result.out.trim() : null;
};

/**
 * The folder's GitHub repository and branch: its upstream's remote (else `origin`, else the only remote) when that
 * is on github.com. The base is the branch a room's worktree was made from (`worktreeBase`) when the remote has it,
 * else the remote's default branch as git knows it, when it does; `urls`, each remote's push URL. null: no such
 * repository (or no git repository at all); undefined: git could not tell now.
 */
export const readRepo = async (cwd: string, worktreeBase?: string): Promise<(Omit<RepoState, "seq"> & { urls: Record<string, string> }) | null | undefined> => {
  // One git call for a folder with no remote (most rooms): nothing else is asked.
  const listed = await run("git", cwd, ["remote", "-v"], gitEnv(process.env), 5_000);
  if (!listed.ok) return /not a git repository/i.test(listed.err) ? null : undefined;
  // `origin\thttps://… (push)`: each remote, and the (first) URL it pushes to.
  const urls: Record<string, string> = {};
  const pushTo = new Set<string>();
  for (const line of listed.out.split("\n")) {
    const [, name, url, kind] = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line) ?? [];
    if (!name || url === undefined || pushTo.has(name)) continue;
    if (kind === "push") pushTo.add(name);
    urls[name] = url;
  }
  const remotes = Object.keys(urls);
  if (!remotes.length) return null;
  const branch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  const upstream = branch ? await git(cwd, ["config", `branch.${branch}.remote`]) : null;
  const remote = upstream && remotes.includes(upstream) ? upstream : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : null;
  if (!remote) return null;
  const repo = githubRepo((await git(cwd, ["remote", "get-url", remote])) ?? "");
  if (!repo) return null;
  const made = worktreeBase?.startsWith(`${remote}/`) ? worktreeBase.slice(remote.length + 1) : worktreeBase;
  const fromWorktree = made && made !== "HEAD" && (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${made}`])) !== null ? made : undefined;
  const base = fromWorktree ?? ((await git(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]))?.replace(`${remote}/`, "") || undefined);
  return { repo, remote, branch, ...(base ? { base } : {}), urls };
};

export class GhError extends Error {}

const ghEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });

/** Runs gh in the folder; its own login, its own errors. */
export const gh = async (cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<string> => {
  const result = await run("gh", cwd, args, ghEnv(env), timeoutMs);
  if (!result.ok) throw new GhError(result.err.split("\n").slice(-3).join("\n") || "gh failed");
  return result.out;
};

/** How long what gh said of its login holds: a gh signed out (or in) shows within this. */
const GH_READY_MS = 60_000;
/** A gh that could not tell (offline, slow to answer) is asked again sooner. */
const GH_UNSURE_MS = 10_000;
const ghAsked = new Map<string, { at: number; holds: number; ready: Promise<boolean | undefined> }>();
/**
 * Whether gh is there and signed in to github.com, per PATH and gh config: false when there is no gh or it says it
 * is not logged in; undefined when it could not tell (offline, a timeout, a token it could not check), and then what
 * the room knew stands.
 */
export const ghReady = (env: NodeJS.ProcessEnv): Promise<boolean | undefined> => {
  const key = `${env.PATH ?? ""}\0${env.GH_CONFIG_DIR ?? ""}`;
  const asked = ghAsked.get(key);
  if (asked && Date.now() - asked.at < asked.holds) return asked.ready;
  const entry = { at: Date.now(), holds: GH_READY_MS, ready: Promise.resolve<boolean | undefined>(undefined) };
  const status = (args: string[]) => run("gh", process.cwd(), ["auth", "status", "--hostname", "github.com", ...args], ghEnv(env), 10_000);
  // The active account's login: another account of github.com that is broken is not this one. A gh older than
  // `--active` is asked without it.
  entry.ready = status(["--active"]).then(async (first) => {
    const result = !first.ok && /unknown flag/i.test(first.err) ? await status([]) : first;
    if (result.ok) return true;
    if (result.missing || /not logged in/i.test(result.err)) return false;
    entry.holds = GH_UNSURE_MS;
    return undefined;
  });
  ghAsked.set(key, entry);
  return entry.ready;
};

/** The pull request URLs in `repo` a text links to: in its prose, not in code or in a quote of someone else. */
export const prLinks = (text: string, repo: string): Array<{ number: number; url: string }> => {
  const found = new Map<number, string>();
  for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g)) {
    if (match[1]!.toLowerCase() === repo.toLowerCase()) found.set(Number(match[2]), `https://github.com/${match[1]}/pull/${match[2]}`);
  }
  return [...found].map(([number, url]) => ({ number, url }));
};

/** gh pr create's options that take a value: the next word, `--name=value`, or `-Xvalue`. */
const PR_CREATE_VALUES = new Set(["-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-R", "--repo", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "--recover"]);
/** Options with which it opens none. */
const PR_CREATE_NONE = new Set(["--help", "-h", "--dry-run", "--web", "-w"]);

/**
 * A `gh pr create` the command runs (not `--help`, `--dry-run` or `--web`, which open none): the repository it names
 * with `--repo` (lowercase `owner/name`), and the branch (and its owner) it names as `--head`, if it does.
 */
export const prCreate = (command: string): { repo?: string; head?: string; owner?: string } | null => {
  for (const words of shellCommands(command)) {
    if (words[0]!.split("/").at(-1) !== "gh" || words[1] !== "pr" || words[2] !== "create") continue;
    const values = new Map<string, string>();
    let none = false;
    for (let i = 3; i < words.length; i += 1) {
      const word = words[i]!;
      if (word === "--") break;
      const eq = word.indexOf("=");
      if (word.startsWith("--") && eq > 0 && PR_CREATE_VALUES.has(word.slice(0, eq))) values.set(word.slice(0, eq), word.slice(eq + 1));
      else if (PR_CREATE_VALUES.has(word)) values.set(word, words[(i += 1)] ?? "");
      else if (/^-[A-Za-z]./.test(word) && PR_CREATE_VALUES.has(word.slice(0, 2))) values.set(word.slice(0, 2), word.slice(2));
      else if (PR_CREATE_NONE.has(word)) none = true;
    }
    if (none) continue;
    const repo = values.get("-R") ?? values.get("--repo");
    const head = values.get("-H") ?? values.get("--head");
    const owner = head?.includes(":") ? head.slice(0, head.indexOf(":")) : undefined;
    return { ...(repo ? { repo: repoArg(repo) } : {}), ...(head ? { head: head.replace(/^[^:]*:/, "") } : {}), ...(owner ? { owner } : {}) };
  }
  return null;
};

/** What gh says when the branch already has a pull request: it opened none, whatever URL it printed. */
const ALREADY_OPEN = /a pull request for branch .* already exists/i;

/** Words of git itself before its command: `git -C dir`, `git --no-pager`, `git -c k=v`. */
const GIT_OPTION_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);

/** A `git push` a command runs: its words, the remote (or URL) and refspecs it names, and whether it forces. */
export interface GitPush {
  command: string;
  remote?: string;
  refspecs: string[];
  /** `-f`, `--force`, `--force-with-lease`, `--mirror` or a `+` refspec. */
  force: boolean;
  /** `--all`, `--mirror`, `--branches` or `--tags`: what it pushes is not named. */
  all: boolean;
  /** `-q`, `--quiet`, or its stderr sent away: git says nothing of what it pushed. */
  quiet?: true;
  /** Its stderr sent away (`2>/dev/null`): git's errors are not seen either. */
  hushed?: true;
  /** `-n`, `--dry-run`: it pushes nothing; git still prints what it would have done. */
  dry?: true;
  /** `git push … || git push …`: it runs only when the push before it failed. */
  orElse?: true;
  /** `! git push …`: what follows it sees it end the other way. */
  negated?: true;
  /** `npm test && git push …`: joined by `&&` to the command before it, so it never ran when that one failed. */
  chained?: true;
  /** `npm test || git push …`: joined by `||` to another command before it, so it ran only when that one failed. */
  fallback?: true;
  /** The operator that joins it to the push right before it (`&&`, `||`, `;`, `|`); none when another command came between. */
  after?: string;
  /** Another command runs after it (`git push -f … && ./release.sh`): a line that one prints may read as the push's. */
  trailed?: true;
}

/**
 * A `-c name=value` given to git, as it can be shown: a value that may be a secret (a header, a token) left out, and
 * a proxy's or URL's user and password (up to its last `@`: a password may hold one, or a `/` with no scheme).
 */
const gitSetting = (word: string): string => {
  const name = word.slice(0, Math.max(word.indexOf("="), 0));
  if (/header|token|pass|secret|auth|cred|key/i.test(name)) return `${name}=…`;
  if (!/proxy|url/i.test(name)) return word;
  const value = word.slice(name.length + 1);
  const scheme = /^[a-z][\w+.-]*:\/\//i.exec(value)?.[0] ?? "";
  const rest = value.slice(scheme.length);
  const user = (scheme ? rest.slice(0, rest.search(/\/|$/)) : rest).lastIndexOf("@");
  return `${name}=${scheme}${rest.slice(user + 1)}`;
};

/** git push's options that take the next word as their value (or `--name=value`). */
const PUSH_OPTION_WITH_VALUE = new Set(["--push-option", "--repo", "--receive-pack", "--exec", "--recurse-submodules"]);

/** The `git push` commands a command runs, dry runs too (they push nothing). */
export const gitPushes = (command: string): GitPush[] => {
  const pushes: GitPush[] = [];
  let pushedLast = false;
  // The pushes another command already follows: each is marked once.
  let trailed = 0;
  for (const { words, after, hushed, negated } of shellSteps(command)) {
    const orElse = pushedLast && after === "||";
    const joined = pushedLast ? after : undefined;
    const chained = after === "&&";
    const fallback = !pushedLast && after === "||";
    pushedLast = false;
    const git = words[0]!.split("/").at(-1) === "git";
    let at = 1;
    while (git && at < words.length && words[at]!.startsWith("-")) at += GIT_OPTION_WITH_VALUE.has(words[at]!) ? 2 : 1;
    if (!git || words[at] !== "push") {
      for (; trailed < pushes.length; trailed += 1) pushes[trailed]!.trailed = true;
      continue;
    }
    pushedLast = true;
    const positional: string[] = [];
    let repo: string | undefined;
    let force = false;
    let all = false;
    let quiet = false;
    let dry = false;
    for (let i = at + 1; i < words.length; i += 1) {
      const word = words[i]!;
      if (word === "--") {
        positional.push(...words.slice(i + 1));
        break;
      }
      if (word.startsWith("--")) {
        const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
        const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : PUSH_OPTION_WITH_VALUE.has(word) ? words[(i += 1)] : undefined;
        if (name === "--repo") repo = value;
        if (["--force", "--mirror", "--force-with-lease"].includes(name)) force = true;
        if (["--all", "--mirror", "--branches", "--tags"].includes(name)) all = true;
        if (name === "--quiet") quiet = true;
        if (name === "--dry-run") dry = true;
        continue;
      }
      if (/^-[^-]/.test(word)) {
        // A cluster of short options (`-uf`); `-o` takes the rest of the word, or the next word, as its value.
        for (let c = 1; c < word.length; c += 1) {
          const flag = word[c];
          if (flag === "o") {
            if (c === word.length - 1) i += 1;
            break;
          }
          if (flag === "f") force = true;
          if (flag === "q") quiet = true;
          if (flag === "n") dry = true;
        }
        continue;
      }
      positional.push(word);
    }
    const remote = repo ?? positional[0];
    const refspecs = repo ? positional : positional.slice(1);
    pushes.push({
      // Without the user and password (or token) a URL may hold, or a secret given to git (`-c http.extraHeader=…`,
      // `-c http.proxy=user:pw@proxy:8080`).
      command: words
        .map((word, i) => (i >= at || words[i - 1] !== "-c" ? word : gitSetting(word)))
        .join(" ")
        .replace(/(?<![\w+.-])([a-z][\w+.-]*:\/\/)[^/\s]*@/gi, "$1"),
      ...(remote ? { remote } : {}),
      refspecs,
      force: force || refspecs.some((spec) => spec.startsWith("+")),
      all,
      ...(quiet || hushed ? { quiet: true as const } : {}),
      ...(hushed ? { hushed: true as const } : {}),
      ...(dry ? { dry: true as const } : {}),
      ...(orElse ? { orElse: true as const } : {}),
      ...(negated ? { negated: true as const } : {}),
      ...(chained ? { chained: true as const } : {}),
      ...(fallback ? { fallback: true as const } : {}),
      ...(joined ? { after: joined } : {}),
    });
  }
  return pushes;
};

/** The pushes that push, as the command joined them: `a; b`, `a || b`, and `a … b` with other commands (or a dry run) between. */
export const joinedPushes = (pushes: readonly GitPush[]): string => {
  let last = -1;
  return pushes
    .map((push, at) => {
      if (push.dry) return "";
      const joined = last === at - 1 ? push.after : undefined;
      const first = last < 0;
      last = at;
      return `${first ? "" : joined?.startsWith(";") ? `${joined} ` : ` ${joined ?? "…"} `}${push.command}`;
    })
    .join("");
};

/**
 * A ref's line in a push's report: ` + a...b feat -> feat`, `   a..b`, ` ! [rejected]`, ` - [deleted]`, or --porcelain's
 * `+\tsrc:dst\t…`; not an indented line of a test run or a list's ` - item`.
 */
const REF_LINE = /^(?: [ +*=!-] (?:[0-9a-f]+\.\.\.?[0-9a-f]+|\[[a-z][a-z ]*\])\s|[ +*=!-]\t[^\t]*:[^\t]+\t)/;

/**
 * What a cut may have left of an up-to-date ref's line, ` = [up to date]      feat -> feat`: `ate]  feat -> feat`, or its
 * padding, wider than a moved ref's (`1111111..2222222  feat`); `maybe` with no more of it than a moved ref's has.
 */
const cutCurrent = (line: string): boolean | "maybe" => {
  const at = line.search(/\S* -> \S+\s*$/);
  if (at < 0) return false;
  const kept = line.slice(0, at);
  return kept.trim() ? " = [up to date]".endsWith(kept.trimEnd()) : kept.length > 2 || "maybe";
};

/** What a cut may have left of a ref's line: `22 feat -> feat (forced update)`, `  feat -> feat`. */
const REF_TAIL = /^\s*(?:[0-9a-f]*(?:\.\.\.?[0-9a-f]+)?\s+)?\S+ -> \S+(?: \(.+\))?\s*$/;

/** A remote's name (a URL or a path is pushed to by itself: `git push ../fork.git feat`). */
const REMOTE_NAME = /^[\w.-]+$/;

/** A remote URL as it can be shown, and as git prints it after `To`: without the user (and password, or token) it may hold. */
const shownUrl = (url: string) =>
  /^[a-z][\w+.-]*:\/\//i.test(url) ? url.replace(/^([a-z][\w+.-]*:\/\/)[^@/]*@/i, "$1") : url.replace(/^[^@/:]+@(?=[^/]*:)/, "");

/**
 * The remote branches a command's pushes rewrote, as git said in its output: `+ old...new feat -> feat (forced update)`
 * (or --porcelain's line) under a push's `To <url>`. A report (a `To`, or "Everything up-to-date") is a push's as the
 * pushes, run as the shell runs them, would have printed the reports and errors in order (to its URL, `urls`: each
 * remote's push URL, and of a branch it names); when they cannot have, the push to the URL git printed. A forced update
 * whose push is not known is of the remote with that URL, the pushes' one remote, or the URL. A dry run's report
 * rewrote nothing. A fetch's forced updates, under its `From <url>` (or, cut away, `-> upstream/main` of a known
 * remote), are someone else's push it brought in. `unsaid`: a push that forces and of which git said nothing
 * (`--quiet`, its output sent away or cut short) is still one, named by what it pushed (none named for
 * `--all`/`--mirror`); its history may not have been rewritten; so is one that what git printed, read any way it can
 * be, leaves without a report of its own (two quiet pushes, one refused; a loud one whose report was cut away), whose
 * report, cut short at its start, may have lost them (it lacks a ref the push names, or all that is left is a line no
 * refusal followed that is not what a cut leaves of a ref's line, or that a command after the push may have printed),
 * or may be a dry run's. Not one that never ran: every reading says so (`a && b`: a refused a ref;
 * `a || b`: a went through, or, quiet, printed nothing); a forced update no push may have printed (a test run's line,
 * cut short) is none. Out of order, after `||` a push that went through, down a chain of them: its own report refused
 * no ref, or, with none, git printed no error, the output is whole (`cut`: the runner kept its end only), its errors
 * were not sent away and nothing before an `&&` could have kept it from running. `failed`: and the command failed, or
 * git printed an error: it may not have pushed at all. null: no push rewrote anything, and none forced unsaid.
 */
export const forcePushed = (
  pushes: GitPush[],
  output: string | undefined,
  repo: { remote: string; branch: string | null; urls?: Readonly<Record<string, string>> },
  failed = false,
  cut = false,
): { said: string[]; unsaid?: string[]; failed?: "command" | "git" } | null => {
  const real = pushes.filter((push) => !push.dry);
  if (!real.length) return null;
  const remoteOf = (push: GitPush) => (!push.remote ? repo.remote : REMOTE_NAME.test(push.remote) ? push.remote : shownUrl(push.remote));
  // `origin/feat`; `feat at ../fork.git` of a URL or path.
  const ref = (remote: string, branch: string) => (REMOTE_NAME.test(remote) ? `${remote}/${branch}` : `${branch} at ${remote}`);
  const urlOf = (push: GitPush) => {
    const remote = remoteOf(push);
    if (!REMOTE_NAME.test(remote)) return remote;
    const url = repo.urls?.[remote];
    return url === undefined ? undefined : shownUrl(url);
  };
  const remoteAt = (url: string) => Object.entries(repo.urls ?? {}).find(([, one]) => shownUrl(one) === url)?.[0];
  // Each push's report: its `To <url>` (up to porcelain's `Done`, a fetch's `From`, the next report), or "Everything
  // up-to-date"; the refs it names (`feat` of `refs/heads/feat`).
  // `clipped`: its `To` cut away, its only ref line is the first one, cut short: it may have been a refusal's (git prints
  // those after the rest), or, `foreign`, unlike what a cut leaves of a ref's line, another command's line that only
  // looks like one. `doubtful`: its `To` cut away, the refs it shows went through and "failed to push some refs" follows:
  // it may be another command's (a fetch's, its `From` cut away), the error a push's. `folds`: an "Everything up-to-date"
  // that may close the report before it, cut short in a ref's line that may have been up to date.
  type Report = { url?: string; forced: string[]; refs: string[]; rejected: boolean; headless?: true; clipped?: boolean; foreign?: boolean; doubtful?: true; folds?: number };
  const reports: Report[] = [];
  // The reports and the errors git printed, in order: a report's index, or null for an error's line.
  const printed: Array<number | null> = [];
  // Cut short, the output may begin inside a push's report, its `To` cut away: one whose URL is not known.
  let open: (Report & { current: boolean; shown: boolean; maybe?: boolean }) | undefined = cut ? { forced: [], refs: [], rejected: false, headless: true, current: true, shown: false } : undefined;
  (output ?? "").split("\n").forEach((line, index) => {
    const to = /^To (\S+)\s*$/.exec(line);
    if (to) {
      open = { url: shownUrl(to[1]!), forced: [], refs: [], rejected: false, current: true, shown: true };
      printed.push(reports.push(open) - 1);
      return;
    }
    if (/^Everything up-to-date\s*$/.test(line)) {
      // With -v, git closes a push's `To` of refs up to date with it: still that push's report.
      if (!open?.current || !open.shown) printed.push(reports.push({ forced: [], refs: [], rejected: false, ...(open?.shown && open.maybe ? { folds: reports.indexOf(open) } : {}) }) - 1);
      open = undefined;
      return;
    }
    // "failed to push some refs" right after a report that refused a ref closes it, as it does one whose `!` may have been
    // cut away; after any other (a pre-push hook's refusal of the next push), or once more, it is an error of its own.
    const failing = /^error: failed to push some refs/.test(line) && open !== undefined && printed.at(-1) === reports.indexOf(open);
    const closes = failing && (open!.rejected || Boolean(open!.clipped));
    if (/^(?:fatal: |error: )/.test(line) && !closes) printed.push(null);
    if (closes) open!.rejected = true;
    else if (failing && open!.headless) open!.doubtful = true;
    if (closes || (failing && open!.headless) || /^(?:Done\s*$|From \S)/.test(line)) open = undefined;
    if (!open) return;
    // A ref's line (` + a...b feat -> feat`, ` - [deleted] feat`, or --porcelain's `+\tsrc:dst\t…`); the first line, cut
    // short, may be the end of one. Cut short before a push's `To`, not a fetch's (`feat -> FETCH_HEAD`, `feat ->
    // origin/feat`; a push's `origin/feat -> origin/feat` names its branch twice).
    const fetched = /(?:^|\s)->\s+(?:FETCH_HEAD|([\w.-]+)\/(\S+))/.exec(line);
    const remote = fetched?.[1];
    // The word before the arrow, taken apart from the pattern: in it, a long run of blanks would take quadratic time.
    const source = fetched && line.slice(0, fetched.index).trim().split(/\s+/).at(-1);
    if (!open.shown && fetched && (!remote || (source !== `${remote}/${fetched[2]}` && (Object.hasOwn(repo.urls ?? {}, remote) || pushes.some((push) => remoteOf(push) === remote))))) return;
    if (!REF_LINE.test(line) && !(index === 0 && /\S -> \S/.test(line))) return;
    const dst = /->\s+(\S+)/.exec(line)?.[1] ?? /^ - \[deleted\]\s+(\S+)/.exec(line)?.[1] ?? /^[ +*=!-]\t[^\t]*:([^\t]+)/.exec(line)?.[1];
    if (!open.shown) {
      // Not a report without a ref in it: an indented line of a test run, a list's ` - `.
      if (!dst) return;
      open.shown = true;
      printed.push(reports.push(open) - 1);
    }
    if (open.headless) open.clipped = index === 0 && !REF_LINE.test(line);
    if (open.headless) open.foreign = open.clipped && !REF_TAIL.test(line);
    // Other than `=` (up to date), or what a cut left of one; or maybe of one.
    if (!/^(?: = |=\t)/.test(line)) {
      const kept = open.clipped && cutCurrent(line);
      if (kept !== true) open.current = false;
      open.maybe = kept === "maybe";
    }
    if (/^(?: ! |!\t)/.test(line)) open.rejected = true;
    if (dst) open.refs.push(dst.replace(/^refs\/(?:heads|tags)\//, ""));
    if (dst && /\(forced update\)\s*$/.test(line)) open.forced.push(dst.replace(/^refs\/heads\//, ""));
  });
  const loud = pushes.filter((push) => !push.quiet);
  // The refs a push names (none known for `--all`, a pattern, or none named: git's settings choose them).
  const pushing = (push: GitPush) => {
    if (push.all || !push.refspecs.length || push.refspecs.some((spec) => spec.includes("*"))) return undefined;
    const names = push.refspecs.map((spec) => spec.replace(/^\+/, "").replace(/^[^:]*:/, "").replace(/^refs\/(?:heads|tags)\//, "").replace(/^@$/, "HEAD"));
    return names.includes("HEAD") && !repo.branch ? undefined : names.map((name) => (name === "HEAD" ? repo.branch! : name));
  };
  // A report may be a push's: to its URL, and of a ref it names (unless git's settings pushed another: then by URL). One
  // whose `To` was cut away, only of a push that names a ref in it or names none.
  let byRef = true;
  const names = (report: Report, push: GitPush) => Boolean(pushing(push)?.some((name) => report.refs.includes(name)));
  const agrees = (report: Report, push: GitPush) =>
    (report.url === undefined || urlOf(push) === undefined || urlOf(push) === report.url) &&
    (!pushing(push) || names(report, push) || (!report.headless && (!byRef || !report.refs.length)));
  // Cut short, a first line that only looks like the end of a report (`src/x.js -> lib/x.js`): no push names its ref (one
  // that names none may still take it); or a doubtful one; an "Everything up-to-date" that may close the report before it,
  // one a push may have printed.
  const stray = reports.map(
    (report) =>
      (report.folds !== undefined && pushes.some((push) => !pushing(push) || names(reports[report.folds!]!, push))) ||
      (Boolean(report.headless) && (Boolean(report.doubtful) || !pushes.some((push) => names(report, push)))),
  );
  // What git printed, in order, as the pushes would have printed it, read every way it can be. A loud push that ran took
  // the next report, or failed with an error and none (`fatal: unable to access`, `error: src refspec`); a quiet one
  // printed nothing, or, failing, its report or an error; one whose stderr went away, nothing. A push after `||` ran when
  // the pushes before it failed, after `&&` when they went through; when that is not known (a quiet push, a command before
  // it, `!`), it may have run or not. An error may be another command's; cut short, the first pushes' output may have
  // been cut away. Every report is taken. `untold`: the pushes that, read some way, ran or may have and took no report of
  // their own; `takers`: the pushes a report may be of; `owners`: the first way it reads.
  const inOrder = () => {
    if (pushes.length > 64 || printed.length > 2000) return undefined;
    type State = [at: number, next: number, went: boolean | undefined, before: boolean];
    type Move = { to: State; push?: number; took?: number; untold?: true };
    const moves = ([at, next, went, before]: State): Move[] => {
      const push = pushes[at]!;
      const one = printed[next];
      // Whether it was passed over: yes, no, or not known (another command before it).
      const passed = push.orElse ? went : push.after === "&&" ? (went === undefined ? undefined : !went) : push.chained || push.fallback ? undefined : false;
      if (passed === true) return [{ to: [at + 1, next, went, before] }];
      const list: Move[] = [];
      // A report whose `To` was cut away may have lost the forced updates of refs the push names that it lacks (git prints
      // them before the rest); and one cut short in its first line, no refusal, may be another command's: a foreign line,
      // or a ref's line a command after the push printed (a script's push, a fetch's `production -> production`).
      const report = one === undefined || one === null ? undefined : reports[one]!;
      const cutAway = report?.foreign || (report?.clipped && push.trailed);
      const lost = Boolean(report?.headless) && ((Boolean(cutAway) && !report!.rejected) || !pushing(push)?.every((name) => report!.refs.includes(name)));
      const takes = (failing: boolean): Move => ({
        to: [at + 1, next + 1, push.negated ? undefined : !failing, false],
        push: at,
        ...(one === null || lost ? { untold: true as const } : {}),
        ...(one === null ? {} : { took: one! }),
      });
      const fits = one !== undefined && (one === null || agrees(reports[one]!, push));
      if (push.hushed) list.push({ to: [at + 1, next, undefined, before], push: at, untold: true });
      else if (push.quiet) {
        // Quiet, it printed nothing when it went through.
        list.push({ to: [at + 1, next, push.negated ? undefined : true, before], push: at, untold: true });
        if (fits && (one === null || reports[one]!.rejected)) list.push(takes(true));
      } else if (fits) list.push(takes(one === null || reports[one]!.rejected));
      // Its output cut away; not run (what came before it ended the way that passes it over), or so it may be; an error
      // another command's, or a line that only looks like a report.
      if (before && cut) list.push({ to: [at + 1, next, undefined, true], push: at, untold: true });
      if (passed === undefined) list.push({ to: [at + 1, next, Boolean(push.orElse || push.fallback), before], push: at, untold: true });
      if (one === null || (one !== undefined && stray[one])) list.push({ to: [at, next + 1, went, before] });
      return list;
    };
    const width = printed.length + 1;
    const index = ([at, next, went, before]: State) => ((at * width + next) * 3 + (went === undefined ? 2 : went ? 1 : 0)) * 2 + (before ? 1 : 0);
    // Whether what is left can be read from there: 1 yes, 2 no, 0 not asked yet.
    const known = new Int8Array((pushes.length + 1) * width * 6);
    const left = printed.map(() => false);
    for (let at = printed.length - 1, any = false; at >= 0; at -= 1) left[at] = any ||= printed[at] !== null && !stray[printed[at]!];
    const can = (state: State): boolean => {
      if (state[0] === pushes.length) return !left[state[1]];
      const at = index(state);
      if (!known[at]) known[at] = moves(state).some((move) => can(move.to)) ? 1 : 2;
      return known[at] === 1;
    };
    const start: State = [0, 0, undefined, true];
    if (!can(start)) return undefined;
    const untold = pushes.map(() => false);
    const takers = reports.map(() => new Set<number>());
    const seen = new Set([index(start)]);
    for (const queue = [start]; queue.length; ) {
      const state = queue.pop()!;
      if (state[0] === pushes.length) continue;
      for (const move of moves(state)) {
        if (!can(move.to)) continue;
        if (move.untold) untold[move.push!] = true;
        if (move.took !== undefined) takers[move.took]!.add(move.push!);
        if (!seen.has(index(move.to))) {
          seen.add(index(move.to));
          queue.push(move.to);
        }
      }
    }
    const owners: Array<GitPush | undefined> = reports.map(() => undefined);
    for (let state = start; state[0] < pushes.length; ) {
      const move = moves(state).find((one) => can(one.to))!;
      if (move.took !== undefined) owners[move.took] = pushes[move.push!];
      state = move.to;
    }
    return { owners, untold, takers };
  };
  let next = 0;
  let ordered = inOrder();
  if (!ordered) {
    byRef = false;
    ordered = inOrder();
    byRef = ordered === undefined;
  }
  const inLine = ordered !== undefined || (reports.length === loud.length && reports.every((report, at) => agrees(report, loud[at]!)));
  const owners: Array<GitPush | undefined> = ordered?.owners ?? (inLine
    ? loud
    : // Out of line (a push's report sent away, a quiet push's failure printed): the next push to the URL git printed
        // that prints its report.
      reports.map((report) => {
        const at = report.url === undefined ? -1 : pushes.findIndex((push, i) => i >= next && !push.hushed && urlOf(push) === report.url && agrees(report, push));
        if (at < 0) return undefined;
        next = at + 1;
        return pushes[at];
      }));
  const remotes = [...new Set(real.map(remoteOf))];
  const said = new Set<string>();
  // A push a forced update may be of that may also be a dry run's: it may have forced unsaid.
  const unsure = new Set<GitPush>();
  reports.forEach((report, at) => {
    if (!report.forced.length) return;
    const takers = ordered ? [...ordered.takers[at]!].map((one) => pushes[one]!) : owners[at] ? [owners[at]!] : [];
    // A line no push may have printed.
    if (ordered && !takers.length) return;
    // A dry run's report is what it would have done; one that may be a dry run's is not known to be any other's.
    if (takers.some((one) => one.dry) || (!takers.length && pushes.some((one) => one.dry && (urlOf(one) === undefined || urlOf(one) === report.url)))) {
      for (const one of takers) if (!one.dry) unsure.add(one);
      return;
    }
    // The push it is of as it first reads.
    const owner = owners[at] ?? takers[0];
    const where = owner ? remoteOf(owner) : ((report.url && remoteAt(report.url)) ?? (remotes.length === 1 ? remotes[0] : report.url));
    for (const dst of report.forced) said.add(where ? ref(where, dst) : dst);
  });
  // A push git said what it did of: its report is known (a quiet one prints its report when part of it failed). One
  // whose report is not known (its output went to /dev/null, or was cut short) did not tell.
  const told = new Set(output === undefined ? [] : owners.filter((push): push is GitPush => push !== undefined));
  const refused = new Set(owners.filter((push, at) => push && reports[at]!.rejected));
  // An error git printed of no push's report (`fatal: unable to access`, `error: src refspec`, a refused ref whose push
  // is not known); "failed to push some refs" only beyond the reports that refused a ref, which it follows.
  const refusals = (output ?? "").match(/^error: failed to push some refs/gm)?.length ?? 0;
  const errors =
    /^fatal: |^error: (?!failed to push some refs)/m.test(output ?? "") ||
    refusals > reports.filter((report) => report.rejected).length ||
    reports.some((report, at) => report.rejected && !owners[at]);
  // When what git printed cannot be read in order: whether a push may have failed: its report refused a ref; with no
  // report of its own, git printed an error (whose, is not known), the output was cut short, its errors were sent away,
  // or a command before its `&&` may have failed (not a push right before it that went through: its own report said so,
  // or, quiet, it printed no error). Its report is what it did: "Everything up-to-date", a ref pushed, whatever else
  // printed an error; matched out of line it may be a later push's to that URL, and says nothing of this one.
  const ran: boolean[] = [];
  const failing: boolean[] = [];
  const through: boolean[] = [];
  pushes.forEach((push, at) => {
    const own = inLine && told.has(push);
    const held = Boolean(push.chained) && !(push.after === "&&" && through[at - 1]);
    // `a || b`: b ran only when a may have failed (and ran); `a || b || c`: c, when b ran and may have failed.
    ran.push(!push.orElse || at === 0 || (ran[at - 1]! && failing[at - 1]!));
    // `! git push`: what follows sees it fail when it went through, so it may have.
    failing.push(Boolean(push.negated) || output === undefined || refused.has(push) || (!own && (errors || cut || Boolean(push.hushed) || held)));
    through.push(ran[at]! && !failing[at]! && (own || Boolean(push.quiet)));
  });
  // A force-push that may have gone through without a word: read some way, it ran, or may have, and took no report of its
  // own (`git push -q origin feat; git push -q -f origin feat` refused once: either one's refusal), or one it took may
  // be a dry run's; out of order, its report is not known.
  const quietly = pushes.filter((push, at) => !push.dry && push.force && (ordered ? ordered.untold[at]! || unsure.has(push) : !told.has(push) && ran[at]!));
  const named = (push: GitPush) =>
    push.all
      ? []
      : (push.refspecs.length
          ? push.refspecs.map((spec) => spec.replace(/^\+/, "").replace(/^[^:]*:/, "").replace(/^refs\/heads\//, "")).map((name) => (name === "HEAD" ? repo.branch : name))
          : [repo.branch]
        )
          .filter((name): name is string => Boolean(name))
          .map((name) => ref(remoteOf(push), name));
  const unsaid = [...new Set(quietly.flatMap(named))].filter((one) => !said.has(one));
  // `--all`/`--mirror` names none: the remote then.
  const unnamed = quietly.some((push) => push.all);
  if (!said.size && !unsaid.length && !unnamed) return null;
  // It may never have pushed: the command failed (`npm test && git push -f`, or the push itself), or git said an error
  // (`fatal:`, "failed to push", hidden by `|| true`) — of this push or of another git command, which is not known.
  const why = failed ? ("command" as const) : /^(?:fatal: |error: failed to push|error: src refspec)/m.test(output ?? "") ? ("git" as const) : undefined;
  return { said: [...said], ...(unsaid.length || unnamed ? { unsaid, ...(why ? { failed: why } : {}) } : {}) };
};

const PR_FIELDS = "number,url,title,state,isDraft,mergeable,additions,deletions,headRefName,baseRefName,reviewDecision,latestReviews,statusCheckRollup,mergedBy,createdAt,headRepositoryOwner";

interface GhPr {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft?: boolean;
  mergeable?: string;
  additions?: number;
  deletions?: number;
  headRefName?: string;
  baseRefName?: string;
  reviewDecision?: string;
  latestReviews?: Array<{ author?: { login?: string }; state?: string }>;
  statusCheckRollup?: Array<{ __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
  mergedBy?: { login?: string } | null;
  createdAt?: string;
  headRepositoryOwner?: { login?: string } | null;
}

/** One check, as passed, failed or still pending, in gh's own buckets (`gh pr checks`): a stale one is pending. */
const checkOf = (entry: NonNullable<GhPr["statusCheckRollup"]>[number]): PrCheck => {
  const name = entry.name || entry.context || "check";
  if (entry.__typename === "StatusContext" || entry.state) {
    const state = (entry.state ?? "").toUpperCase();
    return { name, result: state === "SUCCESS" ? "pass" : state === "FAILURE" || state === "ERROR" ? "fail" : "pending" };
  }
  if ((entry.status ?? "").toUpperCase() !== "COMPLETED") return { name, result: "pending" };
  const conclusion = (entry.conclusion ?? "").toUpperCase();
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") return { name, result: "pass" };
  if (conclusion === "STALE") return { name, result: "pending" };
  return { name, result: "fail" };
};

/**
 * What gh says about a pull request, as the room keeps it. The review is GitHub's decision; where it gives none (no
 * review required), the reviews themselves: changes requested by anyone, else an approval. Its reviewer is the
 * last one whose review is that decision.
 */
export const prStatus = (pr: GhPr): PrStatus => {
  const decision = (pr.reviewDecision ?? "").toUpperCase();
  const reviews = pr.latestReviews ?? [];
  const state =
    decision === "APPROVED" || decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED"
      ? decision
      : reviews.some((entry) => entry.state === "CHANGES_REQUESTED")
        ? "CHANGES_REQUESTED"
        : reviews.some((entry) => entry.state === "APPROVED")
          ? "APPROVED"
          : "";
  const reviewer = reviews.filter((entry) => entry.state === state).at(-1)?.author?.login;
  return {
    title: pr.title,
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open",
    mergeable: pr.mergeable === "MERGEABLE" ? "yes" : pr.mergeable === "CONFLICTING" ? "conflicts" : "unknown",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    head: pr.headRefName ?? "",
    base: pr.baseRefName ?? "",
    checks: (pr.statusCheckRollup ?? []).map(checkOf),
    review: state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "changes" : state === "REVIEW_REQUIRED" ? "required" : null,
    ...(reviewer ? { reviewer } : {}),
    ...(pr.mergedBy?.login ? { mergedBy: pr.mergedBy.login } : {}),
  };
};

/**
 * A pull request by its URL, or by its number or branch in `repo`: always in the repository named, never in the
 * one gh would guess for the folder (a fork's upstream).
 */
export const viewPr = async (
  cwd: string,
  env: NodeJS.ProcessEnv,
  ref: string,
  repo: string,
): Promise<{ number: number; url: string; status: PrStatus; createdAt?: string; headOwner?: string }> => {
  const pr = JSON.parse(await gh(cwd, ["pr", "view", ref, ...(ref.startsWith("https://") ? [] : ["--repo", repo]), "--json", PR_FIELDS], env)) as GhPr;
  const headOwner = pr.headRepositoryOwner?.login;
  return { number: pr.number, url: pr.url, status: prStatus(pr), ...(pr.createdAt ? { createdAt: pr.createdAt } : {}), ...(headOwner ? { headOwner } : {}) };
};

/** Where the checks stand: all passed, some failed, or still running (null when there are none). */
export const checksResult = (checks: PrCheck[]): "pass" | "fail" | "pending" | null =>
  !checks.length ? null : checks.some((check) => check.result === "pending") ? "pending" : checks.some((check) => check.result === "fail") ? "fail" : "pass";

/** What the room is to its GitHub watch: its state, and how to record and say things. */
export interface GithubHost {
  state(): RoomState;
  env: NodeJS.ProcessEnv;
  append(event: RoomEventBody): void;
  /** A quiet line for the human (see prompts' forHumanOnly). */
  note(text: string, sys: SystemNote): void;
  log(line: string): void;
  /** Whether someone has the room open: without a pull request still open, gh and git are asked only then. */
  viewed(): boolean;
  /** Why nothing may be pushed now (a turn is running in the folder), else null. */
  busy(): string | null;
}

/** Why the human cannot open a pull request now. */
export class GithubUnavailable extends Error {}

const live = (pr: PrState): boolean => !pr.status || pr.status.state === "open" || pr.status.state === "draft";

/** A command that may have moved the folder's branch or its remote. */
const movesBranch = (command: string): boolean => /\bgit\b[^\n;&|]*\b(?:checkout|switch|branch|push|remote)\b|\bgh\s+(?:pr|repo)\b/.test(command);

/** A room open in the UI is asked again at most this often. */
const LOOK_MS = 10_000;
/** How far GitHub's clock may be from this one: a pull request made before the turn, by more than this, is older. */
const CLOCK_SKEW_MS = 120_000;
/** The commands and links remembered as done: the oldest are forgotten past this. */
const REMEMBERED = 1_000;
/** How often the pull request an agent's command opened is looked up when gh could not tell. */
const LOOKUP_TRIES = 3;
/** gh found no such pull request (rather than not being able to ask). */
const NO_PR = /no pull requests found|Could not resolve to a PullRequest/i;
/** The closed pull requests asked about while someone looks (they can be reopened): the latest ones. */
const CLOSED_ASKED = 5;

const remember = <T>(set: Set<T>, key: T): void => {
  set.add(key);
  if (set.size > REMEMBERED) set.delete(set.values().next().value as T);
};

/**
 * GitHub in one room. It records the repository when gh is signed in and the folder has a github.com remote, and
 * forgets it when either goes; a pull request an agent opened with `gh pr create`, or linked in a message, of the
 * room's branch; then, while it is open, what gh says of it: its checks, review and merge come as quiet lines for
 * the human. A push of an agent's that rewrote a remote branch, as git said in its output, is shown as the risky
 * step it is. The human opens a pull request through gh signed in as them. Nothing else.
 */
export class RoomGithub {
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private lastPoll = 0;
  private readonly handled = new Set<string>();
  private readonly asked = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  /** The pull requests agents' commands are opening, still being looked up: a link to one waits for them. */
  private opening: Promise<unknown> = Promise.resolve();
  /** Looks at the folder, one at a time: a slow one finishing after a newer one would record what no longer is. */
  private seeing: Promise<unknown> = Promise.resolve();
  /** Default branches gh told, by repository, for a remote git does not know the default branch of. */
  private readonly defaults = new Map<string, { at: number; base?: string }>();
  /** Each remote's push URL, as git last said: whose push a `To <url>` in a command's output is. */
  private urls: Record<string, string> = {};
  private closed = false;
  /** gh asked again later about a pull request an agent opened: not after the room closes. */
  private readonly retries = new Set<NodeJS.Timeout>();
  /** git or gh could not tell, the last time the folder was looked at: no repository may yet be one. */
  private unsure = false;

  constructor(
    private readonly host: GithubHost,
    private readonly pollMs: number,
  ) {}

  private get cwd() {
    return this.host.state().workspace;
  }

  private get repo() {
    return this.host.state().repo;
  }

  private track<T>(work: Promise<T>): void {
    const tracked = work.then(
      () => undefined,
      (error) => this.host.log(`github: ${error instanceof Error ? error.message : String(error)}`),
    );
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  /** For tests: until what was started has come back. */
  async settled(): Promise<void> {
    while (this.pending.size || this.polling) await Promise.all([...this.pending, this.polling]);
  }

  /** The folder's repository as it is now, recorded when it shows, changes or goes; null without gh or a github.com remote. */
  see(): Promise<RepoState | null> {
    const next = this.seeing.then(() => this.seeNow());
    this.seeing = next.catch(() => undefined);
    return next;
  }

  private async seeNow(): Promise<RepoState | null> {
    const found = await readRepo(this.cwd, this.host.state().worktree?.base);
    this.unsure = found === undefined;
    // git could not tell: what the room knew stands.
    if (found === undefined || this.closed) return this.repo ?? null;
    if (found) this.urls = found.urls;
    const ready = found ? await ghReady(this.host.env) : false;
    this.unsure = ready === undefined;
    if (this.closed) return null;
    const current = this.repo;
    // gh could not tell (offline, slow): whether it is signed in stands as the room knew it; what git says of the
    // folder (its branch, its remote) is still recorded.
    if (ready === undefined && !current) return null;
    if (!found || ready === false) {
      if (current) this.host.append({ type: "repo.gone" });
      return null;
    }
    // Neither git nor gh can tell the base now: the one known for this repository stands.
    const base = found.base ?? (await this.defaultBranch(found.repo)) ?? (current?.repo === found.repo ? current.base : undefined);
    if (this.closed) return null;
    const { urls: _urls, ...known } = found;
    const seen = { ...known, ...(base ? { base } : {}) };
    if (!current || current.repo !== seen.repo || current.remote !== seen.remote || current.branch !== seen.branch || current.base !== seen.base) {
      this.host.append({ type: "repo.seen", ...seen });
    }
    this.schedule();
    return this.repo ?? null;
  }

  /** At the room's opening. */
  start(): void {
    this.track(this.see());
  }

  /** An agent's command: a pull request opened, a push that rewrote a remote branch, a branch that may have moved. */
  command(agent: RoomAgent, turnId: string, activity: Activity): void {
    // Done, whether or not it exited 0: `git push -f && npm test` pushed even when the tests failed.
    if (this.closed || activity.kind !== "command" || activity.status === "running") return;
    const command = activity.command ?? activity.label;
    const opens = prCreate(command);
    const pushes = gitPushes(command);
    if (!opens && !pushes.some((push) => !push.dry) && !movesBranch(command)) return;
    const key = `${turnId} ${activity.id}`;
    if (this.handled.has(key)) return;
    remember(this.handled, key);
    const repo = this.repo;
    // What the push did, as git said it in this command's own output: nobody else's push or fetch is put on it.
    const forced = repo ? forcePushed(pushes, activity.output, { ...repo, urls: this.urls }, activity.status !== "ok", activity.outputCut) : null;
    const pushed = joinedPushes(pushes);
    if (forced?.said.length) {
      this.host.note(`${agent.label} force-pushed ${forced.said.join(", ")}: ${pushed}`, { code: "git.force_pushed", agent: agent.label, command: pushed, refs: forced.said });
    }
    if (forced?.unsaid) {
      const tried = forced.failed ? `, or tried to (${forced.failed === "command" ? "the command failed" : "git printed an error"}; git did not say whether it rewrote history)` : " (git did not say whether it rewrote history)";
      this.host.note(`${agent.label} pushed with force to ${forced.unsaid.join(", ") || "its remote"}${tried}: ${pushed}`, {
        code: "git.force_pushed",
        agent: agent.label,
        command: pushed,
        refs: forced.unsaid,
        rewrote: false,
        ...(forced.failed ? { failed: forced.failed } : {}),
      });
    }
    const startedAt = Date.parse(this.host.state().turns.find((turn) => turn.id === turnId)?.startedAt ?? "");
    const looked = this.see().then((seen) => (opens ? this.opened({ agent, turnId, activity, opens, startedAt }, seen, LOOKUP_TRIES) : undefined));
    if (opens) this.opening = Promise.all([this.opening, looked]).catch(() => undefined);
    this.track(looked);
  }

  /** Which pull request an agent's `gh pr create` opened, if any; gh not able to tell is asked again later, `tries` times. */
  private async opened(
    run: { agent: RoomAgent; turnId: string; activity: Activity; opens: NonNullable<ReturnType<typeof prCreate>>; startedAt: number },
    seen: RepoState | null,
    tries: number,
  ): Promise<void> {
    const { agent, turnId, activity, opens, startedAt } = run;
    const again = () => {
      if (tries <= 1 || this.closed) return;
      const timer = setTimeout(() => {
        this.retries.delete(timer);
        if (!this.closed) this.track(this.see().then((next) => this.opened(run, next, tries - 1)));
      }, GH_UNSURE_MS);
      timer.unref();
      this.retries.add(timer);
    };
    if (this.closed) return;
    if (!seen) {
      // No repository known yet because git or gh could not tell.
      if (this.unsure) again();
      return;
    }
    // Another repository's (a fork's upstream) is not the room's.
    if (opens.repo && opens.repo !== seen.repo.toLowerCase()) return;
    const output = activity.output ?? "";
    // gh refused, the branch already has one (`|| true` hid it): it opened none.
    if (ALREADY_OPEN.test(output)) return;
    // Which one it opened: the URL gh printed, else the open pull request of the branch it named — not after a
    // command that failed without printing one (gh refused, or never ran).
    const printed = prLinks(output, seen.repo)[0]?.url;
    const head = opens.head ?? seen.branch;
    if (!printed && (!head || activity.status !== "ok")) return;
    let found: Awaited<ReturnType<typeof viewPr>>;
    try {
      found = await viewPr(this.cwd, this.host.env, printed ?? head!, seen.repo);
    } catch (error) {
      if (!NO_PR.test(error instanceof Error ? error.message : "")) again();
      throw error;
    }
    if (this.closed) return;
    // One made before this turn is not the one it opened.
    if (found.createdAt && Number.isFinite(startedAt) && Date.parse(found.createdAt) < startedAt - CLOCK_SKEW_MS) return;
    if (!printed) {
      // Not one of the branch's old ones, merged or closed long ago.
      if (!(found.status.head === head && (found.status.state === "open" || found.status.state === "draft"))) return;
      // Of this repository's branch, not a fork's of the same name.
      const owner = opens.owner ?? seen.repo.split("/")[0]!;
      if (found.headOwner && found.headOwner.toLowerCase() !== owner.toLowerCase()) return;
    }
    this.add(found, agent.id, "opened", turnId);
  }

  /** An agent's message: a pull request of the room's branch it links to (in its own words, not in code or a quote). */
  message(entry: MessageEntry): void {
    const repo = this.repo;
    if (this.closed || !repo?.branch || (entry.kind !== "agent" && entry.kind !== "update")) return;
    const links = prLinks(prose(entry.text), repo.repo).filter(({ url }) => !this.known(url) && !this.asked.has(url.toLowerCase()));
    for (const { url } of links) remember(this.asked, url.toLowerCase());
    // After what the agents' commands opened is in: one an agent opened and then linked is the one it opened.
    for (const { url } of links) {
      this.track(
        this.opening.then(async () => {
          if (this.closed || this.known(url)) return;
          let found: Awaited<ReturnType<typeof viewPr>>;
          try {
            found = await viewPr(this.cwd, this.host.env, url, repo.repo);
          } catch (error) {
            // Asked again when it is linked again.
            this.asked.delete(url.toLowerCase());
            throw error;
          }
          // One of another branch is only mentioned: not the room's.
          if (!this.closed && found.status.head === this.repo?.branch) this.add(found, entry.author, "linked", entry.turnId);
        }),
      );
    }
  }

  /** The remote's default branch, as gh knows it (asked again after a minute when it could not tell; now when `fresh`). */
  private async defaultBranch(repo: string, fresh = false): Promise<string | undefined> {
    const known = this.defaults.get(repo);
    if (known && (known.base || (!fresh && Date.now() - known.at < GH_READY_MS))) return known.base;
    let base: string | undefined;
    try {
      base = (await gh(this.cwd, ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], this.host.env)).trim() || undefined;
    } catch {
      base = undefined;
    }
    this.defaults.set(repo, { at: Date.now(), ...(base ? { base } : {}) });
    return base;
  }

  /** What the human's "Open PR" would do now, or why it can't. Nothing is pushed. */
  async plan(): Promise<PrPlan> {
    const repo = await this.see();
    if (!repo) throw new GithubUnavailable("this folder has no GitHub remote, or gh is not signed in to github.com");
    const branch = repo.branch;
    if (!branch) throw new GithubUnavailable("the folder is not on a branch");
    const base = repo.base ?? (await this.defaultBranch(repo.repo, true));
    if (!base) throw new GithubUnavailable(`neither git nor gh can tell ${repo.repo}'s default branch to open the pull request into`);
    // gh told it only now: the room records it.
    if (!repo.base) await this.see();
    if (branch === base) throw new GithubUnavailable(`the folder is on ${branch}, the base branch: a pull request needs a branch of its own`);
    // A closed one may have been reopened since gh was last asked.
    for (const pr of (this.host.state().prs ?? []).filter((entry) => entry.status?.state === "closed" && entry.status.head === branch)) {
      try {
        this.update(pr.number, (await viewPr(this.cwd, this.host.env, pr.url, repo.repo)).status);
      } catch (error) {
        this.host.log(`github: #${pr.number} not read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const already = this.host.state().prs?.find((pr) => live(pr) && pr.status?.head === branch);
    if (already) throw new GithubUnavailable(`pull request #${already.number} is already open for ${branch}`);
    // One the room doesn't know (opened from a terminal, another room): nothing is pushed for a pull request gh would
    // refuse. gh finding none, or not able to tell, is left to gh pr create.
    const elsewhere = await viewPr(this.cwd, this.host.env, branch, repo.repo).catch(() => null);
    if (
      elsewhere &&
      (elsewhere.status.state === "open" || elsewhere.status.state === "draft") &&
      elsewhere.status.head === branch &&
      (!elsewhere.headOwner || elsewhere.headOwner.toLowerCase() === repo.repo.split("/")[0]!.toLowerCase())
    ) {
      throw new GithubUnavailable(`pull request #${elsewhere.number} is already open for ${branch}: ${elsewhere.url}`);
    }
    const sha = await git(this.cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (!sha) throw new GithubUnavailable(`${branch} has no commits yet`);
    const counted = await git(this.cwd, ["rev-list", "--count", `refs/remotes/${repo.remote}/${base}..HEAD`]);
    const ahead = counted !== null && /^\d+$/.test(counted) ? Number(counted) : undefined;
    if (ahead === 0) throw new GithubUnavailable(`${branch} has no commits that ${repo.remote}/${base} does not have: there is nothing for a pull request`);
    // Where git pushes when that is not the repository on GitHub (a pushurl, a pushInsteadOf): the human sees it first.
    const pushUrl = await git(this.cwd, ["remote", "get-url", "--push", repo.remote]);
    const pushesTo = pushUrl && githubRepo(pushUrl)?.toLowerCase() !== repo.repo.toLowerCase() ? shownUrl(pushUrl) : undefined;
    return { repo: repo.repo, remote: repo.remote, branch, base, sha, ...(ahead !== undefined ? { ahead } : {}), ...(pushesTo ? { pushUrl: pushesTo } : {}) };
  }

  /**
   * The human's "Open PR": push the commit they were shown to its branch and open a pull request with gh, signed in as
   * them — only if the folder is still at the branch and commit they were shown, going where they were shown (`seen`),
   * and no turn is running.
   */
  async open(by: string, seen: Partial<PrPlan>): Promise<PrState> {
    const plan = await this.plan();
    if (seen.branch !== plan.branch || seen.sha !== plan.sha) {
      throw new GithubUnavailable(`the folder moved on since you looked: it is now ${plan.branch} at ${plan.sha.slice(0, 7)} — look again`);
    }
    // Where it goes, as the human saw it: all of it, a push URL they were not shown included.
    const where = ["repo", "remote", "base", "pushUrl"] as const;
    if (where.some((key) => key in seen) && where.some((key) => seen[key] !== plan[key])) {
      throw new GithubUnavailable(`where it goes changed since you looked: now ${plan.remote}${plan.pushUrl ? ` (${plan.pushUrl})` : ""}, into ${plan.base} on ${plan.repo} — look again`);
    }
    // A turn that began while gh was asked could still be committing.
    const busy = this.host.busy();
    if (busy) throw new GithubUnavailable(busy);
    // That commit, whatever the branch has become since.
    const pushed = await run("git", this.cwd, ["push", plan.remote, `${plan.sha}:refs/heads/${plan.branch}`], { ...this.host.env, GIT_TERMINAL_PROMPT: "0" }, 120_000);
    if (!pushed.ok) throw new GhError(pushed.err.split("\n").slice(-3).join("\n") || "git push failed");
    // Its upstream, unless it has one.
    if (!(await git(this.cwd, ["config", `branch.${plan.branch}.remote`]))) await git(this.cwd, ["branch", `--set-upstream-to=${plan.remote}/${plan.branch}`, plan.branch]);
    let url: string | undefined;
    try {
      const out = await gh(this.cwd, ["pr", "create", "--repo", plan.repo, "--fill", "--head", plan.branch, "--base", plan.base], this.host.env, 60_000);
      url = prLinks(out, plan.repo)[0]?.url;
    } catch (error) {
      // gh refused: the branch already has one, opened since gh was asked. It is not the human's.
      const said = error instanceof Error ? error.message : "";
      const theirs = ALREADY_OPEN.test(said) ? prLinks(said, plan.repo)[0]?.url : undefined;
      if (theirs) throw new GithubUnavailable(`pushed ${plan.branch} at ${plan.sha.slice(0, 7)}, but it already has an open pull request: ${theirs}`);
      throw error;
    }
    const found = await viewPr(this.cwd, this.host.env, url ?? plan.branch, plan.repo);
    if (this.known(found.url)) this.update(found.number, found.status);
    else this.add(found, by, "opened");
    return this.host.state().prs!.find((pr) => pr.number === found.number)!;
  }

  /** Ask gh again about the open pull requests (and git about the branch); `always`: even with none open and nobody looking. */
  poll(always = false): Promise<void> {
    this.polling ??= this.pollOnce(always).finally(() => {
      this.polling = undefined;
      this.schedule();
    });
    return this.polling;
  }

  /** The room was opened in the UI: ask again, unless that was just done. */
  look(): void {
    if (this.closed || Date.now() - this.lastPoll < LOOK_MS) return;
    this.track(this.poll(true));
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  private async pollOnce(always: boolean): Promise<void> {
    if (this.closed) return;
    const viewed = always || this.host.viewed();
    // Nobody looking and nothing open: git and gh are not asked.
    if (!viewed && !(this.host.state().prs ?? []).some(live)) return;
    this.lastPoll = Date.now();
    const repo = await this.see();
    if (!repo) return;
    // The open ones; the latest closed ones too while someone looks, for they can be reopened. A merged one stays merged.
    const prs = this.host.state().prs ?? [];
    const closed = viewed ? prs.filter((pr) => pr.status?.state === "closed").slice(-CLOSED_ASKED) : [];
    const asked = prs.filter((pr) => live(pr) || closed.includes(pr));
    for (const pr of asked) {
      let found: Awaited<ReturnType<typeof viewPr>>;
      try {
        found = await viewPr(this.cwd, this.host.env, pr.url, repo.repo);
      } catch (error) {
        this.host.log(`github: #${pr.number} not read: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (this.closed) return;
      this.update(pr.number, found.status);
    }
  }

  private known(url: string): boolean {
    return Boolean(this.host.state().prs?.some((pr) => pr.url.toLowerCase() === url.toLowerCase()));
  }

  private add(found: { number: number; url: string; status: PrStatus }, by: string, via: "opened" | "linked", turnId?: string): void {
    if (this.closed || this.known(found.url)) return;
    this.host.append({ type: "pr.linked", number: found.number, url: found.url, by, ...(via === "linked" ? { via } : {}), ...(turnId ? { turnId } : {}) });
    this.host.append({ type: "pr.status", number: found.number, status: found.status });
    this.schedule();
  }

  /** A new status; what changed since the last one comes as a quiet line (the first one is where it started). */
  private update(number: number, status: PrStatus): void {
    if (this.closed) return;
    const before = this.host.state().prs?.find((pr) => pr.number === number)?.status;
    if (before && JSON.stringify(before) === JSON.stringify(status)) return;
    this.host.append({ type: "pr.status", number, status });
    if (!before) return;
    const was = checksResult(before.checks);
    const now = checksResult(status.checks);
    if ((now === "pass" || now === "fail") && now !== was) {
      const failed = status.checks.filter((check) => check.result === "fail").map((check) => check.name);
      this.host.note(
        now === "pass"
          ? `PR #${number}: ${status.checks.length === 1 ? "the check" : `all ${status.checks.length} checks`} passed.`
          : `PR #${number}: ${failed.length} of ${status.checks.length} checks failed — ${failed.join(", ")}.`,
        { code: "pr.checks", n: number, result: now, ...(now === "fail" ? { failed } : {}), total: status.checks.length },
      );
    }
    if ((status.review === "approved" || status.review === "changes") && status.review !== before.review) {
      const who = status.reviewer ? ` by ${status.reviewer}` : "";
      this.host.note(status.review === "approved" ? `PR #${number} approved${who}.` : `PR #${number}: changes requested${who}.`, {
        code: "pr.review",
        n: number,
        review: status.review,
        ...(status.reviewer ? { by: status.reviewer } : {}),
      });
    }
    if (status.state === "merged" && before.state !== "merged") {
      this.host.note(`PR #${number} merged into ${status.base}${status.mergedBy ? ` by ${status.mergedBy}` : ""}.`, {
        code: "pr.merged",
        n: number,
        base: status.base,
        ...(status.mergedBy ? { by: status.mergedBy } : {}),
      });
    } else if (status.state === "closed" && before.state !== "closed") {
      this.host.note(`PR #${number} closed without merging.`, { code: "pr.closed", n: number });
    } else if ((status.state === "open" || status.state === "draft") && before.state === "closed") {
      this.host.note(`PR #${number} reopened.`, { code: "pr.reopened", n: number });
    }
  }

  /** Asked again while the room has a GitHub repository; pollOnce decides whether there is anything to ask. */
  private schedule(): void {
    if (this.closed || this.pollMs <= 0 || this.timer || !this.repo) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref();
  }
}
