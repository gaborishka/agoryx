# macOS desktop shell — v1 (daemon owner, login-shell env, doctor)

> **Archived design — not current instructions.** This document preserves an earlier proposal or implementation record. Versions, status claims and task lists below describe that period, not the Agoryx 0.1.0 release. Use the [current documentation](../../README.md) and source for implemented behavior.


Status: in progress (2026-09-29). Inspired by T3 Code (backend supervision, login-shell PATH probe) and
Cumora (`--doctor`, first-run screen that clears itself). Research summary: this session's answer to Ivan.

## Goal

`Agoryx.app` opened from Finder/Dock works exactly like `agoryx up` + `agoryx open` from a terminal:
the same daemon (same `AGORYX_HOME`, same `daemon.json`, same rooms), the same environment the agents
would get from a terminal, and a clear screen telling what is missing when a tool is not there.

Out of scope for v1 (next steps): notifications / menu-bar icon / Dock badge, launchd service,
`agoryx open .` control socket, custom `agoryx://` scheme, shared browser pane, notarization.

## Key constraints found in the code

- The daemon is one per `AGORYX_HOME`: it writes `<agoraHome>/daemon.json` (pid, port, url, token) and
  answers `GET /api/health` → `{ ok, pid, version }`. `findDaemon()` in `internal/agora/daemon.ts` checks both.
- The UI logs in with `GET /?t=<token>` → HttpOnly cookie; after that plain same-origin fetches.
  Host header must be `127.0.0.1:<port>` / `localhost:<port>`; non-GET with a foreign Origin is refused.
- Agents call back through a shim `<agoraHome>/bin/agoryx` that execs **`process.execPath`** of the daemon.
  better-sqlite3 is a native module built for the user's Node ABI.
  ⇒ **The daemon must run under the user's real `node` (>= 22), never under Electron
  (`ELECTRON_RUN_AS_NODE`)**, or the shim would launch Electron and the native module would not load.
  ⇒ **Electron main must never import a module whose import graph reaches better-sqlite3**
  (`daemon.ts`, `store.ts`, `engine.ts`, `service.ts`, …).
- Runners look up `claude` / `codex` on PATH (overridable with `AGORYX_CLAUDE_BIN` / `AGORYX_CODEX_BIN`).
  A Finder-launched app has PATH `/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew, no `~/.local/bin`.
- `claude auth status` prints JSON with `loggedIn` (and the account email — never print the email).
  `codex login status` exits 0 when logged in.
- Rooms are long-running; quitting the app must not kill running turns. The daemon is started detached
  (like `agoryx up --detach`) and outlives the app; "Stop Daemon and Quit" stops it explicitly via `POST /api/down`.

## Part A — core, `internal/desktop/` (dependency-light, reused by CLI and app)

Every module here may import only `node:*` built-ins and other dependency-free modules
(`internal/agora/paths.ts`, `internal/config/paths.ts`, `internal/agora/client.ts` types, and the new
`internal/agora/daemoninfo.ts`). A test walks the import graph and fails if `better-sqlite3`, `ink`, `react`
or any of `daemon.ts/store.ts/engine.ts/service.ts` is reachable.

1. `internal/agora/daemoninfo.ts` — move `readDaemonInfo()` and `findDaemon()` (and the `DaemonInfo` type)
   out of `daemon.ts`; `daemon.ts` re-exports them so every existing import keeps working.

2. `internal/desktop/shellenv.ts`
   - `probeLoginShell({ shell?, timeoutMs = 5000, env? }): Promise<Record<string,string> | null>` —
     runs the user's login shell (`$SHELL`, else `/bin/zsh`) interactive+login with a command that prints a
     random start marker, `env -0` (or `/usr/bin/env -0`), end marker; parses NUL-separated pairs between
     markers (rc files may print noise). Kills the shell on timeout; returns null on any failure. stdin ignored.
   - `mergeShellEnv(base, shell): NodeJS.ProcessEnv` — the app's env overlaid by the whole login-shell env
     (the daemon must see what a terminal `agoryx up` would see: PATH, SSH_AUTH_SOCK, LANG, CLAUDE_*/CODEX_*
     config dirs, API keys the user exported, nvm/volta vars…), minus per-shell transient vars
     (`PWD, OLDPWD, SHLVL, _, TERM_SESSION_ID, TERM_PROGRAM*, ITERM_*, TMUX*, PS1, PROMPT*`), minus
     Agoryx turn variables (same list as `daemonEnv()` in `cmd/agoryx/agora.ts`). PATH = shell PATH first,
     then any base entries not already present.
   - `fallbackPath(env)` — when the probe fails: prepend existing ones of `/opt/homebrew/bin`, `/usr/local/bin`,
     `~/.local/bin`, `~/.volta/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.cargo/bin` to PATH.
   - `desktopEnv(base = process.env): Promise<{ env, source: "login-shell" | "fallback" }>` — the two combined.
   - `findExecutable(name, env): string | null` — absolute name → itself if executable; otherwise scan PATH
     with `fs.accessSync(X_OK)`.

3. `internal/desktop/doctor.ts`
   - `type CheckStatus = "ok" | "warn" | "fail"`;
     `interface DoctorCheck { id; label; status; detail; fix?: string }` (`fix` = a command or one-line hint).
   - `runDoctor({ env, root, probe = false, timeoutMs }): Promise<DoctorCheck[]>` — never throws; each
     subprocess has a timeout. Checks, in order:
     - `node`: found via `findExecutable("node")`, `--version` >= 22 → ok; missing/old → **fail**
       (fix: `brew install node`).
     - `agoryx`: install root has `bin/agoryx.js`; `dist/cmd/agoryx/main.js` present (warn otherwise:
       `npm run build:core`); `ui/dist/index.html` present (warn: `npm run build:ui`).
     - `sqlite`: that `node` can `require("better-sqlite3")` from `root` (spawn it) → ok; else **fail**
       (fix: `npm rebuild better-sqlite3` in `root`). Catches Node ABI mismatch.
     - `claude`: binary = `AGORYX_CLAUDE_BIN` or `claude` on PATH; `--version`; `claude auth status` JSON
       `loggedIn` → ok "2.x (claude.ai)"; not logged in → warn (fix: run `claude` and `/login`);
       missing → warn (fix: `curl -fsSL https://claude.ai/install.sh | bash`). Never include the email.
     - `codex`: `AGORYX_CODEX_BIN` or `codex`; `--version`; `codex login status` exit 0 → ok; else warn
       (fix: `codex login`); missing → warn (fix: `brew install codex` or `npm i -g @openai/codex`).
     - `agents`: **fail** when neither claude nor codex is usable (found + logged in), ok otherwise.
     - `git`: found → ok; missing → warn (worktrees and change tracking need it; fix: `xcode-select --install`).
     - `home`: `agoraHome(env)` exists-or-creatable and writable → ok; else **fail**.
     - `daemon`: `findDaemon(env)` → ok "running at <url> (pid N)" or ok "not running" (informational).
     - with `probe`: one real trial call per logged-in agent (`claude -p "Reply with the single word OK"`,
       `codex exec --skip-git-repo-check "Reply with the single word OK"`), 90s timeout, reports seconds;
       failure → warn with the first lines of stderr.
   - `doctorVerdict(checks): CheckStatus` — worst status.
   - `formatDoctor(checks, { color }): string[]` — the CLI's lines (✓ / ! / ✗, detail, `fix:` line).

4. `internal/desktop/supervisor.ts` — `DaemonSupervisor` (EventEmitter), used by the app:
   - options `{ root, node, env, log?, pollMs = 3000, spawnImpl? (for tests) }`.
   - `start(): Promise<DaemonInfo>` — `findDaemon(env)`: attach if alive. Otherwise spawn
     `node <root>/bin/agoryx.js up` detached, stdio appended to `<agoraHome>/daemon.log`, `unref()`,
     wait up to 20s for `findDaemon`; early child exit or timeout → Error with the log tail (last 20 lines).
   - `watch()` — polls `findDaemon`. Same pid/port → nothing. Different live daemon (restarted from a
     terminal) → emit `"changed", info`. Gone and not stopping → emit `"down"`, restart with backoff
     0.5, 1, 2, 4, 8, 10s…; success → `"up", info`; 5 consecutive failed starts → `"failed", { message, logTail }`
     and stop retrying until `retry()`.
   - `restart()`, `retry()`, `stop(): Promise<void>` (POST `/api/down` with the token via `DaemonClient`,
     wait up to 15s for it to be gone; never signals a pid it has not verified), `dispose()` (stop polling
     only — leaves the daemon running).
   - `logPath()`, `logTail(n)`.
   - Never touches any daemon other than the one in `agoraHome(env)`.

5. CLI `agoryx doctor [--probe] [--json]` — runs `runDoctor` with the current process env and this install's
   root; prints `formatDoctor` (or JSON); exit 1 when the verdict is `fail`. Wire it like the other commands
   (usage text, `completions/agoryx.{bash,zsh,fish}`, `docs/man/agoryx.1`, `docs/AGORA.md` if it lists commands).

6. Tests `tests/desktop/*.test.ts` (node:test, like `tests/agora`): env parsing with noisy rc output and
   markers, merge rules (denylist, PATH order, turn vars dropped), fallback PATH, `findExecutable`, doctor
   with fake bins in a temp dir (versions, logged-in/out, missing, email never printed, verdict), supervisor
   against a real `bin/agoryx.js up` with a temp `AGORYX_HOME` and `--port 0`-style free port (start → attach
   → external stop → "down"/"up" restart → `stop()`), and the import-graph test. **Every test and manual
   run uses a temporary `AGORYX_HOME`; nothing may touch the user's real daemon in
   `~/.local/state/agoryx/agora`.**

## Part B — the app, `desktop/`

- `desktop/package.json` (private, `"main": "dist/main.js"`, `"type": "module"`), devDeps `electron`,
  `electron-builder`, `typescript`, `@types/node`; scripts `build` (tsc), `start` (build core + build + `electron .`),
  `dist` (build + electron-builder). `desktop/tsconfig.json` (NodeNext, strict, outDir dist).
  Root `package.json`: script `"desktop": "npm --prefix desktop start"`. `.gitignore`: `desktop/node_modules`,
  `desktop/dist`, `desktop/release`.
- `agoryxRoot()`: `AGORYX_ROOT` env → packaged `process.resourcesPath/agoryx` → dev: repo root (parent of
  `desktop/`). Core modules are loaded with dynamic `import()` of `<root>/dist/internal/desktop/*.js`.
- `desktop/src/main.ts`:
  - single-instance lock (second instance focuses the window); one main window 1280×860, min 900×600,
    bounds persisted in `userData/window.json`; standard title bar.
  - Start sequence shown on a local start page (`desktop/static/start.html|css|js`, strict CSP, no inline
    script) via a sandboxed CJS preload (`dist/preload.cjs`) exposing `window.agoryxDesktop`
    `{ onState(cb), retry(), openAnyway(), openLog(), runDoctor(probe) }`:
    1. "Reading your shell environment" → `desktopEnv()`.
    2. "Checking tools" → `runDoctor({ env, root })`.
    3. verdict fail → checks with fixes + Retry (no daemon start).
    4. "Starting Agoryx" → `supervisor.start()`; error → message + log tail + Retry / Open log.
    5. all ok → load `${url}/?t=${token}` directly; warnings → show them with "Open Agoryx" (the screen
       does not block on warnings once the user clicks; it reappears only when a check changes).
  - Supervisor events: `down` → start page "Agoryx stopped — restarting…"; `up`/`changed` → reload UI with
    the new url/token; `failed` → start page with log tail + Retry.
  - Navigation: only the start page and the daemon origin load in the window; same-origin `window.open`
    → a child window with the same web preferences; http(s)/mailto elsewhere → `shell.openExternal`;
    anything else denied. `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webviewTag`;
    permission requests denied by default.
  - Menu: app (About, Hide, Quit), Демон ("Run Doctor", "Open Daemon Log", "Restart Daemon",
    "Stop Daemon and Quit" — shown in Ukrainian, like the room UI), Edit/View/Window roles. Quit leaves the daemon running (rooms keep going).
- Packaging `desktop/electron-builder.config.cjs`: appId `dev.agoryx.desktop`, productName `Agoryx`,
  mac arm64 `dir` + `dmg`, no signing identity (local build), `extraResources` → `agoryx/`:
  `dist/`, `bin/`, `ui/dist/`, `package.json`, production `node_modules/`. The daemon runs this copy with the
  user's `node`; the `sqlite` doctor check catches an ABI mismatch.
- Docs: `docs/DESKTOP.md` (run/build, architecture diagram, why node not Electron, what's next), README
  section, CHANGELOG entry.
