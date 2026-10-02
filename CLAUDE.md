# Claude — Agoryx Project Context

This file exists so that Claude (Anthropic) can quickly re-orient in any new session without Ivan having to re-explain everything.

## What is Agoryx?

Agoryx is a local-first, open-source group chat for humans and multiple LLM agents. The name comes from Greek ἀγορά (agorá) — the public square where citizens gathered to discuss and decide.

The core problem: working with multiple LLMs today means manually copying text between apps and re-explaining context. Agoryx replaces that with a single shared conversation where agents see each other's messages and can respond to each other.

## Key Technical Decisions

- **Language:** TypeScript (Node.js)
- **Persistence:** SQLite via `better-sqlite3`
- **Architecture:** Three layers — Transport (adapters), Session (context/storage), Orchestration (policies)
- **CLI-wrapper strategy:** Agoryx wraps existing authenticated CLIs (`claude -p`, `codex exec`) so users leverage their subscriptions without API keys
- **Project layout:** `internal/` for core code, `cmd/` for CLI entry — Go-style layout in TypeScript
- **Build:** `tsx` for dev, `tsc` for production build

## Who is Working on This

- **Ivan** (human) — project creator, moderator, makes final decisions
- **Claude** (Anthropic) — session layer, context builder, orchestrator, docs, architecture
- **Codex** (OpenAI) — adapters, CLI integration, storage, chat engine, project infrastructure

## Important Files

| Path | Purpose |
|------|---------|
| `docs/VISION.md` | Project vision, use cases, roadmap |
| `docs/ARCHITECTURE.md` | Technical architecture, event contracts, sequence diagrams |
| `docs/CONSENSUS.md` | Joint decisions between Claude and Codex |
| `internal/events/types.ts` | Canonical type definitions (Codex authored) |
| `internal/session/context.ts` | Context builder algorithm (Claude authored) |
| `internal/config/index.ts` | Config loader and defaults (Claude authored) |
| `internal/orchestrator/index.ts` | Orchestrator class (Claude authored) |
| `internal/adapters/` | CLI adapters for codex and claude (Codex authored) |
| `internal/storage/sqlite.ts` | SQLite persistence (Codex authored) |
| `internal/engine/chat.ts` | Main chat loop (Codex authored) |
| `package.json` | Project config and dependencies |
| `tsconfig.json` | TypeScript config — includes `cmd/` and `internal/` |

## What Claude Is Responsible For

- **Session layer:** context building (how prompts are assembled from history + pinned context + checkpoints)
- **Orchestrator:** the Orchestrator class, mode switching, policy registration
- **Config:** loading config from file, merging with defaults
- **Documentation:** VISION.md, ARCHITECTURE.md, CONSENSUS.md
- **Review:** Codex's code when asked

## What Codex Is Responsible For

- **Adapters:** CLI wrappers for `codex exec --json` and `claude -p --output-format stream-json`
- **Storage:** SQLite schema and CRUD operations
- **Chat engine:** main interaction loop
- **Infrastructure:** package.json, tsconfig, project setup
- **Output parsing:** JSON line extraction from CLI streams

## Communication Style

- Ivan may communicate in Ukrainian in chat.
- Ivan relays messages between agents manually (until Agoryx itself replaces this).
- When Ivan says "Codex said X" — treat it as Codex's actual position.
- Don't duplicate Codex's work. Read the codebase before writing.
- If there's a conflict, flag it and ask Ivan for a decision.

## Common Pitfalls From This Session

1. **Check `internal/` before creating files in `src/`.** The project uses `internal/` layout. `tsconfig.json` only includes `cmd/**/*.ts` and `internal/**/*.ts`.
2. **Read Codex's types first.** The canonical types are in `internal/events/types.ts`. Adapt your code to use those types, don't create parallel type definitions.
3. **`src/` is orphaned.** Claude initially created code there before discovering Codex's layout. Files couldn't be deleted due to permissions. They should be ignored or cleaned up.
4. **Codex works fast and in parallel.** Always check what exists before starting work.

## Quick Start for a New Session

```
1. Read CLAUDE.md (this file)
2. Open current project memory via /memory show (or read .agoryx/memory.md)
3. Check what files exist: find internal/ -name "*.ts" | sort
4. Start working on the task Ivan gives you
5. After finishing: update project memory (/memory note or /memory decision)
```
