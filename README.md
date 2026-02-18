# Agoryx

Local-first, open-source group chat for humans and multiple LLM agents.

Named after Greek **agorá** — the public square where citizens gathered to discuss and decide. Agoryx is a shared conversation where AI agents see each other's messages, respond to each other, and collaborate under human direction.

## Why

Working with multiple LLMs today means copying text between apps and re-explaining context. Agoryx replaces that with one shared room where agents participate together — no API keys required, uses your existing CLI subscriptions.

## Features (v0.2)

- **Two agents:** Codex and Claude, running via their local CLIs
- **Three modes:** `manual` (you choose who responds), `round-robin` (agents alternate), `auto` (smart routing by intent/keywords)
- **Persistent sessions:** SQLite-backed history with checkpoints and structured summaries
- **Context management:** `/pin` and `/unpin` for persistent context, automatic checkpoint summaries
- **Session export:** markdown and JSON formats, in-chat and CLI
- **Retry flow:** `/retry` with automatic cancel of failed requests
- **No API keys:** wraps `codex exec` and `claude -p` using existing authenticated CLIs
- **Team runtime (v0.2):** autonomous `team` mode with proposal gate and resumable team runs
- **Enthusiast defaults:** relaxed team limits by default; strict profile is opt-in (`/team start --strict` or config)
- **Agentic adapter mode:** `agentic` transport mode for persistent turn-based execution with workspace-aware cwd

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
npm run chat -- --mode team            # autonomous team runtime

# Adapter transport modes
npm run chat -- --adapter-mode cli       # default for non-team modes
npm run chat -- --adapter-mode agentic   # explicit persistent+workspace mode
# In team mode, cli adapters are auto-promoted to agentic unless overridden

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
| `/mode <manual\|round-robin\|auto\|team>` | Switch orchestration mode |
| `/adapter <agent> <stub\|cli\|persistent\|agentic>` | Switch adapter mode per agent |
| `/team start <goal> [--strict] [--no-checks]` | Start autonomous team run |
| `/team status` | Show active team run status |
| `/team log [limit]` | Show recent team steps/checks |
| `/team resume` | Resume latest team run |
| `/team approve [run_id]` | Approve proposal and mark run done |
| `/team interrupt [feedback]` | Interrupt active team step and optionally queue correction |
| `/team stop` | Stop active team run |
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

In interactive TTY sessions, pressing `Esc` in `team` mode also interrupts the active team step.

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
  engine/            Chat facade + dispatch, team orchestration, lifecycle modules
  events/            Canonical event types
  orchestrator/      Policies (manual, round-robin, auto, team), factory
  session/           Context builder, session service, checkpoint summaries
  storage/           SQLite persistence
tests/               Comprehensive suite (245 tests)
docs/                Architecture, vision, consensus, design plans
```

## Configuration

Create `agoryx.json` in the project root to customize defaults:

```json
{
  "defaultMode": "team",
  "agents": {
    "codex": {
      "mode": "agentic",
      "workspaceCwd": "/absolute/path/to/workspace",
      "skills": ["code", "debug", "test", "refactor"]
    },
    "claude": {
      "mode": "agentic",
      "workspaceCwd": "/absolute/path/to/workspace",
      "skills": ["architecture", "review", "explain", "documentation"]
    }
  },
  "context": {
    "maxHistoryMessages": 100,
    "checkpointThreshold": 30,
    "maxContextTokens": 30000
  },
  "session": {
    "dbPath": "./agoryx.db"
  },
  "team": {
    "profile": "enthusiast",
    "maxSteps": 24,
    "maxNoProgressSteps": 8,
    "maxDurationMs": 3600000,
    "checksEnabledByDefault": false,
    "checkCommands": ["npm run typecheck", "npm test"],
    "strict": {
      "maxSteps": 8,
      "maxNoProgressSteps": 2,
      "maxDurationMs": 900000,
      "checksEnabledByDefault": true
    },
    "singleActive": true,
    "trigger": {
      "autoOnMessage": true,
      "commandStart": true
    }
  }
}
```

## Development

```bash
npm run typecheck    # Type check
npm test             # Run all tests
npm run build        # Production build
npm run verify       # Release gate: typecheck + build + test
```

## License

[MIT](LICENSE)
