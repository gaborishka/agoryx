# Changelog

## [Unreleased]

### Added
- **macOS app (`desktop/`):** `Agoryx.app` puts the daemon and its room UI in one window, and works like `agoryx up -d && agoryx open` from a terminal. It is an Electron shell.
  - It reads the login shell's environment once, so the agents get the same PATH and keys as from a terminal.
  - It runs the doctor's checks: nothing starts while something needed is missing.
  - It starts the daemon on the user's own `node`, or attaches to the one already running for that `AGORYX_HOME`, and follows it: restarted from a terminal, gone, back.
  - Quitting leaves the daemon running. The menu item «Зупинити демона й вийти» (Stop Daemon and Quit) stops it through its API.
  - Its start page and menu are in Ukrainian, like the room UI.
  - Run it from the checkout with `npm run desktop`. Build it with `npm --prefix desktop run dist` (arm64 `.app` + `.dmg`, unsigned unless `AGORYX_SIGN_IDENTITY` is set). See [docs/DESKTOP.md](docs/DESKTOP.md).
- **`agoryx service install|uninstall|status` (macOS):** the daemon as a LaunchAgent for the current `AGORYX_HOME`. It starts at login and again after a crash, without the app or a terminal.
  - The plist holds PATH, SHELL and the home only; `up --login-env` reads keys from the login shell at each start.
  - `agoryx down` stops it until the next login. The app and `agoryx up -d` start it through launchd instead of beside it.
  - `agoryx doctor` reports the service, including a plist whose node or install is gone.
- **The app checks who holds the daemon's port** (`lsof`) before attaching, and never gives the token to a process that is not the one in `daemon.json`.
- **Source mode passes SIGTERM and SIGHUP on:** `bin/agoryx.js` without `dist/` hands them to the daemon it runs, so it closes its rooms instead of being orphaned.
- **`agoryx doctor [--probe] [--json]`:** checks what a room needs here: Node and its sqlite module, the `claude` / `codex` CLIs and their logins, git, the state folder and the daemon. Each problem comes with the command that fixes it. `--probe` also makes one short real call to each logged-in agent.
- **When a room waits for you:** the daemon knows which rooms need the human: an agent's `@<you>`, a run that ended (done, budget spent, stopped by an agent or cut short, or an agent's turn that failed). Seeing a room clears it.
  - The macOS app shows them in a menu-bar icon (a dot, and the rooms to open), as a Dock badge, and as notification banners (at most one per 10 s). The room on screen never counts.
  - Banners are expected to need a signed build (`AGORYX_SIGN_IDENTITY` for `npm --prefix desktop run dist`); this is not verified yet and is left to Ivan (the signed-build banner spike). An unsigned one has the menu-bar icon, the badge and the sidebar dot only.
  - The room UI marks a waiting room with a dot in the sidebar, and a browser tab reports the room it shows, like the app.
  - `GET /api/attention`, `POST /api/attention/view` and `POST /api/attention/seen` are the human's only: an agent's key gets a 403, and `GET /api/rooms` carries `waiting` for the human only. Seen cursors live in `<AGORYX_HOME>/attention.json`.
- **The room's browser (macOS app):** Agents open and use a real page in the room's panel over the room's own MCP server, and the human watches live.
  - Seven tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_screenshot`, `browser_eval`) come from `agoryx mcp`, a zero-dependency MCP server the room hands both CLIs (Claude `--mcp-config`, Codex `-c mcp_servers.agoryx_browser.*`). Verified with the real CLIs: Claude per turn and live, `codex exec`, and Codex live (`app-server`), each with no permission prompt, and both agents on one page in the same round.
  - A command runs only from the agent's own running turn, with its agent key, and only while the app is connected to the daemon. When the turn ends or the call is cancelled, its commands still in flight are withdrawn (409 / 499) and the app skips any it has not started.
  - A room with the network off has no browser, for the agents and for the human's address bar alike.
  - The trace shows each step without its values: no typed text, script, query string or sign-in.

---

## [0.3.0] - 2026-02-25

### Added
- **Memory service:** automatic event capture (dispatches, decisions, notes, errors) with crash recovery and full replay on version mismatch.
- **Memory commands:** `/memory show`, `/memory decision`, `/memory note`, `/memory log`, `/memory rebuild`, `/memory render`.
- **Workspace context:** `WorkspaceCollector` injects git branch, status, diffs, and file tree into every agent prompt automatically.
- **Workspace commands:** `/workspace show`, `/workspace full` with JSON output option.
- **Worktree management:** `WorktreeManager` creates isolated git worktrees per agent for safe parallel edits.
- **Worktree commands:** `/worktree create`, `/worktree list`, `/worktree remove`, `/worktree status`.
- **Startup recovery:** active room detection, missing event recovery from SQLite, worktree reconciliation, memory log replay.
- **End-to-end smoke test:** v0.3 integration test covering dispatch → memory capture → decision → restart → recovery.
- **Workspace config section** with defaults for pinned docs, tree depth, diff limits, and on-demand toggles.
- **SQLite tables:** `memory_log` (append-only with event dedup), `memory_snapshot` (monotonic lastLogId enforcement).

### Changed
- Memory markdown (`.agoryx/memory.md`) auto-rendered with debounced writes and atomic file operations (tmp + rename).
- Team runtime auto-creates worktrees per agent and restores adapter config after runs.
- Workspace context injected before pinned context in the context builder token budget.
- Bridge protocol deprecated in favor of project memory (`/memory show`, `.agoryx/memory.md`).
- Test count: 245 → 398.

### Fixed
- Backspace `key.delete` mapping in Ink input component.
- Worktree reconciliation safe in non-git directories (no fatal noise).
- Symlink resolution security check for pinned docs outside workspace root.
- SQLite URI handling hardened for `file:` and `sqlite:memory` schemes.
- Team adapter config isolation and restoration after interrupted runs.
- Startup lifecycle hardened against missing rooms and partial state.

### Validation
- `npm run typecheck` pass
- `npm run build` pass
- `npm test` pass (`398/398`)

---

## [0.2.0] - 2026-02-18

### Added
- `team` orchestration mode with run lifecycle commands:
  `/team start|status|log|resume|approve|interrupt|stop`.
- `agentic` adapter mode with long-lived Codex and Claude interactive transports.
- Team persistence in SQLite: `team_runs`, `team_steps`, `team_feedback_queue`, `team_checks`.
- Team runtime controls: proposal gate, resume, feedback queue, interruption, Esc hotkey.
- Rich TTY rendering options: `--quiet-system`, `--plain-ui`, `--no-color`.
- Release gate script: `npm run verify` (`typecheck + build + test`).

### Changed
- `ChatEngine` internals modularized into dispatch, team orchestrator, lifecycle, logger, and shared types modules.
- Team mode now auto-promotes default `cli` adapters to `agentic` for persistent turn flow.
- Team debate completion is controlled directly by `TEAM_NEXT:<agent>` / `TEAM_DONE` signals (no dedicated finalize step).
- CLI startup banner now reads version from `package.json` (no hardcoded version string).

### Fixed
- Adapter parser coverage for nested stream events and non-JSON noise lines.
- Interactive session recovery and cold-retry restart predicates for Codex/Claude transports.
- Team feedback durability across interrupted steps and mode-switch shutdown edge cases.
- SQLite foreign key enforcement and team-run state transition hardening.

### Validation
- `npm run typecheck` pass
- `npm run build` pass
- `npm test` pass (`245/245`)
