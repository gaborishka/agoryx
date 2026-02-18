# Changelog

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
