# Claude — Agoryx context

Read [AGENTS.md](AGENTS.md) first. It is the shared contributor guide for the current 0.1.1 product.

Agoryx coordinates a human and multiple native agents. Ordinary Chat/Work sessions retain their native tools and conversation context. Verification, Council, Tournament and Debate use independent, system-isolated phases with session-specific roles.

The main runtime is `cmd/agoryx/agora.ts` and `internal/agora/`, with JSONL event persistence, HTTP/SSE, projects and the shared table. The SQLite `agoryx chat` implementation is a separate compatibility runtime. `ui/src` and `desktop/src` are intentional roots.

Do not assume fixed Claude/Codex implementation ownership or that every room has exactly two agents. Coordinate actual file ownership for the assigned task, preserve other contributors' changes, and keep human decisions distinct from agent recommendations.

- Product: [README](README.md)
- Technical contract: [Architecture](docs/ARCHITECTURE.md)
- Protocols and privacy: [Workflows](docs/WORKFLOWS.md)
- Project memory: [Memory](docs/MEMORY.md)
- Release checks: [Releasing](docs/RELEASING.md)

Historical plans under `docs/archive` are references, not instructions to execute.
