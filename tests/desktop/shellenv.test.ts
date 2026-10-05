import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { AGENT_KEY_ENV } from "../../internal/agora/actor.js";
import { pidAlive } from "../../internal/agora/daemoninfo.js";
import { TURN_FILE_ENV } from "../../internal/agora/turn-context.js";
import {
  desktopEnv,
  fallbackPath,
  findExecutable,
  mergeShellEnv,
  parseShellEnvOutput,
  probeLoginShell,
  TURN_ENV_VARS,
} from "../../internal/desktop/shellenv.js";

const scratch = mkdtempSync(join(tmpdir(), "agoryx-shellenv-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A fake login shell: `<shell> -i -l -c <command>` runs the script with the command as its last argument. */
const fakeShell = (name: string, body: string): string => {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\nfor last; do :; done\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

/** What a probe's environment starts with: no values from this machine but a minimal PATH. */
const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: "/usr/bin:/bin", HOME: scratch, ...extra });

const MARKERS = { start: "__AGORYX_ENV_0123456789abcdef_START__", end: "__AGORYX_ENV_0123456789abcdef_END__" };

test("the env between the markers is read; rc noise around it, functions and junk entries are not", () => {
  const output = [
    "Last login: Mon Sep 29 09:00:00 on ttys001\n",
    "HALF=before-the-marker\0",
    // an echoed command line (set -v, a plugin) holds the marker only in halves
    "printf '%s%s' '__AGORYX_ENV_0123' '456789abcdef_START__'\n",
    MARKERS.start,
    "PATH=/opt/homebrew/bin:/usr/bin\0",
    "MULTI=line one\nline two\0",
    "EQUALS=a=b=c\0",
    "EMPTY=\0",
    "BASH_FUNC_greet%%=() {  echo hi\n}\0",
    "no equals sign\0",
    "=nameless\0",
    MARKERS.end,
    "\nrc output after the command\n",
    "AFTER=the-marker\0",
  ].join("");
  assert.deepEqual(parseShellEnvOutput(output, MARKERS), {
    PATH: "/opt/homebrew/bin:/usr/bin",
    MULTI: "line one\nline two",
    EQUALS: "a=b=c",
    EMPTY: "",
  });
});

test("no start marker, or no end marker after it: nothing is read", () => {
  assert.equal(parseShellEnvOutput("PATH=/usr/bin\0", MARKERS), null);
  assert.equal(parseShellEnvOutput(`${MARKERS.start}PATH=/usr/bin\0`, MARKERS), null);
  assert.equal(parseShellEnvOutput(`${MARKERS.end}${MARKERS.start}PATH=/usr/bin\0`, MARKERS), null);
  assert.deepEqual(parseShellEnvOutput(`${MARKERS.start}${MARKERS.end}`, MARKERS), {});
});

test("merge: the shell's whole env over the app's, minus what describes the probing shell and the turn variables", () => {
  const base: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin:/usr/sbin",
    HOME: "/Users/me",
    PWD: "/",
    FROM_APP: "kept",
    SHARED: "app",
    AGORYX_ROOM: "a-room-from-the-app",
    [AGENT_KEY_ENV]: "a-key-from-the-app",
  };
  const shell: Record<string, string> = {
    PATH: "/opt/homebrew/bin:/Users/me/.local/bin:/usr/bin::/opt/homebrew/bin",
    SHARED: "shell",
    SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners",
    LANG: "uk_UA.UTF-8",
    CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
    NVM_DIR: "/Users/me/.nvm",
    PWD: "/Users/me",
    OLDPWD: "/Users/me/src",
    SHLVL: "2",
    _: "/usr/bin/env",
    TERM_SESSION_ID: "w0t0p0",
    TERM_PROGRAM: "iTerm.app",
    TERM_PROGRAM_VERSION: "3.5",
    ITERM_SESSION_ID: "w0t0p0:1",
    TMUX: "/tmp/tmux-501/default,1,0",
    TMUX_PANE: "%1",
    PS1: "%n@%m %~ %# ",
    PROMPT: "%# ",
    PROMPT_COMMAND: "update_title",
    AGORYX_TURN: "t9",
    [TURN_FILE_ENV]: "/tmp/turn.json",
  };
  const merged = mergeShellEnv(base, shell);
  assert.equal(merged.PATH, ["/opt/homebrew/bin", "/Users/me/.local/bin", "/usr/bin", "/bin", "/usr/sbin"].join(delimiter));
  assert.equal(merged.SHARED, "shell");
  assert.equal(merged.FROM_APP, "kept");
  assert.equal(merged.SSH_AUTH_SOCK, "/private/tmp/launchd/Listeners");
  assert.equal(merged.LANG, "uk_UA.UTF-8");
  assert.equal(merged.CLAUDE_CONFIG_DIR, "/Users/me/.claude-work");
  assert.equal(merged.NVM_DIR, "/Users/me/.nvm");
  assert.equal(merged.PWD, "/", "the app's own PWD is not the shell's to change");
  for (const key of ["OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "ITERM_SESSION_ID", "TMUX", "TMUX_PANE", "PS1", "PROMPT", "PROMPT_COMMAND"]) {
    assert.equal(merged[key], undefined, key);
  }
  for (const key of TURN_ENV_VARS) assert.equal(merged[key], undefined, key);
  assert.equal(base.AGORYX_ROOM, "a-room-from-the-app", "the base is not modified");
});

test("the turn variables are the room's: its turn file, room, agent, turn, seen, ops, table and key", () => {
  assert.deepEqual(
    [...TURN_ENV_VARS].sort(),
    [TURN_FILE_ENV, "AGORYX_ROOM", "AGORYX_ROOM_NAME", "AGORYX_AGENT", "AGORYX_TURN", "AGORYX_SEEN", "AGORYX_OPS_DIR", "AGORYX_TABLE", AGENT_KEY_ENV].sort(),
  );
});

test("fallback PATH: the install folders that exist go first, once, then the app's PATH", () => {
  const home = join(scratch, "fallback-home");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  mkdirSync(join(home, ".bun", "bin"), { recursive: true });
  const path = fallbackPath({ HOME: home, PATH: `/usr/bin${delimiter}/bin` }).split(delimiter);
  assert.deepEqual(path.slice(-2), ["/usr/bin", "/bin"]);
  assert.ok(path.indexOf(join(home, ".local", "bin")) < path.indexOf(join(home, ".bun", "bin")));
  assert.ok(path.includes(join(home, ".local", "bin")));
  assert.ok(!path.includes(join(home, ".cargo", "bin")), "a folder that does not exist is not added");
  assert.equal(new Set(path).size, path.length);

  const already = fallbackPath({ HOME: home, PATH: [join(home, ".local", "bin"), "/usr/bin"].join(delimiter) }).split(delimiter);
  assert.equal(already.filter((dir) => dir === join(home, ".local", "bin")).length, 1);
  assert.deepEqual(already.slice(-2), [join(home, ".local", "bin"), "/usr/bin"]);
});

test("findExecutable: a path is itself when executable; a name is the first executable file in PATH", () => {
  const first = join(scratch, "bin-first");
  const second = join(scratch, "bin-second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const write = (dir: string, name: string, mode: number) => {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), mode);
    return join(dir, name);
  };
  write(first, "plain", 0o644);
  const plainExec = write(second, "plain", 0o755);
  const tool = write(first, "tool", 0o755);
  write(second, "tool", 0o755);
  mkdirSync(join(first, "folder"), { recursive: true });
  const env = { PATH: ["relative/bin", "", first, second].join(delimiter) };
  assert.equal(findExecutable("tool", env), tool);
  assert.equal(findExecutable("plain", env), plainExec, "a file without the x bit is skipped");
  assert.equal(findExecutable("folder", env), null, "a folder is not an executable");
  assert.equal(findExecutable("missing", env), null);
  assert.equal(findExecutable(tool, { PATH: "" }), tool);
  assert.equal(findExecutable(join(first, "plain"), env), null);
  assert.equal(findExecutable("", env), null);
});

test("probe: the login shell's env comes back, whatever its rc files print around it", async () => {
  const shell = fakeShell(
    "noisy-shell",
    [
      'echo "Welcome to fake-shell"',
      "printf 'NOT=this\\0'",
      'printf \'%s\\n\' "$last"',
      "export FROM_RC=exported-by-rc",
      'eval "$last"',
      'echo "rc output after the command"',
    ].join("\n"),
  );
  const env = await probeLoginShell({ shell, env: baseEnv({ FROM_APP: "app-value" }), timeoutMs: 5000 });
  assert.ok(env);
  assert.equal(env.FROM_RC, "exported-by-rc");
  assert.equal(env.FROM_APP, "app-value");
  assert.ok(env.PATH);
  assert.equal(env.NOT, undefined);
});

test("probe: `$SHELL` of the given env is the default shell", async () => {
  const shell = fakeShell("default-shell", 'export PICKED=yes\neval "$last"');
  const env = await probeLoginShell({ env: baseEnv({ SHELL: shell }) });
  assert.equal(env?.PICKED, "yes");
});

test("probe: a shell that never answers is killed with what it started, within the timeout", async () => {
  const pids = join(scratch, "hang.pids");
  const shell = fakeShell("hanging-shell", `echo $$ > "${pids}"\nsleep 30 &\necho $! >> "${pids}"\nwait`);
  const started = Date.now();
  // Long enough for the script to have started (and written its pids) under a loaded full test run.
  const env = await probeLoginShell({ shell, env: baseEnv(), timeoutMs: 2000 });
  assert.equal(env, null);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
  const [shellPid, sleepPid] = readFileSync(pids, "utf8").trim().split("\n").map(Number);
  assert.ok(shellPid && sleepPid);
  const deadline = Date.now() + 3000;
  while ((pidAlive(shellPid) || pidAlive(sleepPid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(pidAlive(shellPid), false, "the shell");
  assert.equal(pidAlive(sleepPid), false, "its background job");
});

test("probe: stdin is not the app's (an rc file that reads it gets end-of-file, not a hang)", async () => {
  const shell = fakeShell("reading-shell", 'read answer\necho "read: $answer"\neval "$last"');
  const started = Date.now();
  const env = await probeLoginShell({ shell, env: baseEnv(), timeoutMs: 5000 });
  assert.ok(env?.PATH);
  assert.ok(Date.now() - started < 4000);
});

test("probe: the answer is taken as soon as it is complete, even if the shell lingers", async () => {
  const shell = fakeShell("lingering-shell", 'eval "$last"\nsleep 4');
  const started = Date.now();
  const env = await probeLoginShell({ shell, env: baseEnv(), timeoutMs: 5000 });
  assert.ok(env?.PATH);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

test("probe: no such shell, a relative one, no markers, or no PATH: null", async () => {
  assert.equal(await probeLoginShell({ shell: join(scratch, "no-such-shell"), env: baseEnv() }), null);
  assert.equal(await probeLoginShell({ shell: "sh", env: baseEnv() }), null);
  const silent = fakeShell("silent-shell", 'echo "I ignore commands"');
  assert.equal(await probeLoginShell({ shell: silent, env: baseEnv(), timeoutMs: 3000 }), null);
  const failing = fakeShell("failing-shell", "exit 3");
  assert.equal(await probeLoginShell({ shell: failing, env: baseEnv(), timeoutMs: 3000 }), null);
  const pathless = fakeShell("pathless-shell", 'unset PATH\neval "$last"');
  assert.equal(await probeLoginShell({ shell: pathless, env: baseEnv(), timeoutMs: 3000 }), null);
});

test("desktopEnv: the login shell's env when it answers, else the fallback PATH; never the turn variables", async () => {
  const shell = fakeShell("desktop-shell", 'export FROM_RC=1\nexport PATH="/from/rc:$PATH"\neval "$last"');
  const base = baseEnv({ AGORYX_ROOM: "room", AGORYX_AGENT: "codex", [AGENT_KEY_ENV]: "key" });

  const fromShell = await desktopEnv(base, { shell });
  assert.equal(fromShell.source, "login-shell");
  assert.equal(fromShell.env.FROM_RC, "1");
  assert.equal(fromShell.env.PATH?.split(delimiter)[0], "/from/rc");
  for (const key of TURN_ENV_VARS) assert.equal(fromShell.env[key], undefined, key);

  const fallback = await desktopEnv(base, { shell: join(scratch, "no-such-shell") });
  assert.equal(fallback.source, "fallback");
  assert.equal(fallback.env.PATH, fallbackPath(base));
  assert.equal(fallback.env.HOME, scratch);
  for (const key of TURN_ENV_VARS) assert.equal(fallback.env[key], undefined, key);
  assert.equal(base.AGORYX_ROOM, "room", "the base is not modified");
});
