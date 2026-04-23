# Pi-mono vs Agoryx: порівняльний аналіз

## 1. Концептуальна близькість

### Що спільного

Обидва проєкти вирішують одну **метапроблему**: зробити роботу з LLM-агентами зручною, локальною і розширюваною. На рівні архітектури вони дивовижно схожі:

| Аспект | Pi-mono | Agoryx |
|--------|---------|--------|
| Мова | TypeScript (Node.js, ESM) | TypeScript (Node.js, ESM) |
| Архітектура | Шаруватий поділ: ai → agent → coding-agent | Три шари: Transport → Session → Orchestration |
| Персистентність | JSONL (append-only, з деревом гілок) | SQLite (append-only events_log) |
| CLI-стратегія | **Сам є CLI-агентом** (пряме використання API) | **Обгортка CLI** (`claude -p`, `codex exec`) |
| Потокова передача | AsyncGenerator → EventStream | AsyncGenerator → EventEnvelope |
| Інструменти (tools) | TypeBox-схеми, name/description/execute | Власний інтерфейс через адаптери |
| Конфігурація | Multi-level (global → project → env) | Multi-level (CLI → env → config → defaults) |
| Контекст-менеджмент | Compaction із summarization | Checkpoint + budget-based context builder |

### Фундаментальна різниця

**Pi-mono** — це **платформа для побудови single-agent додатків** з різними фронтендами (TUI, Web, Slack). Один агент розмовляє з одним користувачем.

**Agoryx** — це **мульти-агентна кімната**: кілька агентів бачать повідомлення одне одного і можуть взаємодіяти. Оркестрація (хто відповідає коли) — ключова ціннісна пропозиція Agoryx.

**Оцінка: ~60% перетин** на рівні інфраструктури (LLM-комунікація, персистентність, контекст, інструменти), але **різні продуктові вектори** (single-agent toolkit vs multi-agent orchestration).

---

## 2. Що варто скопіювати / адаптувати

### 🔴 Високий пріоритет

#### 2.1. Unified LLM API замість CLI-обгорток

**Що є у Pi:** `@mariozechner/pi-ai` — єдиний API для 20+ провайдерів (OpenAI, Anthropic, Google, Mistral, Bedrock…). Один виклик `streamSimple()` працює з будь-яким LLM.

**Що є у Agoryx:** CLI-обгортки `claude -p` і `codex exec`. Кожен новий агент = новий адаптер з парсингом stdout.

**Рекомендація:** Для v0.4+ розглянути **гібридну стратегію**:
- Зберегти CLI-адаптери як fallback (zero-config UX)
- Додати `direct-api` адаптер, який використовує API-ключі напряму
- Можна навіть обернути `pi-ai` як один з адаптерів Agoryx

**Виграш:** Будь-який LLM стає учасником кімнати. Qwen, Gemini, Mistral, локальні Ollama-моделі — одразу, без CLI.

#### 2.2. Розширювана система інструментів (Tools)

**Що є у Pi:** Уніфікований `AgentTool` з TypeBox-схемами, runtime-валідацією, потоковими оновленнями під час виконання. Інструменти: read, write, edit, bash, grep, find, ls.

**Що є у Agoryx:** Інструменти живуть всередині CLI-агентів. Agoryx не контролює які тули агент використовує.

**Рекомендація:** Додати **shared tool layer** — набір інструментів, які Agoryx надає всім агентам через контекст:
- Workspace tools (read/write файли проєкту)
- Room tools (прочитати повідомлення іншого агента, запинити контекст)
- Memory tools (зберегти/прочитати факт)

**Виграш:** Агенти зможуть **спільно працювати з файлами** і **явно комунікувати** через room tools.

#### 2.3. Система розширень (Extensions) та навичок (Skills)

**Що є у Pi:** Потужний extension API — кастомні інструменти, команди, UI-компоненти, теми, prompt-шаблони. Skills = CLI-тули зі структурованою документацією.

**Що є у Agoryx:** Поки немає формальної системи розширень.

**Рекомендація:** Впровадити **plugin system** для Agoryx:
- Кастомні orchestration policies
- Кастомні адаптери (для нових LLM / сервісів)
- Skills як room-level інструменти
- Prompt templates для системних промптів

### 🟡 Середній пріоритет

#### 2.4. Session branching (дерево розмов)

**Що є у Pi:** JSONL з `id + parentId` → дерево гілок. Команди `/tree`, `/fork` для навігації та розгалуження.

**Що є у Agoryx:** Лінійна історія в SQLite. Checkpoints для summarization, але без гілок.

**Рекомендація:** Додати **branching** — можливість "відкотити" розмову до точки та спробувати інший підхід. Особливо цінно для team mode.

#### 2.5. Web UI компоненти

**Що є у Pi:** `pi-web-ui` — повноцінні web-компоненти для чату (streaming, artifacts, attachments, IndexedDB-сховище).

**Що є у Agoryx:** Запланований web UI (v0.3 roadmap), але ще не реалізований.

**Рекомендація:** Вивчити `pi-web-ui` як референс для Agoryx Web UI. Ключові ідеї:
- Артефакти (HTML, SVG, Markdown) з пісочницею
- Вкладення (PDF, DOCX, XLSX) з text extraction
- CORS proxy для browser-based API calls

#### 2.6. TUI-бібліотека

**Що є у Pi:** `pi-tui` — мінімальний TUI-фреймворк з диференціальним рендерингом, overlays, autocomplete, image rendering.

**Що є у Agoryx:** Ink (React для терміналу).

**Рекомендація:** Ink — це ОК для поточного стану. Але якщо потрібен більш тонкий контроль (overlays, differential rendering), `pi-tui` — хороший приклад як це зробити з нуля.

#### 2.7. Memory system (MEMORY.md)

**Що є у Pi (mom):** Глобальний + per-channel MEMORY.md. Агент самостійно оновлює файли пам'яті.

**Що є у Agoryx:** Вже є `.agoryx/memory.md` (v0.3), але можна розширити.

**Рекомендація:** Перейняти ідею **per-room memory** — кожна кімната має свій MEMORY.md, плюс глобальний для cross-room знань.

### 🟢 Низький пріоритет (цікаві ідеї)

#### 2.8. Pods / Self-hosting LLM

**Що є у Pi:** `pi-pods` — менеджмент vLLM на GPU-подах. Запуск моделей локально або на орендованих GPU.

**Що є у Agoryx:** Немає.

**Рекомендація:** Не пріоритет, але цікаво для майбутнього — "self-hosted agent room" з локальними LLM.

#### 2.9. Event system для зовнішніх тригерів

**Що є у Pi (mom):** Файлова система подій — cron, webhook, one-shot тригери через JSON-файли в `data/events/`.

**Що є у Agoryx:** Немає (тільки user input).

**Рекомендація:** Для daemon mode (v0.4+) — можливість тригерити агентів через зовнішні події (git push, file change, cron, webhook).

#### 2.10. Docker sandbox

**Що є у Pi (mom):** Ізоляція через Docker — команди агента виконуються в контейнері.

**Що є у Agoryx:** Worktree-ізоляція (git-level), але немає process-level sandbox.

**Рекомендація:** Для production-safe deployments — опціональний Docker-sandbox для tool execution.

---

## 3. Що НЕ варто копіювати

1. **Монорепо з 7 пакетами.** Pi — це toolkit для різних продуктів. Agoryx — один продукт. Тримати flat-структуру з `internal/` простіше.

2. **Повний відмова від CLI-обгорток.** CLI-стратегія Agoryx — це унікальна перевага (zero API keys). Її варто **доповнити**, не **замінити**.

3. **Declaration merging для повідомлень.** Елегантно, але крихко. Agoryx вже має добрий union type для подій. Краще тримати його explicit.

4. **JSONL замість SQLite.** SQLite дає індекси, запити, транзакції. Для multi-agent room з checkpoints і pinned context — SQLite набагато краще.

---

## 4. Стратегічна матриця

```
                    Pi-mono                     Agoryx
                    ───────                     ──────
LLM Access:         Direct API (20+ providers)  CLI wrappers (2 agents)
Agent Count:         Single agent                Multi-agent room
Orchestration:       N/A                         5 policies (manual→free)
Persistence:         JSONL + branching           SQLite + checkpoints
Tools:               Built-in (read/write/bash)  Delegated to CLI agents
Extensions:          Rich plugin system           Not yet
Web UI:              Full web components          Planned
TUI:                 Custom pi-tui               Ink (React)
Deployment:          CLI + Slack bot + Web        CLI only (v0.3)
Self-hosted LLM:     pi-pods (vLLM)              Not yet
```

---

## 5. Рекомендований план запозичень

### v0.4 (наступний major):
1. ✅ Direct API адаптер (подивитись на `pi-ai` як натхнення)
2. ✅ Shared tool layer для агентів
3. ✅ Session branching

### v0.5+:
4. Plugin/extension system
5. Web UI (з референсом на `pi-web-ui`)
6. External event triggers (для daemon mode)
7. Docker sandbox (опціонально)

---

*Аналіз створено: 2026-03-08*
