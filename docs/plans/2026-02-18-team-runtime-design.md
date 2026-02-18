# Agoryx v0.2 Team Runtime Design

## Scope
- Add orchestration mode `team`.
- Add autonomous team run lifecycle with a single round-robin team loop.
- Add proposal-gated completion (`waiting_user_input` -> `done` only after explicit approve).
- Add manual resume support after restart.
- Keep relaxed defaults for enthusiast usage and provide strict profile as opt-in.

## Runtime Contract
- One active team run per room (`active|waiting_user_input` unique per room).
- In team mode:
  - user message starts a run if none is active (`autoOnMessage`).
  - user message is queued as feedback if run is active.
- Team loop executes in background and persists each step/check artifact.

## Data Model
New SQLite tables:
- `team_runs`
- `team_steps`
- `team_feedback_queue`
- `team_checks`

Indexes:
- `idx_team_runs_room_status_updated`
- `idx_team_steps_run_seq`
- `idx_team_feedback_run_status`
- `idx_team_runs_single_active` (partial unique)

## Team Loop
- Stage: `debate`.
- Actor selection: round-robin among active agents.
- Stops by guardrails (`maxSteps`, `maxNoProgressSteps`, `maxDurationMs`).
- Run moves directly to `waiting_user_input` from `debate` once stop/control conditions are met.

## Adapter Mode
- Add adapter mode `agentic`.
- `agentic` uses persistent turn transport (`sendTurn`) and workspace-aware cwd.
- Claude keeps isolated cwd for `cli|persistent`; uses workspace cwd in `agentic`.

## CLI Surface
- `/mode team`
- `/team start <goal> [--strict] [--no-checks]`
- `/team status`
- `/team log [limit]`
- `/team resume`
- `/team approve [run_id]`
- `/team stop`

## Guardrails Defaults
- Enthusiast defaults:
  - `maxSteps = 24`
  - `maxNoProgressSteps = 8`
  - `maxDurationMs = 3600000`
  - checks disabled by default
- Strict profile (opt-in):
  - `maxSteps = 8`
  - `maxNoProgressSteps = 2`
  - `maxDurationMs = 900000`
  - checks enabled by default:
  - `npm run typecheck`
  - `npm test`

## Safety
- This iteration intentionally keeps unrestricted execution policy (no deny/allow rules).
