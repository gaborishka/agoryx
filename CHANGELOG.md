# Changelog

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
