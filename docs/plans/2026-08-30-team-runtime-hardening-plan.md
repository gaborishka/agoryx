# Team Runtime Hardening (post plan/implement/merge rewrite)

## Overview

The v0.3.1 rewrite of team mode (debate → plan/implement/merge, `feat(team): replace debate loop with plan-execute-merge flow`) dropped several safety and correctness properties that code review flagged:

1. **Safety limits not enforced.** The new `runLoop` in `internal/engine/team-orchestrator.ts` never reads `maxSteps`, `maxNoProgressSteps`, `maxDurationMs`. They are validated in config, persisted into `team_runs`, and documented in `docs/ARCHITECTURE.md`, but a run can dispatch unbounded work (especially across repeated `/team resume` of a stale run).
2. **Checks subsystem is dead code.** `checksEnabled`/`checkCommands` are validated and persisted; `team_checks` table and `addTeamCheck` exist; the CLI exposes `--no-checks`; the strict profile defaults checks ON — but nothing ever executes a check. (Note: this predates the rewrite — the old debate loop never called `addTeamCheck` either.)
3. **Interrupt/stop cancels only the last parallel agent.** `teamActiveDispatchByRun` holds a single slot per run; `runParallelExecution` overwrites it per agent, so `interrupt()` cancels at most one in-flight dispatch.
4. **stepSeq collision.** Parallel-phase seq is computed from the stale in-memory `run.stepCount` (fetched before planning), so implement steps get seq 1,2 colliding with planning steps 1,2, and the final `stepCount` update drops the planning steps.
5. **Dead debate code.** `parseTeamDebateControl`, `TEAM_DONE`/`TEAM_NEXT`/stop-word patterns, `teamNextActorByRun` (only ever `delete`d, never `set`), the unused `teamPolicy` field, the vestigial "output TEAM_DONE" instruction in the implement prompt, and `tests/engine/parse-team-control.test.ts`.

## Context (from discovery)

- `internal/engine/team-orchestrator.ts` — all five findings live here (runLoop ~519, runParallelExecution ~680, dead code ~981–1037).
- `internal/config/index.ts` (~170–217) — `validateCheckCommands`, limits merge. `internal/config/default.ts` — `checkCommands: ["npm run typecheck", "npm test"]`, strict profile enables checks.
- `internal/storage/sqlite.ts` — `team_runs` persists limits; `team_checks` table (~425), `addTeamCheck` (~1328), `listTeamChecks`. No UNIQUE constraint on `(run_id, seq)`, so collisions persist silently.
- `internal/events/types.ts` — `TeamRunStage` already includes `"checks"` between implement and finalize; `TeamCheck` type with statuses passed/failed/timeout/skipped.
- Old enforcement semantics (pre-rewrite, `git show 81a6031~1`): `shouldFinalizeRun` = `stepCount >= maxSteps || noProgressCount >= maxNoProgressSteps || elapsed >= maxDurationMs` → finalize into `waiting_user_input` with "limits reached" summary; progress = successful step with output ≥ 80 chars resets `noProgressCount`, otherwise +1.
- Test harness: `tests/engine/team-full-cycle.test.ts` and `tests/engine/team-mode.test.ts` (stub adapters, temp SQLite DBs) are the pattern for new engine tests.
- `sanitizeTeamOutput` regression tests currently live inside `tests/engine/parse-team-control.test.ts` and must survive its deletion.

## Decision: restore checks phase (Ivan to confirm)

The user left the choice "restore checks phase vs delete the subsystem" to Ivan or to the architecture. The architecture answers it: `TeamRunStage` includes `"checks"`, `team_checks` is a first-class table, ARCHITECTURE.md documents `checkCommands`/`--no-checks`/`/team log` showing checks, and the strict profile defaults `checksEnabledByDefault: true`. **Decision: restore (implement) the checks phase** between implement and merge. Design:

- Runs only when `run.checksEnabled && config.team.checkCommands.length > 0`.
- Executes each command per agent worktree (or once in the repo root when worktree isolation is off), via async `execFile` (no shell — commands are already validated against `CHECK_COMMAND_PATTERN` which bans shell metacharacters), with a 120s timeout and truncated stdout/stderr.
- Records every result via `addTeamCheck` (passed/failed/timeout), linked to the agent's implement step.
- Failures do **not** fail the run — per `finalGate: "proposal"` the merge summary reports check outcomes and the user decides at `/team approve`. Reverting to "delete the subsystem" remains cheap if Ivan disagrees.

## Development Approach

- **Testing approach:** Regular (code first, then tests in the same task) — matches repo style.
- Complete each task fully before the next; run `npm run typecheck && npm test` after every task (user requirement).
- Every task includes new/updated tests; all tests must pass before the next task.
- Keep old limit semantics (`waiting_user_input` + "limits reached" summary) for backward compatibility of the `/team approve` flow.
- Update this plan file when scope changes.

## Testing Strategy

- Unit/integration tests via `node --test` in `tests/engine/` (stub adapters + temp DBs), `tests/rendering/` for sanitize.
- No e2e suite in this repo.

## Implementation Steps

### Task 1: Fix step seq collision and stale stepCount (review item 4)

**Files:**
- Modify: `internal/engine/team-orchestrator.ts`
- Modify: `tests/engine/team-full-cycle.test.ts`

- [x] `runPlanningPhase`: derive seqs from `run.stepCount` base (resume-safe) instead of hardcoded 1/2
- [x] `runParallelExecution`: refetch the run at phase start for a fresh `stepCount`; use a local dispatched-counter (no `indexOf` gaps when agents are skipped)
- [x] final progress update uses base + actually-dispatched count (planning steps no longer dropped)
- [x] test: full cycle with 2 agents produces unique seqs 1..4 and `stepCount === 4`
- [x] run `npm run typecheck && npm test` — must pass

### Task 2: Track parallel dispatches per (run, request) for interrupt/stop (review item 3)

**Files:**
- Modify: `internal/engine/team-orchestrator.ts`
- Modify: `tests/engine/team-mode.test.ts`

- [x] `teamActiveDispatchByRun` becomes `Map<runId, Map<requestId, ActiveTeamDispatch>>`
- [x] `interrupt()` cancels **all** active dispatches of the run and marks each requestId interrupted
- [x] `launchLoop` finally-cleanup clears the whole inner map
- [x] parallel `.then` consumes interrupted requestIds and records the step with `result: "stopped"`
- [x] test: interrupt during parallel implement cancels both agents (in `team-full-cycle.test.ts`, not `team-mode.test.ts` — the dual-adapter harness lives there)
- [x] run `npm run typecheck && npm test` — must pass

### Task 3: Enforce maxSteps / maxDurationMs / maxNoProgressSteps in runLoop (review item 1)

**Files:**
- Modify: `internal/engine/team-orchestrator.ts`
- Modify: `tests/engine/team-full-cycle.test.ts`

- [x] `getLimitViolation(run)` helper mirroring old `shouldFinalizeRun` (steps / no-progress / duration)
- [x] `finalizeForLimits(run, reason)` → `waiting_user_input` + "Team limits reached: …" summary + adapter-mode restore (old `completeRun` semantics)
- [x] guard at `runLoop` start (protects `/team resume` of exhausted runs) and again between planning and implement
- [x] planning steps update `noProgressCount` (≥80-char successful output resets, else +1 — old rule); implement steps likewise
- [x] `runParallelExecution` clamps assignments to the remaining `maxSteps` budget; skipped assignments logged and reported in the merge summary
- [x] tests: exhausted maxSteps at start → finalize with zero dispatches; `maxDurationMs: 0` → same; budget clamp dispatches only what fits; resumed run with `noProgressCount ≥ max` finalizes immediately
- [x] run `npm run typecheck && npm test` — must pass

### Task 4: Implement the checks phase (review item 2 — decision above)

**Files:**
- Modify: `internal/engine/team-orchestrator.ts`
- Create: `tests/engine/team-checks-phase.test.ts`

- [x] `runChecksPhase(run, stepIdByAgent)` between implement and merge; sets stage `"checks"`
- [x] per-worktree (or repo-root fallback) async `execFile` execution, 120s timeout, output truncation, stop-flag aware
- [x] `addTeamCheck` for every command run (passed / failed / timeout), `stepId` linked to the agent's implement step
- [x] merge summary prepends "Checks: X passed, Y failed …" so the user sees results before `/team approve`
- [x] tests: passing command recorded as `passed`; failing as `failed` with exit code; `checksEnabled: false` and empty `checkCommands` skip the phase entirely
- [x] run `npm run typecheck && npm test` — must pass

### Task 5: Remove dead debate code (review item 5)

**Files:**
- Modify: `internal/engine/team-orchestrator.ts`
- Delete: `tests/engine/parse-team-control.test.ts`
- Create: `tests/rendering/sanitize.test.ts`

- [x] remove `parseTeamDebateControl`, `TeamDebateControl`, `TEAM_DONE`/`TEAM_NEXT`/stop-word patterns, `normalizeTeamControlLine`, `CONTROL_TAIL_LINES`
- [x] remove `teamNextActorByRun` (and dead `mergeErrors` in `runMergePhase`) (field + all `delete` calls) and the unused `teamPolicy` field/import
- [x] remove the vestigial "When done, output TEAM_DONE." instruction from the implement prompt
- [x] delete `tests/engine/parse-team-control.test.ts`; move the generic `sanitizeTeamOutput` regression tests to `tests/rendering/sanitize.test.ts` (drop TEAM_* control-line-preservation cases)
- [x] run `npm run typecheck && npm test` — must pass

### Task 6: Verify acceptance criteria & docs

- [x] all five review findings addressed; limits round-trip config → run → enforcement
- [x] full suite green: `npm run typecheck && npm test`
- [x] update `docs/ARCHITECTURE.md` team section (plan → implement → checks → merge; limits enforcement; checks semantics)
- [x] update Claude project memory (plan location + checks decision awaiting Ivan's confirmation)

## Technical Details

- **Limit semantics** (unchanged from v0.2): violation → run finalizes to `waiting_user_input` so the user can `/team approve` (merge whatever exists) or `/team stop`. Duration is checked at phase boundaries; per-dispatch adapter timeouts already bound individual steps.
- **Progress rule**: `MIN_PROGRESS_LENGTH = 80` chars of successful output = progress (reset counter), else +1 — restored verbatim from the old loop.
- **Check execution**: `command.split(/\s+/)` → `execFile(argv0, args, { cwd, timeout: 120_000 })`; safe because `validateCheckCommands` rejects `| ; & $ ( ) < > #` and backticks. stdout/stderr truncated to 20k chars each before persisting.
- **Interrupt map**: inner map keyed by `requestId` (unique per dispatch); `(runId, agent)` would break if an agent ever had two dispatches in one run stage.

## Post-Completion

- Ivan confirms (or overrides) the "restore checks phase" decision — if overridden, drop `runChecksPhase` + `team_checks`/`addTeamCheck`/`listTeamChecks`/`TeamCheck` and the `--no-checks` CLI flag in a follow-up.
- Consider a follow-up to rename the persisted `strategy: "debate"` / initial `stage: "debate"` labels in `startRun` (schema CHECK constraints still list `debate`; left untouched here to avoid a migration).
- Commit/push left to Ivan (branch `feat/0.3.1`).
