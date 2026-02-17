# Shared Session State

## Active Goal
Запустити MVP Agoryx як local-first CLI для спільного чату між `codex` і `claude` через існуючі CLI-підписки.

## Current Phase
**AUTO MODE VALIDATED** — all foundation complete + auto mode live smoke-test passed (15/15 scenarios: mentions, skill routing, broadcast, fallback, Ukrainian keywords).

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
- `SessionService.buildContextMessages()` тепер делегує до `buildContext()` з `context.ts`
- Додано `buildFullContext()` для діагностики (повертає `BuiltContext` з token stats)
- `ChatEngine.runDispatch()` передає `systemPrompt` з adapter config для точного token budget
- Порядок виклику змінено: `resolveAdapterConfig` → `buildContextMessages` (щоб мати systemPrompt)

### Task 2: Config unification
- Додано `toRuntimeConfig(config, overrides?)` в `internal/config/index.ts`
- Єдиний pipeline: `loadConfig()` → `toRuntimeConfig()` → `new ChatEngine()`
- `default.ts` зберігає `ChatRuntimeConfig` type (engine contract), `index.ts` — все інше (loader, defaults, conversion)

## What Changed This Session (Codex)

### Task 1: Adapter contract tests
- Додано `tests/adapters/parse-output.test.ts` (json/plain parsing coverage)
- Додано `tests/adapters/event-factory.test.ts` (event envelope/payload checks)
- Додано `tests/adapters/stub-contract.test.ts` (codex/claude stub event sequence contract)
- Повний test suite: **10/10 pass**

### Task 2: CLI sessions commands
- Додано `sessions list` і `sessions export` у `cmd/agoryx/main.ts`
- `sessions export` підтримує `room_id` і `session_id` (через `resolveRoomId`)
- Підтримані формати: `markdown`, `json`; опційний `--out`
- Додано npm scripts: `npm run cli`, `npm run sessions`

### Task 3: Unified config pipeline in CLI
- `cmd/agoryx/main.ts` переведено на `loadConfig()` + `toRuntimeConfig()`
- Додано CLI параметр `--config`
- Усунено попередні typecheck проблеми в `cmd/agoryx/main.ts`

## What Changed This Session (Claude — code review fixes)

### Bugfix 1: Deep merge agents config (P1)
- `mergeConfig()` тепер робить per-agent deep merge замість shallow spread
- Додано `mergeAgents()` helper з підтримкою нових агентів (fills missing fields з `AGENT_DEFAULTS`)
- Файл: `internal/config/index.ts`

### Bugfix 2: systemPrompt propagation (P2)
- `buildContext()` тепер prepend-ить systemPrompt як перший system message в `messages` масив
- Раніше systemPrompt тільки вираховувався з token budget, але не включався в output
- Файл: `internal/session/context.ts`

### Tests
- Додано `tests/config/merge.test.ts` (3 тести: partial merge, adapter config, new agent defaults)
- Додано `tests/adapters/system-prompt.test.ts` (2 тести: context builder includes systemPrompt, adapter receives it)
- Total: 18/18 tests pass, typecheck clean

## What Changed This Session (Codex — sessions export extraction)

### Task: sessions export rendering extraction
- Винесено рендер export в окремий модуль `cmd/agoryx/session-export.ts`
- `cmd/agoryx/main.ts` переведено на `renderSessionAsJson()` і `renderSessionAsMarkdown()`
- Додано `tests/cmd/session-export.test.ts` (3 тести: markdown full, markdown skip optional, json shape)

## What Changed This Session (Claude — sessions export test coverage)

### Task: comprehensive test coverage for session-export renderers
- Додано `tests/export/render.test.ts` (14 тестів):
  - markdown: full export, omit pinned, omit checkpoint, empty summaryText, empty messages, message order, multiple pins
  - json: top-level fields, null checkpoint, message field preservation, empty arrays, room config serialization
  - exportedAt injection testability
- Validation: `npm run typecheck` + `npm test` => **34/34 pass**

## What Changed This Session (Codex — adapter retry flow hardening)

### Task: `/retry` end-to-end behavior + recovery
- `ChatEngine.retryFailed()` тепер робить реальний retry-dispatch:
  - знаходить останній unresolved failed request для adapter
  - робить best-effort `adapter.cancel(failedRequestId)` перед retry
  - запускає новий dispatch з новим `requestId` і повертає `RetryResult`
- `runDispatch()` повертає помилки з error class (`TIMEOUT`, `PROCESS_CRASH`, ...) у форматі `CLASS: message`
- `SQLiteStore.getLastFailedRequest()` тепер вважає failure resolved, якщо після `message.error` був `message.completed` для того ж adapter/source
- CLI `/retry` тепер:
  - реально виконує retry
  - показує `retry succeeded/failed` з mapping `failedRequestId -> new requestId`
- Додано `tests/engine/retry-flow.test.ts`:
  - recovery сценарії для `TIMEOUT` і `PROCESS_CRASH`
  - перевірка cleanup через `cancel()`
  - перевірка що successful retry очищає active failure marker
  - перевірка `retryFailed()` повертає `null`, якщо unresolved failures немає
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
  - Додано підтримку `result` і `item` на top-level candidates
  - Додано recursive extraction для nested полів (`message.content[]`, `item.content[]`, nested `message/item/result`)
- `internal/adapters/claude/index.ts`
  - Spawn args тепер включають `--verbose` для `--output-format stream-json`
  - `CLAUDECODE` видаляється з env перед spawn (`buildClaudeSpawnEnv`)
- Tests:
  - Оновлено `tests/adapters/parse-output.test.ts` (нові кейси: codex `item.text`, claude `message.content`, claude `result`)
  - Додано `tests/adapters/claude-cli.test.ts` (`--verbose` args + env sanitization)
  - Validation: `npm run typecheck` + `npm test` => **39/39 pass**

## What Changed This Session (Claude — smoke-test re-run PASS)

### Re-run results after Codex hotfixes
- **Parser isolated test**: codex `item.text` → extracted, claude `message.content` → extracted, claude `result` → extracted
- **Codex CLI mode**: PASS — `@codex say hello` → `Hello` (reasoning text також потрапляє — minor refinement)
- **Claude CLI mode**: PASS — `@claude say hello` → `Привіт` (text подвоюється через assistant+result — minor refinement)
- **Both adapters together**: PASS — `@codex @claude say hello` → обидва відповідають послідовно, бачать контекст один одного

### Minor refinements (not blockers)
1. Codex reasoning items (`type:"reasoning"`) потрапляють у відповідь поряд з `agent_message` — варто фільтрувати
2. Claude text подвоюється (з `assistant` message і з `result` event) — варто дедуплікувати

## What Changed This Session (Codex — CLI parser polish)

### Fixes delivered
- `internal/adapters/parse-output.ts`
  - Додано фільтр reasoning payloads (`type` matches `reasoning`) — такі блоки більше не повертаються як user-visible text
  - Збережено extraction звичайного text-контенту в mixed payloads (reasoning + text)
- `internal/adapters/claude/index.ts`
  - Додано `parseClaudeChunk()` з окремим `deltaText` і `resultText`
  - `result` event більше не емітиться як delta (прибрано дублювання)
  - `resultText` використовується як fallback тільки якщо delta-потік порожній
- Tests:
  - Оновлено `tests/adapters/parse-output.test.ts` (reasoning ignore + mixed content keep-text cases)
  - Додано `tests/adapters/claude-stream-parser.test.ts` (assistant+result dedupe, result-only fallback, non-json passthrough)
  - Validation: `npm run typecheck` + `npm test` => **44/44 pass**

## What Changed This Session (Codex — in-chat /export command)

### Fixes delivered
- `cmd/agoryx/main.ts`
  - Додано in-chat команду `/export [markdown|json] [--out <file>]`
  - `/export` без `--out` друкує експорт поточної сесії в консоль
  - `/export --out <file>` пише експорт у файл і підтверджує шлях
  - `sessions export` переведено на спільний renderer/collector pipeline
- `cmd/agoryx/session-export.ts`
  - Додано єдиний контракт: `normalizeExportFormat`, `parseExportCommandArgs`
  - Додано `collectTargetExportData` і `collectRoomExportData` для уніфікованого збору даних
  - Додано `renderSessionExport(format)` як єдину точку рендеру markdown/json
- Tests:
  - Оновлено `tests/export/render.test.ts`:
    - покриття parser-ів аргументів `/export`
    - покриття format normalizer-а
    - покриття collect helper-ів (resolve через session_id, error path)
    - покриття `renderSessionExport` format switch
  - Validation: `npm run typecheck` + `npm test` => **49/49 pass**

## What Changed This Session (Claude — auto mode smart routing)

### Auto mode implementation
- Повний rewrite `internal/orchestrator/auto.ts` — two-pass routing algorithm:
  1. Mention pass: `@all` → broadcast, `@agent` → deduplicated dispatch
  2. Skill match: keyword scoring per agent, best score wins, tie → first in config order
  3. Fallback: round-robin rotation (index advances only on fallback, per-room)
- Punctuation normalization при word split (strip non-letter chars)
- Short keyword filter (<3 chars ignored unless whitelisted: ui, ux, db)
- `SKILL_KEYWORDS` dictionary з 14 skills (включно з українськими keywords)

### Config layer changes
- `AgentEntry.skills?: string[]` — optional skill tags per agent
- `DEFAULT_AGENT_SKILLS` — hardcoded defaults для codex (code/debug/test) і claude (architecture/review/explain)
- `resolveAgentSkills(config, activeAgents?)` — three-level fallback: config → defaults → []
- `ChatRuntimeConfig.agentSkills` — propagated through `toRuntimeConfig()`

### Factory + Engine integration
- `PolicyOptions` interface в `factory.ts`, `createPolicy(mode, options?)` передає skills до AutoPolicy
- `ChatEngine.init()` і `setMode()` прокидають `config.agentSkills` при створенні policy

### Tests
- `tests/orchestrator/auto.test.ts` — 13 тестів: mentions (5), skill routing (5), fallback (3)
- `tests/config/merge.test.ts` — +3 тести: skills override, defaults fallback, new agent empty
- Validation: `npm run typecheck` + `npm test` => **65/65 pass**

### Design docs
- `docs/plans/2026-02-17-auto-mode-design.md` — повний дизайн-документ
- `docs/plans/2026-02-17-auto-mode-plan.md` — implementation plan з 7 задачами

## Decision Lock (2026-02-17)
- `auto` mode для v0.1 = **smart routing**, а не broadcast:
  - на кожне user message обирається один найрелевантніший агент (`codex` або `claude`) за deterministic heuristics (intent/keywords + recent context)
  - fallback при low confidence: round-robin rotation
- Agent-to-agent autonomous chaining/debate **не входить у v0.1** (deferred).
- Джерело істини: `docs/ARCHITECTURE.md` (section `v0.1 Policies`).

## What Changed This Session (Codex — /export review follow-ups)

### Fixes delivered
- `cmd/agoryx/session-export.ts`
  - `parseExportCommandArgs()` тепер відхиляє duplicate `--out` (замість silent overwrite)
  - Додано comments для `normalizeExportFormat()` semantics (default vs reject)
  - Ліміт export messages винесено в `EXPORT_MESSAGE_LIMIT` з явним поясненням
- `tests/export/render.test.ts`
  - Додано test: duplicate `--out` → `null`
  - Додано test: `collectTargetExportData` кидає помилку для unknown target id
- Validation: `npm run typecheck` + `npm test` => **67/67 pass**

## What Changed This Session (Codex — auto smoke-test + CLI hardening)

### Live smoke-test (auto mode, real adapters)
- Запущено `auto` mode з `--adapter-mode cli` (реальні `codex` + `claude`) у PTY-сесії.
- Перевірено всі 3 гілки маршрутизації:
  - Mention pass: `@codex` → `codex`, `@claude` → `claude`
  - Skill pass: `напиши функцію...` → `codex`, `поясни архітектуру...` → `claude`
  - Fallback pass: `привіт` → `codex`, наступне нейтральне `ок` → `claude` (round-robin rotation)
- Висновок: контракт smart routing в live CLI середовищі працює як задумано.

### CLI hardening
- `cmd/agoryx/main.ts`
  - Додано graceful EOF handling для non-interactive stdin (`readline was closed` більше не валить процес).
  - Додано alias `/checkpoint` для існуючої логіки `/summary`.
  - Оновлено `/help` (показує `/checkpoint`).
- `tests/cmd/chat-cli.test.ts`
  - Додано інтеграційний тест clean exit на stdin EOF після одного повідомлення.
  - Додано інтеграційний тест `/checkpoint` alias.
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
  - `напиши функцію додавання` → codex (skill: UKR write/code) ✅
  - `поясни SOLID принципи` → claude (skill: UKR explain) ✅
  - `привіт` → codex (fallback #0) ✅
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

## Known Issues
- Немає блокерів. CLI mode працює для обох адаптерів.
- SKILL_KEYWORDS dictionary — статичний, може потребувати тюнінгу після real-world testing

## Open Questions
- Немає.

## Next Step
1. Claude: context/checkpoint algorithm block:
   - fix token double-count у `internal/session/context.ts`
   - dedup/overlap guard у `maybeCreateCheckpoint()`
   - structured summary generation + edge-case tests
2. Joint validation:
   - smoke-test `/summary` + `/history` у CLI mode після обох блоків.

## Active Plan (2026-02-17)
- **Claude (session + context):**
  1. Fix token double-count bug in `context.ts`
  2. Add dedup/overlap guards in `maybeCreateCheckpoint()`
  3. Replace raw transcript clipping with structured summary extraction
  4. Add context builder tests: long dialogue, rollover, pinned+summary, token-budget edges
- **Codex (storage + engine):**
  1. Optimize message access with `listMessagesAfter(roomId, afterMessageId)`
  2. Add `getCheckpointCoverage(roomId)` for latest checkpoint range checks
  3. Run CLI smoke-test for `/summary` + `/history`
  4. Adapt engine/session only if required by the storage contract
- **Execution order:**
  1. Codex storage API changes first
  2. Claude algorithm/context changes second
  3. Final smoke validation together

## Last Updated
2026-02-17T11:29:17Z by codex
