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

## Last Updated
2026-02-17T23:58:14Z by codex
