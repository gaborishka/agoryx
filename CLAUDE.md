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

## Bridge Protocol

We use a file-based bridge to sync context between agents. **On every substantial response:**

1. **Read first:**
   - `bridge/SESSION.md` — current project state (single source of truth)
   - Last entries in `bridge/LOG.md` — recent handover notes

2. **After finishing work:**
   - Update `bridge/SESSION.md` with current state (keep short, only current state)
   - Append a new entry to `bridge/LOG.md` (never overwrite, only append)

3. **LOG format:**
   ```
   ## YYYY-MM-DDTHH:MM:SSZ | claude
   ### Summary
   - What was done
   ### Changes
   - Which files/decisions changed
   ### Risks
   - Risks or limitations
   ### Next
   - What's expected from the other agent/human
   ---
   ```

4. **Rules:**
   - `LOG.md` is append-only, never rewrite
   - `SESSION.md` stays short — current state, not history
   - If SESSION.md and LOG.md conflict, the newest (bottom) LOG entry wins
   - Truth order in LOG.md is determined by line order (append order), not by timestamp in headers

## Important Files

| Path | Purpose |
|------|---------|
| `docs/VISION.md` | Project vision, use cases, roadmap |
| `docs/ARCHITECTURE.md` | Technical architecture, event contracts, sequence diagrams |
| `docs/CONSENSUS.md` | Joint decisions between Claude and Codex |
| `bridge/SESSION.md` | Current project state (read this first!) |
| `bridge/LOG.md` | Handover log between agents |
| `bridge/PROTOCOL.md` | Bridge protocol rules |
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

- Ivan communicates in Ukrainian. Respond in Ukrainian.
- Ivan relays messages between agents manually (until Agoryx itself replaces this).
- When Ivan says "Codex said X" — treat it as Codex's actual position.
- Keep bridge updates factual and concise.
- Don't duplicate Codex's work. Read the codebase before writing.
- If there's a conflict, flag it in bridge and ask Ivan for a decision.

## Common Pitfalls From This Session

1. **Check `internal/` before creating files in `src/`.** The project uses `internal/` layout. `tsconfig.json` only includes `cmd/**/*.ts` and `internal/**/*.ts`.
2. **Read Codex's types first.** The canonical types are in `internal/events/types.ts`. Adapt your code to use those types, don't create parallel type definitions.
3. **`src/` is orphaned.** Claude initially created code there before discovering Codex's layout. Files couldn't be deleted due to permissions. They should be ignored or cleaned up.
4. **Codex works fast and in parallel.** Always read the latest bridge files and check what exists before starting work.

## Quick Start for a New Session

```
1. Read CLAUDE.md (this file)
2. Read bridge/SESSION.md
3. Read last 2-3 entries in bridge/LOG.md
4. Check what files exist: find internal/ -name "*.ts" | sort
5. Start working on the task Ivan gives you
6. After finishing: update SESSION.md + append to LOG.md
```
