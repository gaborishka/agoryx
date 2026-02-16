# Agoryx

Agoryx is a local-first multi-agent chat orchestrator.

Current scaffold (`v0.1-dev`) provides:
- CLI entrypoint: `agoryx chat`
- Policies: `manual`, `round-robin`, `auto`
- SQLite persistence (`better-sqlite3`)
- Stub transport adapters for `codex` and `claude`
- Event logging and basic context building

## Quick Start

```bash
npm install
npm run chat -- --agents codex,claude --mode manual
```

## Session Commands

```bash
# List recent sessions
npm run sessions -- list --limit 20

# Export a session (session id or room id)
npm run sessions -- export <room_or_session_id> --format markdown --out ./export.md
```

## Notes
- Adapters are intentionally stubbed in this scaffold to keep integration safe and deterministic.
- The architecture and consensus docs are in `docs/`.
- CLI parser currently supports `--key value` syntax (not `--key=value`) in this MVP.
