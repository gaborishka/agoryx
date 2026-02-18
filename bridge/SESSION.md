# Shared Session State

## Active Goal
Launch MVP Agoryx as a local-first CLI for shared chat between `codex` and `claude` using existing CLI subscriptions.

## Current Phase
**v0.1.0 RELEASED** — all foundation complete, all smoke-tests passed, release tagged.

## Release Summary (v0.1.0)
- **135/135 tests pass**, typecheck clean, repo clean on `main`
- All 4 Near-Term Priorities from AGENTS.md completed
- CLI mode works for both codex and claude adapters
- Manual, round-robin, auto modes all validated
- Checkpoint quality (dedup, cumulative summaries, structured summary) delivered
- Full in-chat command set: /help, /pin, /unpin, /pins, /summary, /checkpoint, /mode, /adapter, /history, /export, /retry, /quit, /exit
- Final joint smoke-test passed: /summary + /history in --adapter-mode cli (both manual and auto modes)
- 18 test files, 22 internal modules, 2 CLI entry points

## Project Structure
```
internal/
├── adapters/          ← Codex: adapter interface, codex/claude CLI adapters, event factory, output parser, registry
├── config/            ← Claude: index.ts (loader, mergeConfig, toRoomConfig, toRuntimeConfig); Codex: default.ts (ChatRuntimeConfig type)
├── engine/            ← Codex: chat.ts (main chat loop) — now uses context builder via SessionService
├── events/            ← Codex: types.ts (canonical types)
├── orchestrator/      ← Codex: policy, manual, round-robin, auto, helpers, factory, autonomy; Claude: index.ts (Orchestrator class)
├── session/           ← Codex: ids.ts, service.ts (updated); Claude: context.ts (context builder algorithm)
└── storage/           ← Codex: sqlite.ts (SQLiteStore)
```

## What Changed This Session (Claude)

### Task 1: Context builder integration
- `SessionService.buildContextMessages()` now delegates to `buildContext()` from `context.ts`
- Added `buildFullContext()` for diagnostics (returns `BuiltContext` with token stats)
- `ChatEngine.runDispatch()` passes `systemPrompt` from adapter config for accurate token budgeting
- Call order changed: `resolveAdapterConfig` → `buildContextMessages` (to have `systemPrompt` available)

### Task 2: Config unification
- Added `toRuntimeConfig(config, overrides?)` in `internal/config/index.ts`
- Unified pipeline: `loadConfig()` → `toRuntimeConfig()` → `new ChatEngine()`
- `default.ts` keeps `ChatRuntimeConfig` type (engine contract), `index.ts` contains everything else (loader, defaults, conversion)

## What Changed This Session (Codex)

### Task 1: Adapter contract tests
- Added `tests/adapters/parse-output.test.ts` (json/plain parsing coverage)
- Added `tests/adapters/event-factory.test.ts` (event envelope/payload checks)
- Added `tests/adapters/stub-contract.test.ts` (codex/claude stub event sequence contract)
- Full test suite: **10/10 pass**

### Task 2: CLI sessions commands
- Added `sessions list` and `sessions export` to `cmd/agoryx/main.ts`
- `sessions export` supports both `room_id` and `session_id` (via `resolveRoomId`)
- Supported formats: `markdown`, `json`; optional `--out`
- Added npm scripts: `npm run cli`, `npm run sessions`

### Task 3: Unified config pipeline in CLI
- `cmd/agoryx/main.ts` migrated to `loadConfig()` + `toRuntimeConfig()`
- Added CLI parameter `--config`
- Removed previous typecheck issues in `cmd/agoryx/main.ts`

## What Changed This Session (Claude — code review fixes)

### Bugfix 1: Deep merge agents config (P1)
- `mergeConfig()` now performs per-agent deep merge instead of shallow spread
- Added `mergeAgents()` helper with support for new agents (fills missing fields from `AGENT_DEFAULTS`)
- File: `internal/config/index.ts`

### Bugfix 2: systemPrompt propagation (P2)
- `buildContext()` now prepends systemPrompt as the first system message in the `messages` array
- Previously systemPrompt was only counted in token budget and not included in output
- File: `internal/session/context.ts`

### Tests
- Added `tests/config/merge.test.ts` (3 tests: partial merge, adapter config, new agent defaults)
- Added `tests/adapters/system-prompt.test.ts` (2 tests: context builder includes systemPrompt, adapter receives it)
- Total: 18/18 tests pass, typecheck clean

## What Changed This Session (Codex — sessions export extraction)

### Task: sessions export rendering extraction
- Moved export rendering into a separate module `cmd/agoryx/session-export.ts`
- `cmd/agoryx/main.ts` migrated to `renderSessionAsJson()` and `renderSessionAsMarkdown()`
- Added `tests/cmd/session-export.test.ts` (3 tests: markdown full, markdown skip optional, json shape)

## What Changed This Session (Claude — sessions export test coverage)

### Task: comprehensive test coverage for session-export renderers
- Added `tests/export/render.test.ts` (14 tests):
  - markdown: full export, omit pinned, omit checkpoint, empty summaryText, empty messages, message order, multiple pins
  - json: top-level fields, null checkpoint, message field preservation, empty arrays, room config serialization
  - exportedAt injection testability
- Validation: `npm run typecheck` + `npm test` => **34/34 pass**

## What Changed This Session (Codex — adapter retry flow hardening)

### Task: `/retry` end-to-end behavior + recovery
- `ChatEngine.retryFailed()` now performs real retry-dispatch:
  - finds the latest unresolved failed request for the adapter
  - performs best-effort `adapter.cancel(failedRequestId)` before retry
  - starts a new dispatch with a new `requestId` and returns `RetryResult`
- `runDispatch()` now returns errors with error class (`TIMEOUT`, `PROCESS_CRASH`, ...) in `CLASS: message` format
- `SQLiteStore.getLastFailedRequest()` now treats failure as resolved if `message.completed` appears after `message.error` for the same adapter/source
- CLI `/retry` now:
  - performs real retry
  - shows `retry succeeded/failed` with mapping `failedRequestId -> new requestId`
- Added `tests/engine/retry-flow.test.ts`:
  - recovery scenarios for `TIMEOUT` and `PROCESS_CRASH`
  - cleanup verification via `cancel()`
  - verification that successful retry clears active failure marker
  - verification that `retryFailed()` returns `null` when no unresolved failures exist
- Validation: `npm run typecheck` + `npm test` => **34/34 pass**

## What Changed This Session (Claude — live smoke-test)

### Smoke-test results
- **Stub mode**: PASS — dispatch routes correctly, messages stored, stub responses returned
- **Codex CLI mode**: FAIL — adapter runs, codex responds, but **parser returns empty text**
- **Claude CLI mode**: FAIL — process crashes (exit code 1) due to missing `--verbose` flag

### Bugs found (all block CLI mode)

| # | Severity | Component | Issue |
|---|----------|-----------|-------|
| 1 | P1 | `parse-output.ts` | Codex JSON format not parsed: text is at `item.text`, parser only checks top-level keys (`delta`, `text`, `content`, etc.) |
| 2 | P1 | `parse-output.ts` | Claude stream-json not parsed: text is at `message.content[].text` and `result`, neither in candidates |
| 3 | P1 | `claude/index.ts` | Missing `--verbose` flag — `claude -p --output-format stream-json` requires it |
| 4 | P2 | `claude/index.ts` | `CLAUDECODE` env var blocks nested sessions — need to filter from spawn env |

### Verified CLI versions
- `codex-cli 0.99.0` — authenticated, responds correctly standalone
- `claude 2.1.44 (Claude Code)` — authenticated, responds with `--verbose`

## What Changed This Session (Codex — smoke-test bugfixes)

### Fixes delivered
- `internal/adapters/parse-output.ts`
  - Added support for `result` and `item` in top-level candidates
  - Added recursive extraction for nested fields (`message.content[]`, `item.content[]`, nested `message/item/result`)
- `internal/adapters/claude/index.ts`
  - Spawn args now include `--verbose` for `--output-format stream-json`
  - `CLAUDECODE` is removed from env before spawn (`buildClaudeSpawnEnv`)
- Tests:
  - Updated `tests/adapters/parse-output.test.ts` (new cases: codex `item.text`, claude `message.content`, claude `result`)
  - Added `tests/adapters/claude-cli.test.ts` (`--verbose` args + env sanitization)
  - Validation: `npm run typecheck` + `npm test` => **39/39 pass**

## What Changed This Session (Claude — smoke-test re-run PASS)

### Re-run results after Codex hotfixes
- **Parser isolated test**: codex `item.text` → extracted, claude `message.content` → extracted, claude `result` → extracted
- **Codex CLI mode**: PASS — `@codex say hello` → `Hello` (reasoning text also appears — minor refinement)
- **Claude CLI mode**: PASS — `@claude say hello` → `Hello` (text is duplicated via assistant+result — minor refinement)
- **Both adapters together**: PASS — `@codex @claude say hello` → both respond sequentially and see each other's context

### Minor refinements (not blockers)
1. Codex reasoning items (`type:"reasoning"`) appear in output next to `agent_message` — should be filtered
2. Claude text is duplicated (from `assistant` message and `result` event) — should be deduplicated

## What Changed This Session (Codex — CLI parser polish)

### Fixes delivered
- `internal/adapters/parse-output.ts`
  - Added reasoning payload filter (`type` matches `reasoning`) — these blocks are no longer returned as user-visible text
  - Preserved extraction of regular text content in mixed payloads (reasoning + text)
- `internal/adapters/claude/index.ts`
  - Added `parseClaudeChunk()` with separate `deltaText` and `resultText`
  - `result` event is no longer emitted as delta (duplication removed)
  - `resultText` is used as fallback only when delta stream is empty
- Tests:
  - Updated `tests/adapters/parse-output.test.ts` (reasoning ignore + mixed content keep-text cases)
  - Added `tests/adapters/claude-stream-parser.test.ts` (assistant+result dedupe, result-only fallback, non-json passthrough)
  - Validation: `npm run typecheck` + `npm test` => **44/44 pass**

## What Changed This Session (Codex — in-chat /export command)

### Fixes delivered
- `cmd/agoryx/main.ts`
  - Added in-chat command `/export [markdown|json] [--out <file>]`
  - `/export` without `--out` prints export of the current session to console
  - `/export --out <file>` writes export to a file and confirms the path
  - `sessions export` migrated to shared renderer/collector pipeline
- `cmd/agoryx/session-export.ts`
  - Added unified contract: `normalizeExportFormat`, `parseExportCommandArgs`
  - Added `collectTargetExportData` and `collectRoomExportData` for unified data collection
  - Added `renderSessionExport(format)` as single markdown/json rendering entry point
- Tests:
  - Updated `tests/export/render.test.ts`:
    - coverage of `/export` argument parsers
    - coverage of format normalizer
    - coverage of collect helpers (resolve via session_id, error path)
    - coverage of `renderSessionExport` format switch
  - Validation: `npm run typecheck` + `npm test` => **49/49 pass**

## What Changed This Session (Claude — auto mode smart routing)

### Auto mode implementation
- Full rewrite of `internal/orchestrator/auto.ts` — two-pass routing algorithm:
  1. Mention pass: `@all` → broadcast, `@agent` → deduplicated dispatch
  2. Skill match: keyword scoring per agent, best score wins, tie → first in config order
  3. Fallback: round-robin rotation (index advances only on fallback, per-room)
- Punctuation normalization during word split (strip non-letter chars)
- Short keyword filter (<3 chars ignored unless whitelisted: ui, ux, db)
- `SKILL_KEYWORDS` dictionary with 14 skills (including Ukrainian keywords)

### Config layer changes
- `AgentEntry.skills?: string[]` — optional skill tags per agent
- `DEFAULT_AGENT_SKILLS` — hardcoded defaults for codex (code/debug/test) and claude (architecture/review/explain)
- `resolveAgentSkills(config, activeAgents?)` — three-level fallback: config → defaults → []
- `ChatRuntimeConfig.agentSkills` — propagated through `toRuntimeConfig()`

### Factory + Engine integration
- `PolicyOptions` interface in `factory.ts`, `createPolicy(mode, options?)` passes skills to AutoPolicy
- `ChatEngine.init()` and `setMode()` pass `config.agentSkills` when creating policy

### Tests
- `tests/orchestrator/auto.test.ts` — 13 tests: mentions (5), skill routing (5), fallback (3)
- `tests/config/merge.test.ts` — +3 tests: skills override, defaults fallback, new agent empty
- Validation: `npm run typecheck` + `npm test` => **65/65 pass**

### Design docs
- `docs/plans/2026-02-17-auto-mode-design.md` — full design document
- `docs/plans/2026-02-17-auto-mode-plan.md` — implementation plan with 7 tasks

## Decision Lock (2026-02-17)
- `auto` mode for v0.1 = **smart routing**, not broadcast:
  - for each user message, select one most relevant agent (`codex` or `claude`) using deterministic heuristics (intent/keywords + recent context)
  - fallback on low confidence: round-robin rotation
- Agent-to-agent autonomous chaining/debate is **out of v0.1** (deferred).
- Source of truth: `docs/ARCHITECTURE.md` (section `v0.1 Policies`).

## What Changed This Session (Codex — /export review follow-ups)

### Fixes delivered
- `cmd/agoryx/session-export.ts`
  - `parseExportCommandArgs()` now rejects duplicate `--out` (instead of silent overwrite)
  - Added comments for `normalizeExportFormat()` semantics (default vs reject)
  - Export message limit extracted to `EXPORT_MESSAGE_LIMIT` with explicit rationale
- `tests/export/render.test.ts`
  - Added test: duplicate `--out` → `null`
  - Added test: `collectTargetExportData` throws for unknown target id
- Validation: `npm run typecheck` + `npm test` => **67/67 pass**

## What Changed This Session (Codex — auto smoke-test + CLI hardening)

### Live smoke-test (auto mode, real adapters)
- Started `auto` mode with `--adapter-mode cli` (real `codex` + `claude`) in a PTY session.
- Verified all 3 routing branches:
  - Mention pass: `@codex` → `codex`, `@claude` → `claude`
  - Skill pass: `write a function...` → `codex`, `explain architecture...` → `claude`
  - Fallback pass: `hello` → `codex`, next neutral `ok` → `claude` (round-robin rotation)
- Conclusion: smart-routing contract works as intended in live CLI environment.

### CLI hardening
- `cmd/agoryx/main.ts`
  - Added graceful EOF handling for non-interactive stdin (`readline was closed` no longer crashes process).
  - Added alias `/checkpoint` for existing `/summary` logic.
  - Updated `/help` (shows `/checkpoint`).
- `tests/cmd/chat-cli.test.ts`
  - Added integration test for clean exit on stdin EOF after one message.
  - Added integration test for `/checkpoint` alias.
- Validation: `npm run typecheck` + `npm test` => **69/69 pass**

## What Changed This Session (Claude — independent auto mode smoke-test)

### Live smoke-test (auto mode, piped stdin)
- Independently validated auto mode routing (both stub and CLI adapters)
- **Stub mode (7/7 PASS):** mentions (3), skill routing (2), fallback round-robin (2)
- **CLI mode (8/8 PASS):** mentions (2), skill routing EN (2), broadcast @all (1), fallback (1), Ukrainian keywords (2)
- Key scenarios verified:
  - `@codex say hello` → codex: "Hello" ✅
  - `@claude say hello` → claude: "Hello!" ✅
  - `@all say hi` → both respond ✅
  - `write a hello world function` → codex (skill: write/code) ✅
  - `explain dependency injection` → claude (skill: explain) ✅
  - `write an addition function` → codex (skill: UKR write/code) ✅
  - `explain SOLID principles` → claude (skill: UKR explain) ✅
  - `hello` → codex (fallback #0) ✅
- Conclusion: all 3 routing branches (mention, skill, fallback) work correctly with real agents

### Discovery: /pin, /unpin, /summary already implemented
- All three commands fully functional in CLI (Codex implemented earlier)
- Storage, session layer, context builder integration complete
- `/help` exists but basic (no per-command help)
- Missing: `/pins` list command, test coverage for command handlers

## What Changed This Session (Codex — /pins command + non-TTY command processing)

### /pins implementation
- Added end-to-end `/pins` command support (with optional `list` subcommand):
  - `internal/session/service.ts`: `listPinnedContext(roomId)`
  - `internal/engine/chat.ts`: `listPinnedContext()`
  - `cmd/agoryx/main.ts`: `/pins [list]` command handler + `/help` update
- Behavior:
  - empty state: `No pinned context.`
  - list state: tabular output `pin_id<TAB>label<TAB>content`
  - invalid subcommand: `Usage: /pins [list]`

### Runtime hardening for piped stdin
- `cmd/agoryx/main.ts` now processes non-TTY input via `for await (const line of rl)` path.
- Fixes multi-command scripted sessions (e.g. `/help\n/pin\n/summary\n/quit`) that were being cut after first line when stdin closed.
- Interactive TTY flow (`rl.question("> ")`) remains unchanged.

### Tests
- Added `tests/cmd/pins-command.test.ts`:
  - `/pins` empty state
  - `/pins list` after multiple `/pin`
  - invalid `/pins` subcommand
- Validation: `npm run typecheck` + `npm test` => **91/91 pass**

## What Changed This Session (Claude — command handler tests)

### Command handler test coverage
- Created `tests/cmd/command-handler.test.ts` — **19 integration tests** covering all in-chat commands:
  - `/help` — verifies all commands listed
  - `/pin` — label+content, content-only, empty args (usage)
  - `/unpin` — missing args (usage), nonexistent id (not found), valid id via pin→resume→unpin flow
  - `/summary` — empty room (not enough history), with messages + low threshold config (checkpoint created)
  - `/mode` — missing arg (usage), valid mode (switched), invalid mode (usage)
  - `/history` — shows user and agent messages via resume
  - `/adapter` — switches mode, missing args (usage), unknown agent (error)
  - unknown command — error with `/help` hint
  - `/quit` and `/exit` — clean exit
- Test pattern: integration via spawn + piped stdin; multi-step tests use `--resume` to avoid piped stdin EOF issue
- Validation: `npm run typecheck` + `npm test` => **91/91 pass** (includes Codex's 3 /pins tests)

## What Changed This Session (Codex — storage checkpoint APIs + CLI smoke)

### Storage/API changes
- `internal/storage/sqlite.ts`
  - Added `listMessagesAfter(roomId, afterMessageId)`:
    - efficient incremental message fetch without loading large history windows
    - uses `rowid` ordering to keep deterministic append order even when `created_at` timestamps are equal
  - Added `getCheckpointCoverage(roomId)`:
    - returns `{ fromMessageId, toMessageId }` for latest checkpoint
    - lightweight API for dedup/overlap guards in session layer
  - Refactored message row mapping into `messageRowToDomain()` helper (no behavior change)
- Added `tests/storage/sqlite-store.test.ts`:
  - `listMessagesAfter` returns messages strictly after anchor in insertion order
  - `listMessagesAfter` returns empty array for missing anchor
  - `getCheckpointCoverage` returns `null` when no checkpoints
  - `getCheckpointCoverage` returns latest checkpoint range when checkpoints exist

### Validation
- `npm run typecheck` ✅
- `npm test` ✅ (**96/96 pass**)
- CLI smoke (`--adapter-mode cli`) for `/summary` + `/history` ✅:
  - Input: `hello smoke`, `/summary`, `/history`, `/quit`
  - Observed:
    - `Checkpoint created.`
    - `[user] hello smoke`

## What Changed This Session (Codex — Bridge language policy docs update)

### Documentation updates
- Updated `AGENTS.md`:
  - translated the full document to English
  - added explicit rule: all Bridge communication (`bridge/*`) must be in English
- Updated `CLAUDE.md`:
  - added the same explicit Bridge English-only rule in protocol rules
  - removed the conflicting "respond in Ukrainian" instruction from Communication Style
- Scope note: only collaboration-guideline docs were updated in this step.

## What Changed This Session (Codex — Bridge folder full English migration)

### Documentation updates
- Translated all Bridge files to English:
  - `bridge/PROTOCOL.md`
  - `bridge/CLAUDE_PROMPT.md`
  - `bridge/CODEX_PROMPT.md`
  - `bridge/SESSION.md`
  - `bridge/LOG.md`
- `bridge/LOG.md` historical entries were translated and normalized to English wording.
- Validation: no Cyrillic text remains in `bridge/*.md`.

## What Changed This Session (Claude — checkpoint quality implementation)

### Checkpoint quality overhaul (branch: feat/checkpoint-quality)
- **Token fix (INV-4):** `buildContext` no longer double-counts systemPrompt in `totalEstimatedTokens`
- **Context builder refactor:** uses `listMessagesAfter` for targeted post-checkpoint loading; `Math.max(maxHistoryMessages, checkpointThreshold + 1)` for threshold check (INV-5)
- **Fallback fix:** fallback paths now reload with 10k ceiling to get newest messages, not bounded oldest window
- **Structured summary helpers:** `extractTopics`, `extractDecisions`, `buildBudgetTail`, `buildStructuredSummary` added to `service.ts`
  - Topics: top-5 keywords by word frequency (EN+UA stop words filtered)
  - Decisions: regex patterns for EN and UA decision language
  - Budget tail: newline-aware character budget, no mid-message truncation
  - Summary format: `[Prior summary]` + `[Checkpoint] N messages (author breakdown)` + Topics + Decisions + tail
- **Checkpoint rewrite (INV-1,2,3):** `maybeCreateCheckpoint(room, force?)` with:
  - Dedup via `getCheckpointCoverage` — no repeat checkpoints without new messages
  - Auto threshold (`checkpointThreshold`) vs force threshold (2 messages)
  - Cumulative summaries — prior summary prepended with `[Prior summary]` wrapper
  - No nested wrappers (INV-3) — existing `[Prior summary]` prefix stripped before re-wrapping
  - Range preservation (INV-1) — `fromMessageId` carried forward from first checkpoint
- **Engine integration:** `checkpointNow()` passes `force=true`; existing `/summary` test updated for new threshold split
- **Known v0.1 tradeoff:** `listMessages(10_000)` is ASC LIMIT, so rooms >10k messages will get stale data in fallback paths; documented at all call sites
- **Tests:** 29 new tests across 3 files:
  - `tests/session/context.test.ts` (7): token fix, post-checkpoint, fallback regression, long dialogue, pinned+summary, INV-5, budget
  - `tests/session/summary.test.ts` (12): topics, decisions, budget tail (incl. newline accounting), structured summary, prior trim, INV-3
  - `tests/session/checkpoint.test.ts` (10): dedup, auto/force thresholds, cumulative, INV-1, INV-5 window, topics/decisions, INV-3
- Validation: `npm run typecheck` + `npm test` => **125/125 pass**

## Known Issues (v0.1 tradeoffs)
- SKILL_KEYWORDS dictionary is static and may need tuning after real-world testing.
- `listMessages(10_000)` ASC LIMIT ceiling: rooms >10k messages will have stale fallback paths. Deferred to v0.2.

## Open Questions
- None.

## Next Step
1. v0.2 scope and plan — to be defined in a future session.

## Last Updated
2026-02-17T22:00:00Z by claude

## What Changed This Session (Codex — review follow-up fixes)

### Fixes delivered
- `internal/session/service.ts`
  - Added defensive guards for empty conversation slices before checkpoint range access.
  - Reworked no-coverage checkpoint path to load only `user|assistant` rows via role-aware tail query.
  - Improved topic extraction: repeated bi-grams (e.g. `context builder`) can now appear in `Topics`.
  - Improved prior-summary trimming to cut from the end while preferring a word boundary.
- `internal/storage/sqlite.ts`
  - Added `listRecentMessagesByRoles(roomId, roles, limit)` for efficient role-scoped tail loading.
- Tests:
  - `tests/session/checkpoint.test.ts`: added system-only room safety case.
  - `tests/session/summary.test.ts`: added multi-word topic and trim word-boundary coverage.
  - `tests/storage/sqlite-store.test.ts`: added role-aware tail query coverage and role-filter count assertions.

### Validation
- `npm run typecheck` PASS
- `npm test` PASS (**135/135**)

## What Changed This Session (Codex — Claude chat-mode isolation)

### Fixes delivered
- `internal/adapters/claude/index.ts`
  - Added CLI safety flags for chat turns:
    - `--disable-slash-commands`
    - `--tools ""`
    - `--setting-sources user`
  - Spawn now runs with isolated working directory via `buildClaudeSpawnCwd(process.env)`:
    - defaults to `tmpdir()` to avoid loading workspace instructions (`AGENTS.md`, `CLAUDE.md`)
    - supports override with `AGORYX_CLAUDE_CWD`
  - Effect: Claude no longer runs workspace bootstrap flows during standard Agoryx chat responses.
- `tests/adapters/claude-cli.test.ts`
  - Updated spawn-args contract test to lock non-agentic defaults.
  - Added test coverage for cwd isolation + env override.

### Validation
- `npm run typecheck` PASS
- `npm test` PASS (**136/136**)
- CLI smoke (`--adapter-mode cli`) PASS:
  - Input: `@claude Що думаєш про проєкт?` then `/quit`
  - Observed: direct chat response without file scans, skill bootstrap, or interactive follow-up loops.

## What Changed This Session (Codex — Claude capability restoration)

### Fixes delivered
- `internal/adapters/claude/index.ts`
  - Removed restrictive non-agentic flags from Claude spawn args:
    - removed `--disable-slash-commands`
    - removed `--tools ""`
    - removed `--setting-sources user`
  - Kept cwd isolation (`buildClaudeSpawnCwd`) as the root fix for workspace bootstrap leakage.
- `tests/adapters/claude-cli.test.ts`
  - Restored spawn-args contract to standard Claude CLI invocation:
    - `-p <prompt> --output-format stream-json --verbose`

### Validation
- `npm run typecheck` PASS
- `npm test` PASS (**136/136**)
- CLI smoke (`--adapter-mode cli`) PASS:
  - Input: `@codex @claude Що думаєте про наш прогрес?` then `/quit`
  - Observed: both agents respond in normal chat mode; Claude no longer enters bootstrap file-scan flow.

## What Changed This Session (Codex — SDK migration research)

### Investigation scope
- Reviewed current adapter contract and implementation (`internal/adapters/*`, config/runtime wiring, README guarantees).
- Compared against official SDK docs for:
  - OpenAI Codex SDK
  - Anthropic Claude Agent SDK (TypeScript)

### Findings
- Current v0.1 strategy is explicitly CLI-first and no mandatory API keys.
- Codex SDK is technically compatible as an optional transport backend (typed events, timeout/abort controls, conversation helpers).
- Claude Agent SDK guidance for third-party apps requires API/provider auth and explicitly does not support using Claude app subscription login for third-party products.
- A full rewrite of both adapters to SDK now would conflict with Agoryx v0.1 product promise and onboarding model.

### Recommendation
- Do **not** replace both adapters with SDKs right now.
- Keep CLI adapters as default path.
- Consider a v0.2 opt-in Codex SDK backend (`mode: "sdk"`) while preserving current adapter event contract.
- Keep Claude CLI adapter for subscription-based UX; only add Claude SDK as a separate API-key mode if product direction explicitly changes.

### Risks
- Supporting both CLI and SDK backends increases the adapter test matrix.
- Claude SDK path introduces API billing/compliance expectations and changes onboarding.

### Next
- If approved, draft a codex-only SDK spike plan (small scope, mode-gated, no behavior regressions).

## What Changed This Session (Codex — persistent session plan corrections)

### Documentation corrections
- Updated `docs/plans/2026-02-18-persistent-sessions-plan.md` to align with design/runtime realities:
  - removed hardcoded test-count expectations (`136`) in favor of dynamic baseline checks
  - passed `systemPrompt` through `buildDeltaPrompt` cold-start path in plan snippets
  - replaced outdated test config shape (`adapterMode`, `adapterTimeoutMs`, `adapterMaxTokens`) with current `ChatRuntimeConfig.adapterConfig` structure
  - removed `session.store` access pattern from engine snippets and switched to explicit `SessionService` wrapper methods
  - fixed cursor semantics in engine snippet so cursor advances only on successful turns (not on error paths), matching design invariants
- Updated `docs/plans/2026-02-18-persistent-sessions-design.md` to remove hardcoded `136` test-count wording.

### Validation
- Confirmed current repository baseline remains green: `npm run typecheck` + `npm test` => **136/136** pass.
- Confirmed Codex resume CLI syntax availability via `codex exec resume --help`.

### Risks
- Claude `session_id` extraction format remains a runtime validation item during real persistent-mode smoke tests.

### Next
- If approved, start implementation from corrected persistent-session plan (Task 1 onward) without additional pre-plan edits.

## What Changed This Session (Codex — persistent sessions implementation)

### Core implementation
- Added canonical persistent-session event/types:
  - `SESSION_EXPIRED` error class
  - `session.bound` event type
  - `SessionBoundPayload { nativeSessionId }`
- Added adapter-level persistent contract:
  - `AdapterMode` now includes `persistent`
  - `SendTurnInput` and `PersistentAdapter.sendTurn()`
- Added `sessionBound(...)` event factory in `internal/adapters/event-factory.ts`.

### Storage + session layer
- Added `agent_sessions` schema and APIs in `internal/storage/sqlite.ts`:
  - create/get/list/update lifecycle methods
  - fail counter tracking
  - partial unique index for one active session per `(room, agent)`
  - `getMaxMessageSeq(roomId)` and `listMessagesDelta(...)` for rowid-based delta windows
- Added `SessionService` persistent helpers in `internal/session/service.ts`:
  - `buildDeltaPrompt(...)` (cold full-context + warm delta paths)
  - `acquireTurnLock(...)` per `(room, agent)` to serialize concurrent turns
  - agent-session wrapper methods (`getOrCreateAgentSession`, cursor/native-id/status/fail updates)

### Adapter layer
- `internal/adapters/codex/index.ts`:
  - implemented `sendTurn()` with cold/warm resume flow
  - added `buildCodexSpawnArgs(prompt, nativeSessionId)`
  - added `extractCodexThreadId(...)` and `session.bound` emission
  - added process-error mapping to `SESSION_EXPIRED` for resume/session failures
- `internal/adapters/claude/index.ts`:
  - implemented `sendTurn()` with `--resume` flow
  - extended `buildClaudeSpawnArgs(prompt, nativeSessionId)`
  - added `extractClaudeSessionId(...)` and `session.bound` emission
  - added process-error mapping to `SESSION_EXPIRED` for resume/session failures

### Engine integration
- `internal/engine/chat.ts` now has dual dispatch paths:
  - `runLegacyDispatch(...)` for `stub|cli`
  - `runPersistentDispatch(...)` for `persistent`
- Persistent lifecycle implemented:
  - per-agent turn lock usage
  - delta prompt build from session cursor
  - `session.bound` capture and native id persistence
  - cursor advance only on successful turn
  - `SESSION_EXPIRED` one-shot cold retry (mark old session expired, create new active)
  - cold-start fatal guard when no native session id is bound
- CLI surface updated for persistent mode:
  - `--adapter-mode stub|cli|persistent`
  - `/adapter <codex|claude> <stub|cli|persistent>`

### Tests and validation
- Added tests:
  - `tests/adapters/session-bound-event.test.ts`
  - `tests/adapters/codex-resume.test.ts`
  - `tests/adapters/claude-resume.test.ts`
  - `tests/storage/agent-sessions.test.ts`
  - `tests/session/delta.test.ts`
  - `tests/engine/persistent-session.test.ts`
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**172/172**)
  - baseline before implementation was **136/136**
  - `codex exec resume --help` verified
  - stub smoke PASS (`npx tsx cmd/agoryx/main.ts chat --adapter-mode stub`)

### Risks
- Claude native session-id extraction uses tolerant key matching and may need adjustment after real persistent-mode live run if CLI output schema differs.

### Next
- Run live smoke in `--adapter-mode persistent` with real Codex and Claude CLIs and verify end-to-end resume behavior across multi-turn chats.

## What Changed This Session (Codex — CLI live status visibility)

### CLI UX improvements
- Updated `cmd/agoryx/main.ts` event rendering to expose real-time adapter lifecycle states:
  - `[agent] generating...` on `message.started`
  - session binding visibility on `session.bound` (`session ready/resumed/switched` with shortened native session id)
  - `[agent] done` on `message.completed`
- Added render-state tracking per adapter to avoid breaking streamed text when `session.bound` arrives mid-stream (deferred status print when needed).

### Tests
- Added `tests/cmd/chat-cli.test.ts` coverage:
  - verifies live status lines appear during stub streaming (`generating`, response stream, `done`).
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**173/173**)

### Next
- Optionally add a compact/verbose toggle for status lines in chat UI if users want lower-noise output.

## What Changed This Session (Codex — review findings fixes before merge)

### Fixes delivered
- Fixed CLI adapter-mode precedence regression in `cmd/agoryx/main.ts`:
  - `--adapter-mode` now overrides adapter modes only when explicitly provided.
  - Config-defined modes in `agoryx.json` are preserved when no CLI override is passed.
- Kept default `cli` behavior without forcing overrides by updating defaults:
  - `internal/config/index.ts` (`DEFAULT_CONFIG.agents.{codex,claude}.mode = "cli"`)
  - `internal/config/default.ts` (`createDefaultAdapterConfig()` returns `cli` modes)
- Hardened Claude session binding extraction in `internal/adapters/claude/index.ts`:
  - ignore `system` hook events (`hook_started`/`hook_response`) for native session binding
  - accept session IDs from stable event families (`system:init`, `stream_event`, `assistant`, `result`)
  - removed recursive nested session-id scan to avoid latching onto unrelated IDs

### Tests
- Expanded tests:
  - `tests/cmd/chat-cli.test.ts`: verifies config-defined adapter mode remains intact when `--adapter-mode` is omitted
  - `tests/adapters/claude-resume.test.ts`: covers hook-event ignore path and stream_event extraction path
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**176/176**)
- Manual sanity checks:
    - no-flag startup shows `mode=cli`
    - config with `mode=persistent` remains `mode=persistent` without CLI override

## What Changed This Session (Codex — v0.2 team runtime implementation)

### Core runtime
- Added `team` orchestration mode and team-run lifecycle types:
  - `TeamStrategy`, `TeamRunStatus`, `TeamRunStage`, and team domain entities in `internal/events/types.ts`
- Added `agentic` adapter mode with optional `workspaceCwd` in adapter config.
- Implemented `TeamPolicy` (`internal/orchestrator/team.ts`) and wired it through orchestrator factory/index.

### Storage + session layer
- Added new SQLite schema and APIs in `internal/storage/sqlite.ts`:
  - `team_runs`, `team_steps`, `team_feedback_queue`, `team_checks`
  - partial unique index for one active team run per room (`active|waiting_user_input`)
  - CRUD/list/update APIs for runs, steps, feedback, checks.
- Added session wrappers and prompt builder in `internal/session/service.ts`:
  - team run accessors
  - feedback queue wrappers
  - `buildTeamPrompt(...)` for goal + recent steps + pending feedback + context tail.

### Engine + CLI
- Extended `ChatEngine` with team runtime controls:
  - `startTeamRun`, `teamStatus`, `teamLog`, `teamResume`, `teamApprove`, `teamStop`, `queueTeamFeedback`, `shutdown`
  - background team loop with `debate|pipeline` execution paths
  - proposal gate (`waiting_user_input`) and manual approve (`done`)
  - pipeline checks execution (`npm run typecheck`, `npm test`) with skip when script missing.
- Added prompt-based internal dispatch path for team steps (supports persistent and agentic adapters).
- Extended CLI (`cmd/agoryx/main.ts`):
  - `/mode` supports `team`
  - added `/team start|status|log|resume|approve|stop`
  - `/adapter` and `--adapter-mode` support `agentic`
  - non-command input in team mode now auto-starts run or queues feedback.

### Adapter updates
- Codex adapter now runs with workspace cwd (`workspaceCwd ?? process.cwd()`).
- Claude adapter:
  - keeps isolated cwd for `cli|persistent`
  - uses workspace cwd in `agentic`
  - `buildClaudeSpawnCwd` now supports mode-aware behavior.

### Docs
- Updated:
  - `README.md` (team mode, agentic mode, new commands/config)
  - `docs/ARCHITECTURE.md` (team policy/runtime additions)
- Added:
  - `docs/plans/2026-02-18-team-runtime-design.md`

### Tests and validation
- Added tests:
  - `tests/orchestrator/team.test.ts`
  - `tests/storage/team-runs.test.ts`
  - `tests/storage/team-steps.test.ts`
  - `tests/storage/team-checks.test.ts`
  - `tests/engine/team-mode.test.ts`
  - `tests/engine/team-resume.test.ts`
  - `tests/cmd/team-command.test.ts`
- Expanded existing tests for:
  - `agentic` adapter mode path and CLI handling
  - team config merge coverage
  - Claude mode-aware cwd behavior
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**195/195**)

## What Changed This Session (Codex — team runtime simplification)

### Scope reduction (by product feedback)
- Removed public `pipeline|debate` branching from team UX/API and collapsed to one deterministic team loop.
- `/team start` no longer accepts `--strategy`; the command is now:
  - `/team start <goal> [--no-checks]`

### Runtime changes
- `ChatEngine` team loop simplified to a single round-robin execution path + finalize/proposal gate.
- Removed pipeline-specific execution branches and staged transition logic from engine.
- `TeamPolicy` simplified to actor rotation only (no pipeline stage routing helpers).

### Config and docs
- Removed `team.defaultStrategy` from runtime config surface.
- Updated docs/usage to remove `--strategy debate|pipeline` from team command examples and references.

### Tests and validation
- Updated and cleaned tests that depended on pipeline/defaultStrategy.
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**193/193**)

## What Changed This Session (Codex — team UX/runtime cleanup)

### User-facing cleanup
- Removed stale strategy wording from chat UX:
  - auto-start message in team mode now prints `Team run started: <run_id>`
  - `/team status` no longer prints `strategy: ...`
- Removed `Strategy: ...` line from internal team prompts to avoid reinforcing old public strategy semantics.

### Runtime behavior update
- Team runs now auto-promote adapter mode from `cli` to `agentic` when needed:
  - applied at chat startup when `--mode team` is used without explicit `--adapter-mode`
  - applied defensively in `ChatEngine.startTeamRun(...)` so `/mode team` and `/team start` paths also use persistent turn flow.
- Added `/mode team` feedback line when adapters are auto-switched to `agentic`.

### Claude stream-noise fix
- Hardened `parseClaudeChunk(...)` to ignore non-JSON diagnostic lines in stream-json mode.
- Prevents leaking Claude internal runtime lines such as async-launch diagnostics into room messages.

### Prompt quality tweak
- Strengthened debate-step instruction to reduce repetitive check-ins and meta chatter:
  - require one concrete step per turn
  - require explicit teammate handoff when coordination is needed
  - avoid internal tool/runtime log text in agent responses.

### Tests and validation
- Updated adapter parser test:
  - `tests/adapters/claude-stream-parser.test.ts` (non-JSON lines are ignored)
- Added team defaults/CLI behavior coverage:
  - `tests/engine/team-mode.test.ts` (`cli` mode auto-promotes to agentic dispatch in team run)
  - `tests/cmd/team-command.test.ts` (team startup auto-promotes default adapter modes)
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**196/196**)

## What Changed This Session (Codex — team output noise hardening)

### Runtime hardening for noisy agent output
- Added team-specific system prompt overlay in `internal/engine/chat.ts` for internal team dispatches:
  - instructs agents to output only final room-facing content
  - bans bootstrap/process narration, raw file dumps, and system-reminder blocks.
- Fixed persistent-turn gap by injecting system prompt into `sendTurn` prompt payload:
  - team prompt constraints now apply in `agentic|persistent` paths too (not only legacy `send(...)` paths).
- Added team output sanitizer pipeline in `internal/engine/chat.ts`:
  - strips `<system-reminder>...</system-reminder>` blocks
  - strips `N→...` numbered dump lines
  - strips process-chatter lines (bootstrap/check/scan/re-run style progress narration)
  - applies sanitized text before persisting assistant messages/team steps for team dispatches.

### Prompt context cleanup
- `internal/session/service.ts` team prompt now includes only recent **user** context in tail:
  - prevents noisy assistant artifacts from being re-fed and amplified in subsequent team steps.

### CLI render cleanup
- `cmd/agoryx/main.ts` adapter delta renderer now filters:
  - streaming `<system-reminder>` blocks (including split-chunk cases)
  - numbered line-dump artifacts (`N→...`).
  - process-chatter lines while room mode is `team`.
- Keeps regular streaming output intact while reducing diagnostic/log spam in chat UI.

### Tests and validation
- Added new engine test:
  - `tests/engine/team-mode.test.ts` → `team run sanitizes noisy assistant output`
- Added new CLI render test:
  - `tests/cmd/chat-cli.test.ts` → filters streamed `system-reminder` blocks
- Added team CLI render coverage:
  - `tests/cmd/chat-cli.test.ts` → filters process-chatter lines in team mode
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**199/199**)

## What Changed This Session (Codex — mention-priority fix for team first actor)

### Problem
- In `team` mode, first step actor always started from agent order (`codex` first), so `@claude ...` goals still produced Codex as first responder.

### Fix
- Updated `TeamPolicy` (`internal/orchestrator/team.ts`) to seed first actor from goal mentions:
  - parse first valid `@agent` mention from goal text (`@all` ignored)
  - if run has no steps yet, first actor starts from mentioned agent index
  - subsequent turns continue round-robin deterministically
  - resume continuity improved by seeding from `stepCount` when run already has progress.

### Tests and validation
- Added/updated tests:
  - `tests/orchestrator/team.test.ts` → `first actor follows direct @mention in goal`
  - `tests/engine/team-mode.test.ts` → `team auto-start honors @mention for first actor`
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**201/201**)

## What Changed This Session (Codex — modern CLI rendering baseline)

### CLI UX improvements
- Added modern CLI rendering dependencies:
  - `ora` (TTY spinner)
  - `picocolors` (colorized labels)
  - `cli-cursor` (cursor hide/show lifecycle during live rendering)
- Added render options to `cmd/agoryx/main.ts`:
  - `--quiet-system` (hide generating/done/session status lines)
  - `--plain-ui` (disable rich TTY rendering)
  - `--no-color` (disable colorized output)
- Kept non-TTY behavior stable for scripts/tests while enabling richer TTY output:
  - spinner/status flow for live agent generation
  - deferred session-binding status and safe spinner teardown
  - explicit render cleanup on shutdown (stop spinner, restore cursor)

### Tests and validation
- Added `tests/cmd/chat-cli.test.ts` coverage:
  - `chat hides system status lines when --quiet-system is enabled`
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**202/202**)

## What Changed This Session (Codex — explicit team control events)

### Problem observed in live team run
- Agents could keep handing off in `debate` stage ("your turn"/"waiting for @ivan") without a deterministic stop condition.
- Current loop relied on guardrails (`maxSteps`, `maxNoProgressSteps`, `maxDurationMs`) and did not require explicit completion/handoff events.

### Runtime contract update
- `team` debate loop now uses explicit control signals in agent output:
  - `TEAM_DONE` (or stop words `AGORYX_STOP` / `TEAM_STOP`) => finish debate and move to finalize.
  - `TEAM_NEXT:<agent>` => continue debate with the specified next actor.
- If no `TEAM_NEXT` is emitted, Agoryx finalizes the run after the current debate step.
- Added per-run next-actor override memory in engine (`teamNextActorByRun`) and cleanup on approve/stop/loop end.

### Prompt update
- Debate instruction now explicitly requires one control line at the end:
  - `TEAM_NEXT:<agent>` to continue.
  - `TEAM_DONE` to finish/handoff to user.

### Tests and validation
- Updated `tests/engine/team-mode.test.ts`:
  - `team run finalizes after one debate step when no TEAM_NEXT is emitted`
  - `TEAM_DONE control line finalizes run immediately`
  - stabilized active-feedback test with explicit `TEAM_NEXT` in stub response.
- Validation:
  - `npx tsx --test tests/engine/team-mode.test.ts` PASS (**9/9**)
  - `npm test` PASS (**204/204**)

## What Changed This Session (Codex — live in-flight indicator after first delta)

### Problem
- In rich TTY UI, spinner status was hidden as soon as first `message.delta` arrived, so users lost visible "agent still working" feedback mid-stream.

### Fix
- Updated `cmd/agoryx/main.ts` rendering flow:
  - on first delta, spinner now transitions via `stopAndPersist(...)` instead of being silently removed
  - persisted line keeps `[agent] generating...` visible until completion
  - completion/error paths continue to stop spinner safely and render final state.

### Tests and validation
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**206/206**)

## What Changed This Session (Codex — team interruption + correction control)

### Runtime changes
- Added `ChatEngine.interruptTeamRun(feedback?, runId?)`:
  - queues optional user correction to `team_feedback_queue`
  - best-effort cancels the currently active team dispatch (`adapter.cancel(requestId)`)
  - returns structured status (`interrupted`, `feedbackQueued`).
- Added active-dispatch tracking for team runs (`runId -> adapter/request/stage`) and interrupted-request markers.
- Debate/finalize execution now handles user-cancelled requests as interruption events (avoids accidental finalize on missing `TEAM_NEXT` after cancel).
- Guardrail finalize path now defers while pending human feedback exists, so correction can be applied in the next debate step.
- `teamStop()` now triggers best-effort cancellation of in-flight team dispatch.

### CLI/UX changes
- In `team` mode, free-text input during an active run now does:
  - **interrupt active step**
  - **queue feedback**
  instead of queue-only behavior.
- Added explicit command: `/team interrupt [feedback]`.
- Added `Esc` hotkey for interactive TTY:
  - when a team run is active, pressing `Esc` interrupts the current team step.
- Updated help/usage text to include `interrupt`.

### Tests/docs
- Updated tests:
  - `tests/engine/team-mode.test.ts`:
    - `interruptTeamRun cancels active step and injects feedback into the next step`
  - `tests/cmd/team-command.test.ts`:
    - usage includes `interrupt`
    - `/team interrupt` no-active-run path.
- Updated docs:
  - `README.md`
  - `docs/ARCHITECTURE.md`
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**206/206**)

## What Changed This Session (Codex — removed finalize step from team loop)

### Product change requested by Ivan
- Team runtime should not perform a dedicated `finalize` agent call.
- Completion must be driven by explicit control events in debate output (`TEAM_NEXT` / `TEAM_DONE`) with no extra summary round.

### Runtime changes
- `internal/engine/chat.ts`:
  - removed `finalizeTeamRun(...)` dispatch path
  - added direct completion path `completeTeamRun(...)`:
    - sets run to `waiting_user_input` immediately
    - stores `finalSummary` from current debate output (fallback to reason string)
  - control behavior:
    - `TEAM_DONE` (or stop words) => immediate completion
    - missing `TEAM_NEXT` => immediate completion
    - guardrail hit => immediate completion
- Active team dispatch tracking now applies only to `debate` stage (no `finalize` stage dispatch remains).

### Tests and docs
- Updated `tests/engine/team-mode.test.ts` expectations:
  - one debate call only for completion cases (no extra finalize call)
  - step count remains `1` in completion scenarios
  - interruption flow now expects two calls (stalled + corrected) instead of three.
- Updated design note:
  - `docs/plans/2026-02-18-team-runtime-design.md` now states direct transition to `waiting_user_input` from debate.
- Validation:
  - `npm run typecheck` PASS
  - `npx tsx --test tests/engine/team-mode.test.ts` PASS (**10/10**)
  - `npm test` PASS (**206/206**)

## What Changed This Session (Codex — interactive agentic background sessions)

### Runtime changes
- `agentic` mode now keeps adapters alive between turns instead of spawn-per-turn resume:
  - `internal/adapters/codex/index.ts`: added long-lived `codex app-server` transport with JSON-RPC turn dispatch (`sendUserMessage`), delta streaming, interrupt support, and session reuse.
  - `internal/adapters/claude/index.ts`: added long-lived Claude stream-json transport (`--print --input-format stream-json --output-format stream-json`) with per-turn streaming input, delta/result parsing, and interrupt support.
- Preserved existing behavior for non-agentic paths:
  - `cli`/`persistent` still use existing one-shot spawn paths.
- Added adapter lifecycle cleanup on shutdown:
  - `internal/engine/chat.ts`: `shutdown()` now destroys active native adapter sessions when adapters implement `destroy(...)`.
  - `internal/session/service.ts`: added `listActiveAgentSessions(...)` passthrough for shutdown cleanup.
- Added utility:
  - `internal/adapters/async-queue.ts` for internal async streaming coordination in interactive adapter paths.

### Tests and validation
- Added/updated tests:
  - `tests/adapters/codex-resume.test.ts` — app-server args coverage.
  - `tests/adapters/claude-resume.test.ts` — interactive spawn/input envelope coverage.
  - `tests/engine/persistent-session.test.ts` — shutdown destroys active native session handles.
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**211/211**)

## What Changed This Session (Codex — interactive transport hotfixes)

### Fixes
- `internal/adapters/codex/index.ts`:
  - Added `addConversationListener` binding in app-server runner initialization (with fallback request shape).
  - Added parsing for `codex/event/*` envelope events:
    - `agent_message_delta`, `agent_message`, `task_complete`, `turn_aborted`, `error`, `session_configured`.
  - Added listener cleanup on shutdown.
  - Result: prevents `agentic` Codex turns from hanging until timeout due missing completion events.
- `internal/adapters/claude/index.ts`:
  - Extended stream parser to read nested `stream_event` payloads.
  - Added `event/data/delta` recursion paths in extraction helper.
  - Result: restores streaming delta extraction where Claude emits nested stream events.
- `internal/adapters/parse-output.ts`:
  - Added generic support for nested `event` nodes in normalized text extraction.

### Tests and validation
- Updated parser coverage:
  - `tests/adapters/parse-output.test.ts` adds `stream_event` nested delta case.
- Validation:
  - `npm run typecheck` PASS
  - `npm test` PASS (**212/212**)

## What Changed This Session (Codex — addressed review findings)

### Fix 1: shutdown now cancels in-flight team step before waiting
- `internal/engine/chat.ts`
  - `shutdown()` now calls `interruptTeamRun(...)` for active runs before awaiting team loop completion.
  - This prevents `/quit` from hanging on long/stalled adapter turns until timeout.

### Fix 2: do not enqueue feedback while run is `waiting_user_input`
- `internal/engine/chat.ts`
  - `processUserMessage()` now enqueues team feedback only when run status is `active`.
  - If run status is `waiting_user_input`, message is saved to room history but not pushed to `team_feedback_queue`.
- `cmd/agoryx/main.ts`
  - Team free-text UX now reports `waiting for approval` instead of incorrectly saying feedback was queued.

### Tests added
- `tests/engine/team-mode.test.ts`
  - `waiting_user_input run does not enqueue team feedback`
  - `shutdown interrupts active team step before awaiting loop completion`
- `tests/cmd/team-command.test.ts`
  - `free-text in waiting_user_input run does not claim feedback was queued`

### Validation
- `npx tsx --test tests/engine/team-mode.test.ts tests/cmd/team-command.test.ts` PASS (**18/18**)
- `npm test` PASS (**215/215**)

## What Changed This Session (Codex — review hardening pass)

### Scope
- Verified Claude review items against current runtime implementation and fixed confirmed Critical + Important issues in adapters, engine, session, storage, and CLI.

### Fixes delivered
- `internal/adapters/claude/index.ts`, `internal/adapters/codex/index.ts`:
  - fixed one-shot/resume close-listener race by capturing `exitPromise` immediately after spawn (all 4 occurrences).
  - capped interactive stderr accumulation to avoid unbounded growth; snapshots remain tail-based.
  - removed request-status race under overlap via active-request accounting.
  - improved `cancel()` semantics by waiting for request cleanup after kill/interrupt.
- `internal/adapters/codex/index.ts`:
  - added `buildCodexSpawnEnv(...)` and switched codex spawn/app-server paths to sanitized env (parity with Claude env filtering).
- `internal/engine/chat.ts`:
  - fixed team adapter mode leakage: added snapshot/restore so temporary CLI→agentic promotion is reverted when run completes/stops/fails/approved/shutdown.
  - fixed `teamStop()` fire-and-forget unhandled rejection risk with explicit catch.
- `internal/session/service.ts`:
  - `buildTeamPrompt()` now uses recent messages path, so tail context is newest user context (not oldest window).
- `internal/storage/sqlite.ts`:
  - enabled `PRAGMA foreign_keys = ON`.
- `cmd/agoryx/main.ts`:
  - removed `engine!` temporal hazard via safe engine reference in callback.
  - `/team start` failure now logs to stderr.
  - `/team status` elapsed time now guards invalid timestamps (no `NaN` output).
  - Esc interrupt hotkey now guards against unhandled promise rejection.

### Validation
- `npm run typecheck` PASS
- `npm test` PASS (**218/218**)

## What Changed This Session (Codex — review follow-up fixes)

### Scope
- Implemented fixes for three new review findings in team runtime/state handling and storage constraints.

### Fixes delivered
- `internal/engine/chat.ts`:
  - `setMode(...)` now stops an active team run when switching from `team` to another mode.
  - team debate flow now marks failed dispatches as run status `failed` with the real error summary (instead of falling through to generic `waiting_user_input` completion).
  - added a stop-flag pre-dispatch guard to avoid launching new debate dispatches after stop has been requested.
- `internal/storage/sqlite.ts`:
  - removed unconditional `idx_team_runs_single_active` enforcement via startup `DROP INDEX IF EXISTS`, so storage no longer contradicts `team.singleActive=false` runtime behavior.
- `tests/engine/team-mode.test.ts`:
  - added regression: failed team dispatch marks run as `failed`.
  - added regression: `setMode("manual")` stops and cancels active team run.
- `tests/storage/team-runs.test.ts`:
  - updated storage expectation to allow parallel active runs when runtime policy allows it.

### Validation
- `npx tsx --test tests/engine/team-mode.test.ts tests/storage/team-runs.test.ts` PASS (**19/19**)
- `npm run typecheck` PASS
- `npm test` PASS (**220/220**)

## What Changed This Session (Codex — engine modularization + logger scaffold)

### Scope
- Refactored `ChatEngine` god-object internals into dedicated modules without changing public behavior.

### Fixes delivered
- `internal/engine/dispatch-engine.ts`:
  - extracted dispatch execution paths (`runDispatch`, `runPromptDispatch`, legacy/persistent flows, retry handling, error normalization).
- `internal/engine/team-orchestrator.ts`:
  - extracted team runtime state machine (run lifecycle, loop execution, interrupt/feedback handling, TEAM_NEXT/TEAM_DONE control parsing).
- `internal/engine/lifecycle.ts`:
  - extracted shutdown/lifecycle concerns (active team stop + adapter session destroy).
- `internal/engine/types.ts`:
  - centralized engine contracts previously embedded in `chat.ts`.
- `internal/engine/logger.ts`:
  - added structured logger scaffold with env-gated activation (`AGORYX_ENGINE_LOG`) and null logger default.
- `internal/engine/chat.ts`:
  - reduced to orchestration facade delegating to the new modules; public API preserved.

### Validation
- `npm run typecheck` PASS
- `npx tsx --test tests/engine/team-mode.test.ts tests/engine/persistent-session.test.ts tests/engine/retry-flow.test.ts` PASS
- `npm test` PASS (**220/220**)

## Last Updated
2026-02-18T14:10:09Z by codex
