# Agoryx

Local-first, open-source group chat for humans and multiple LLM agents.

Named after Greek **agorá** — the public square where citizens gathered to discuss and decide. Agoryx is a shared conversation where AI agents see each other's messages, respond to each other, and collaborate under human direction.

## Why

Working with multiple LLMs today means copying text between apps and re-explaining context. Agoryx replaces that with one shared room where agents participate together — no API keys required, uses your existing CLI subscriptions.

## Features (v0.3)

- **Two agents:** Codex and Claude, running via their local CLIs
- **Five modes:** `free` (the default), `manual`, `round-robin`, `auto`, `team` — switch at runtime with `/mode`
- **Persistent sessions:** SQLite-backed history with checkpoints and structured summaries
- **Context management:** `/pin`, `/unpin`, automatic checkpoint summaries, workspace context injection
- **Project memory:** automatic event capture (dispatches, decisions, errors) with crash recovery and `/memory` commands
- **Workspace awareness:** git branch, status, diffs, and file tree injected into every agent prompt
- **Git worktrees:** isolated per-agent worktrees for safe parallel edits (`/worktree` commands)
- **Team runtime:** autonomous `team` mode with proposal gate, feedback queue, and resumable runs
- **Startup recovery:** automatic room detection, event recovery, worktree reconciliation on restart
- **Session export:** markdown and JSON formats, in-chat and CLI
- **No API keys:** wraps `codex exec` and `claude -p` — uses your existing CLI subscriptions
- **Agentic adapter mode:** persistent turn-based execution with workspace-aware cwd

## Rooms (v0.4 preview)

Claude and Codex in one conversation, each in its own native session, with a shared **table** of
questions, options, objections, evidence and decisions. Agoryx only sets the context. It has no
orchestrator and assigns no roles. Every new message wakes the agents that haven't seen it, and a run
ends when the room goes quiet. Use it headless (`agoryx new`, `say`, `tail -f`, `table`) or through the
local web UI (`agoryx up -d && agoryx open`). See [docs/AGORA.md](docs/AGORA.md).

## macOS app

`Agoryx.app` is the daemon and its room UI in one window, and it works like `agoryx up -d && agoryx open`
from a terminal. It uses the same daemon and rooms, and it reads your login shell's environment, so the agents get
your PATH and keys. Its first screen lists what is missing (Node, the `claude` / `codex` CLIs and their
logins), each with the command that fixes it. Quitting the app leaves the daemon and its rooms running.

```bash
npm run build && npm --prefix desktop install
npm run desktop                  # run it from this checkout
npm --prefix desktop run dist    # build desktop/release/Agoryx.app (unsigned, arm64)
agoryx doctor                    # the same checks, in a terminal
```

The app needs `node` >= 22 on the Mac: the daemon runs on it, not on Electron. See [docs/DESKTOP.md](docs/DESKTOP.md).

## Rooms on a phone

The daemon listens on 127.0.0.1 only unless you open it up. Either way a phone gets in only after you pair it.

```bash
# Same Wi-Fi (plain http: no notifications)
agoryx up -d --lan

# Anywhere on your tailnet, over HTTPS (notifications work)
agoryx up -d --tailscale          # accepts this Mac's <machine>.<tailnet>.ts.net name
tailscale serve --bg 7717         # Tailscale terminates HTTPS and proxies to the daemon

agoryx up --local                 # this computer only again (the default)

agoryx pair                       # QR code + one-time code (5 minutes); or «Відкрити на телефоні» in the UI
agoryx devices                    # paired devices
agoryx devices revoke <id>        # shut one out
```

- `--lan`, `--tailscale`, `--allow-host` and `--local` apply to a running daemon at once (no restart) and
  are remembered in `$AGORYX_HOME/exposure.json`, so a daemon the Mac app restarts is reachable the same
  way. The phone dialog on the computer has the same switch for the Wi-Fi.
- `--lan` listens on the Mac's Wi-Fi and Ethernet addresses only, not on VPN tunnels or VM/Docker bridges.
- A pairing works once and expires after five minutes. The QR link carries a long secret; the code to type
  is short, so wrong codes are limited: five a minute per address (behind Tailscale serve, per tailnet
  client), and after twenty in ten minutes from anywhere the live codes can no longer be typed. A scanned
  QR link is never locked out by someone guessing.
- The phone trades the code for a token of its own, kept as an HttpOnly cookie. The daemon stores only its
  hash (`$AGORYX_HOME/devices.json`), never logs it, and refuses it (and pairing) from agents' processes.
- The daemon's own token works on this computer only. Requests naming any other Host are refused
  (DNS rebinding), and so are API calls from other origins.
- File previews (`/raw/`) on a phone use a key of that device's own, which stops working when it is revoked;
  the computer's key works on the computer only.
- A phone acts as you in rooms, but cannot pair or revoke devices or stop the daemon.
- On an iPhone, add Agoryx to the home screen («Поділитися» → «На початковий екран») for notifications.
  The home-screen app keeps its own cookies, so type the code there once. Notifications need HTTPS.
  The VAPID keys are made on first use in `$AGORYX_HOME/vapid.json`. A push carries only an id: the phone
  asks the daemon what it says, so a push someone else sends with those keys shows nothing.
- `--allow-host NAME` accepts another HTTPS proxy's host name in place of `--tailscale`.

## Prerequisites

- Node.js >= 22
- [Codex CLI](https://github.com/openai/codex) installed and authenticated
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Quick Start

```bash
npm install
npm run build
npm run chat -- --mode auto
```

## CLI Usage

```bash
# Root help/version
agoryx --help
agoryx --version

# Start a chat session
agoryx --mode manual          # you pick who responds with @agent
agoryx --mode round-robin     # agents alternate
agoryx --mode auto            # smart routing (recommended)
agoryx --mode team            # autonomous team runtime

# Adapter transport modes
agoryx --adapter-mode cli       # default for non-team modes
agoryx --adapter-mode agentic   # explicit persistent+workspace mode
# In team mode, cli adapters are auto-promoted to agentic unless overridden

# Resume a previous session
agoryx --resume <session_id>

# Custom config file
agoryx --config ./my-config.json
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
| `/memory show` | Display current project memory snapshot |
| `/memory decision <text>` | Record an architectural decision |
| `/memory note <text>` | Record a freeform note |
| `/memory log [--limit N]` | View memory event log |
| `/memory rebuild` | Full replay from event log |
| `/workspace show` | Display workspace context (branch, status, diffs) |
| `/workspace full` | Display full workspace context including on-demand data |
| `/worktree create <agent>` | Create isolated git worktree for agent |
| `/worktree list` | List all managed worktrees |
| `/worktree remove <agent>` | Remove agent worktree |
| `/worktree status` | Show detailed worktree status |
| `/help` | Show available commands |
| `/quit` or `/exit` | End session |

In interactive TTY sessions, pressing `Esc` in `team` mode also interrupts the active team step.

## CLI UX Defaults

- Human-friendly errors follow a consistent pattern: what failed + a fix hint.
- In interactive TTY mode, Agoryx uses compact status lines.
- Machine-oriented flows (piped/non-TTY) stay plain-text and script-friendly.

## Session Management

```bash
# List recent sessions
agoryx sessions list --limit 20

# Export a session
agoryx sessions export <room_or_session_id> --format markdown --out ./export.md
```

## Installation

```bash
# Link local build globally
npm install
npm run build
npm link

# Remove global link
npm unlink -g agoryx
```

## Completion & Man Page

```bash
# Print completion scripts
agoryx completion bash
agoryx completion zsh
agoryx completion fish

# Also available as files:
# completions/agoryx.bash
# completions/agoryx.zsh
# completions/agoryx.fish

# Manual page source
# docs/man/agoryx.1
```

## Project Structure

```
cmd/agoryx/          CLI entry point + Ink UI
desktop/             macOS app (Electron shell around the daemon and its UI)
internal/
  adapters/          Codex and Claude CLI adapters, output parser, event factory
  config/            Config loader, defaults, path resolution
  engine/            Chat facade, dispatch engine, team orchestrator, lifecycle
  events/            Canonical event types
  memory/            Memory service, event capture, markdown renderer
  orchestrator/      Policies (manual, round-robin, auto, team), factory
  session/           Context builder, session service, checkpoint summaries
  storage/           SQLite persistence (13 tables)
  workspace/         Workspace context collector (git status, diffs, tree)
  worktree/          Git worktree manager (per-agent isolation)
tests/               Test suite (rooms: tests/agora)
docs/                Architecture, vision, consensus, design plans
```

## Configuration

Config precedence: **flags > env > config file > defaults**.

Default config path:
- `$XDG_CONFIG_HOME/agoryx/config.json`
- fallback legacy path: `./agoryx.json` (if present in current working directory)

Default state path:
- `$XDG_STATE_HOME/agoryx/agoryx.db`

Create a config file to customize defaults:

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
    "dbPath": "/absolute/path/to/agoryx.db"
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
npm run build        # Production build: CLI and the web UI
npm run verify       # Release gate: typecheck + build + test
```

## License

[MIT](LICENSE)
