# Agoryx

Local-first, open-source group chat for humans and multiple LLM agents.

Named after Greek **agorá** — the public square where citizens gathered to discuss and decide. Agoryx is a shared conversation where AI agents see each other's messages, respond to each other, and collaborate under human direction.

## Why

Working with multiple LLMs today means copying text between apps and re-explaining context. Agoryx replaces that with one shared room where agents participate together — no API keys required, uses your existing CLI subscriptions.

## Features (v0.1)

- **Two agents:** Codex and Claude, running via their local CLIs
- **Three modes:** `manual` (you choose who responds), `round-robin` (agents alternate), `auto` (smart routing by intent/keywords)
- **Persistent sessions:** SQLite-backed history with checkpoints and structured summaries
- **Context management:** `/pin` and `/unpin` for persistent context, automatic checkpoint summaries
- **Session export:** markdown and JSON formats, in-chat and CLI
- **Retry flow:** `/retry` with automatic cancel of failed requests
- **No API keys:** wraps `codex exec` and `claude -p` using existing authenticated CLIs

## Prerequisites

- Node.js >= 22
- [Codex CLI](https://github.com/openai/codex) installed and authenticated
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Quick Start

```bash
npm install
npm run chat -- --mode auto
```

## CLI Usage

```bash
# Start a chat session
npm run chat -- --mode manual          # you pick who responds with @agent
npm run chat -- --mode round-robin     # agents alternate
npm run chat -- --mode auto            # smart routing (recommended)

# Use real CLI adapters (default is stub mode)
npm run chat -- --adapter-mode cli

# Resume a previous session
npm run chat -- --resume <session_id>

# Custom config file
npm run chat -- --config ./my-config.json
```

## In-Chat Commands

| Command | Description |
|---------|-------------|
| `@codex <msg>` | Direct message to Codex |
| `@claude <msg>` | Direct message to Claude |
| `@all <msg>` | Broadcast to all agents |
| `/mode <manual\|round-robin\|auto>` | Switch orchestration mode |
| `/adapter <agent> <stub\|cli>` | Switch adapter mode per agent |
| `/pin [label] <content>` | Pin persistent context |
| `/unpin <id>` | Remove pinned context |
| `/pins` | List all pinned contexts |
| `/summary` | Create a checkpoint summary |
| `/checkpoint` | Alias for `/summary` |
| `/history` | Show conversation history |
| `/export [markdown\|json] [--out file]` | Export current session |
| `/retry` | Retry last failed agent request |
| `/help` | Show available commands |
| `/quit` or `/exit` | End session |

## Session Management

```bash
# List recent sessions
npm run sessions -- list --limit 20

# Export a session
npm run sessions -- export <room_or_session_id> --format markdown --out ./export.md
```

## Project Structure

```
cmd/agoryx/          CLI entry point
internal/
  adapters/          Codex and Claude CLI adapters, output parser, event factory
  config/            Config loader, defaults, runtime config builder
  engine/            Main chat loop, dispatch, retry
  events/            Canonical event types
  orchestrator/      Policies (manual, round-robin, auto), factory
  session/           Context builder, session service, checkpoint summaries
  storage/           SQLite persistence
tests/               135 tests across 18 files
docs/                Architecture, vision, consensus, design plans
```

## Configuration

Create `agoryx.json` in the project root to customize defaults:

```json
{
  "agents": {
    "codex": {
      "adapter": "cli",
      "skills": ["code", "debug", "test", "refactor"]
    },
    "claude": {
      "adapter": "cli",
      "skills": ["architecture", "review", "explain", "documentation"]
    }
  },
  "session": {
    "dbPath": "./agoryx.db",
    "maxHistoryMessages": 100,
    "checkpointThreshold": 30
  },
  "orchestration": {
    "defaultMode": "auto"
  }
}
```

## Development

```bash
npm run typecheck    # Type check
npm test             # Run all 135 tests
npm run build        # Production build
```

## License

[MIT](LICENSE)
