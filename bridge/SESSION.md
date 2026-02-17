# Shared Session State

## Active Goal
Запустити MVP Agoryx як local-first CLI для спільного чату між `codex` і `claude` через існуючі CLI-підписки.

## Current Phase
**FOUNDATION + CLI POLISH COMPLETE** — context/config інтегровані, adapter tests + sessions CLI реалізовані, retry flow додано, CLI mode smoke-test pass + minor parser refinements закриті.

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

## Known Issues
- Немає блокерів. CLI mode працює для обох адаптерів.
- SKILL_KEYWORDS dictionary — статичний, може потребувати тюнінгу після real-world testing

## Open Questions
- Немає.

## Next Step
1. Live smoke-test auto mode з реальними агентами.
2. Визначити наступний блок (пропозиція: in-chat commands /pin /checkpoint /help, або checkpoint auto-creation).

## Last Updated
2026-02-17T18:00:00Z by claude
