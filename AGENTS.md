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
- Modes: `manual`, `round-robin`, `auto`, `team`.

## Source-of-Truth Files
- `docs/CONSENSUS.md` — decisions and scope boundaries for v0.1.
- `docs/ARCHITECTURE.md` — technical contract.
- Project memory (`/memory show`, `.agoryx/memory.md`) — current state and decisions.

## Mandatory Bootstrap for Any Agent
1. Read the project memory (`/memory show` or `.agoryx/memory.md`).
2. Cross-check `docs/CONSENSUS.md` and `docs/ARCHITECTURE.md`.
3. Check `git status` and the current file tree before making changes.

## Codex + Claude Collaboration Protocol
After substantial work, update the project memory (`/memory note` or `/memory decision`).

## Communication Rule with Ivan
- Write in chat only in two cases:
1. A decision/help is needed (blocker).
2. A completed result is ready to present.

## Safe Parallel Work Rules
- Do not create alternative layers or duplicate project structures.
- Before editing any file, read its current state first.
- If unexpected parallel changes appear, stop and ask Ivan for a decision.
- Do not delete or overwrite other contributors' changes without agreement.

## Technical Baseline (Scaffold State)
- Working: `npm run typecheck`, `npm test`, and basic `agoryx chat` in stub mode.
- Core modules:
- `cmd/agoryx/main.ts` — CLI.
- `internal/engine/chat.ts` — chat engine facade.
- `internal/engine/dispatch-engine.ts` — dispatch + retry runtime.
- `internal/engine/team-orchestrator.ts` — team runtime loop/control.
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
v0.2.0 pre-release ready on `feat/v0.2`. Full suite passes (`245/245` tests).
