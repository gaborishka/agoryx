# Agent.md

Цей файл потрібен, щоб у нових сесіях не відновлювати контекст вручну.
Він описує, як працювати над Agoryx у зв'язці Codex + Claude.

## Мета проєкту
- Agoryx = local-first open-source груповий чат для людини і кількох LLM.
- Стратегія v0.1: CLI-wrapper поверх існуючих підписок (`codex`, `claude`), без обов'язкових API keys.

## Зафіксовані рішення
- Мова: `TypeScript (Node.js)`.
- Persistence: `SQLite` через `better-sqlite3`.
- Архітектура: `Transport -> Session -> Orchestration`.
- Layout: `cmd/` + `internal/` (не використовувати `src/`).
- Режими v0.1: `manual`, `round-robin`, `auto`.

## Файли істини
- `docs/CONSENSUS.md` — рішення і межі v0.1.
- `docs/ARCHITECTURE.md` — технічний контракт.
- `bridge/SESSION.md` — поточний стан.
- `bridge/LOG.md` — журнал хендоверів (append-only).
- `bridge/PROTOCOL.md` — правила bridge.

## Обов'язковий bootstrap для будь-якого агента
1. Прочитати `bridge/SESSION.md`.
2. Прочитати останні 2-3 записи з `bridge/LOG.md`.
3. Звірити `docs/CONSENSUS.md` і `docs/ARCHITECTURE.md`.
4. Перевірити `git status` і поточне дерево файлів перед змінами.

## Протокол співпраці Codex + Claude
1. Після суттєвої роботи оновити `bridge/SESSION.md`.
2. Додати запис у кінець `bridge/LOG.md` (ніколи не перезаписувати лог).
3. Якщо `SESSION.md` і `LOG.md` конфліктують: пріоритет має останній (нижній) запис у `LOG.md`.
4. Порядок істини в `LOG.md` визначається порядком рядків (append order), не timestamp.

Швидкий запис у лог:
```bash
./scripts/bridge-note.sh <agent> "<summary>" "<changes>" "<risks>" "<next>"
```

## Правило комунікації з Ivan
- У чат писати тільки у двох випадках:
1. Потрібне рішення/допомога (блокер).
2. Потрібно показати готовий результат.
- Весь інший обмін між агентами вести через `bridge/*` файли.

## Правила безпечної паралельної роботи
- Не створювати альтернативні шари/дублікати структури.
- Перед редагуванням файлу спочатку прочитати його поточний стан.
- Якщо з'явились неочікувані паралельні зміни — зупинитись і запросити рішення Ivan.
- Не видаляти/не переписувати чужі зміни без узгодження.

## Технічний baseline (стан scaffold)
- Працює: `npm run typecheck`, `npm test`, базовий `agoryx chat` у stub mode.
- Основні модулі:
- `cmd/agoryx/main.ts` — CLI.
- `internal/engine/chat.ts` — chat engine.
- `internal/adapters/*` — Codex/Claude adapters.
- `internal/storage/sqlite.ts` — SQLite store + events log.
- `internal/session/*` — service/context.
- `internal/orchestrator/*` — policies + orchestration.

## Найближчі пріоритети
1. Інтегрувати `internal/session/context.ts` прямо в `internal/engine/chat.ts`.
2. Уніфікувати config (`internal/config/default.ts` + `internal/config/index.ts`) в один чистий контракт.
3. Додати adapter contract tests (normalization/parsing/error cases).
4. Додати CLI команди `sessions list` і `sessions export`.
