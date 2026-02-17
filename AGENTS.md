# AGENTS.md

This file exists so new sessions do not require manual context reconstruction.
It describes how to work on Agoryx in Codex + Claude collaboration.

## Project Goal
- Agoryx = local-first open-source group chat for one human and multiple LLMs.
- v0.1 strategy: a CLI wrapper over existing subscriptions (`codex`, `claude`) without mandatory API keys.

## Locked Decisions
- Language: `TypeScript (Node.js)`.
- Persistence: `SQLite` via `better-sqlite3`.
- Architecture: `Transport -> Session -> Orchestration`.
- Layout: `cmd/` + `internal/` (do not use `src/`).
- v0.1 modes: `manual`, `round-robin`, `auto`.

## Source-of-Truth Files
- `docs/CONSENSUS.md` — decisions and scope boundaries for v0.1.
- `docs/ARCHITECTURE.md` — technical contract.
- `bridge/SESSION.md` — current state.
- `bridge/LOG.md` — handover log (append-only).
- `bridge/PROTOCOL.md` — bridge rules.

## Mandatory Bootstrap for Any Agent
1. Read `bridge/SESSION.md`.
2. Read the last 2-3 entries in `bridge/LOG.md`.
3. Cross-check `docs/CONSENSUS.md` and `docs/ARCHITECTURE.md`.
4. Check `git status` and the current file tree before making changes.

## Codex + Claude Collaboration Protocol
1. After substantial work, update `bridge/SESSION.md`.
2. Append a new entry to the end of `bridge/LOG.md` (never overwrite the log).
3. If `SESSION.md` and `LOG.md` conflict, the newest (bottom-most) entry in `LOG.md` has priority.
4. Truth order in `LOG.md` is determined by line order (append order), not timestamps.
5. All communication in Bridge files (`bridge/*`) must be in English.

Quick log entry:
```bash
./scripts/bridge-note.sh <agent> "<summary>" "<changes>" "<risks>" "<next>"
```

## Communication Rule with Ivan
- Write in chat only in two cases:
1. A decision/help is needed (blocker).
2. A completed result is ready to present.
- All other agent-to-agent communication must go through `bridge/*` files in English.

## Safe Parallel Work Rules
- Do not create alternative layers or duplicate project structures.
- Before editing any file, read its current state first.
- If unexpected parallel changes appear, stop and ask Ivan for a decision.
- Do not delete or overwrite other contributors' changes without agreement.

## Technical Baseline (Scaffold State)
- Working: `npm run typecheck`, `npm test`, and basic `agoryx chat` in stub mode.
- Core modules:
- `cmd/agoryx/main.ts` — CLI.
- `internal/engine/chat.ts` — chat engine.
- `internal/adapters/*` — Codex/Claude adapters.
- `internal/storage/sqlite.ts` — SQLite store + events log.
- `internal/session/*` — service/context.
- `internal/orchestrator/*` — policies + orchestration.

## Completed v0.1 Milestones
1. ~~Integrate context builder into engine~~ — done
2. ~~Unify config pipeline~~ — done
3. ~~Adapter contract tests~~ — done
4. ~~Sessions list/export~~ — done
5. ~~Auto mode smart routing~~ — done
6. ~~Checkpoint quality (dedup, cumulative, structured)~~ — done
7. ~~Full command handler test coverage~~ — done
8. ~~CLI mode smoke-tested with real adapters~~ — done

## Current Status
v0.1.0 released. 135/135 tests pass. Next version (v0.2) scope TBD.
