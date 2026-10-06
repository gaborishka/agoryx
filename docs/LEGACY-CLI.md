# Legacy SQLite CLI

Agoryx 0.1.1 retains the older terminal chat runtime for compatibility. Its SQLite sessions and orchestration policies are separate from the room application described in the [README](../README.md).

For the current web/desktop experience, use `agoryx up -d` and `agoryx open`. Running `agoryx` without a subcommand still starts the legacy chat interface; this behavior has not been changed by the documentation or version reset.

## Start and resume

```sh
agoryx chat --mode free
agoryx chat --mode manual
agoryx chat --mode round-robin
agoryx chat --mode auto
agoryx chat --mode team
agoryx chat --resume SESSION_ID
agoryx chat --config ./agoryx.json
```

Policies are `free`, `manual`, `round-robin`, `auto` and `team`. They are not aliases for Chat, Work, Verification, Council, Tournament and Debate in the room UI.

Transport modes include `stub`, `cli`, `persistent` and `agentic`. Use `agoryx chat --help` for actual flags and defaults. Stub mode is useful for local fixtures and does not call providers.

## Commands inside a legacy session

| Command | Purpose |
| --- | --- |
| `@codex`, `@claude`, `@all` | Address participants |
| `/mode`, `/adapter` | Change policy or transport |
| `/pin`, `/unpin`, `/pins` | Manage pinned context |
| `/summary`, `/checkpoint`, `/history` | Inspect or summarize context |
| `/export`, `/retry` | Export a session or retry |
| `/team start/status/log/resume/approve/interrupt/stop` | Operate the legacy team runtime |
| `/workspace show/full` | Inspect workspace context |
| `/worktree create/list/remove/status` | Manage the legacy agent worktrees |
| `/memory show/decision/note/log/rebuild` | Operate legacy project memory |
| `/help`, `/quit` | Discover commands or exit |

Team work uses planning, parallel implementation, optional checks and a user decision gate. Do not infer the ordinary Rooms Git behavior from the legacy team approval path.

## Export and configuration

```sh
agoryx sessions list --limit 20
agoryx sessions export SESSION_ID --format markdown --out export.md
agoryx config explain
agoryx completion bash
agoryx completion zsh
agoryx completion fish
agoryx man
```

Configuration precedence is flags, environment, config file, then defaults. The default config is under `$XDG_CONFIG_HOME/agoryx/config.json`, with legacy `./agoryx.json` detection. Default SQLite state is under `$XDG_STATE_HOME/agoryx/agoryx.db`, with the standard home-directory fallbacks. Use `config explain` to inspect resolved paths rather than guessing them.

The generated `.agoryx/memory.md` viewport belongs to this runtime. It is different from Rooms project memory under `<AGORYX_HOME>/projects/`.

## Implementation

The compatibility runtime lives in `internal/engine`, `internal/adapters`, `internal/session`, `internal/orchestrator`, `internal/storage` and `internal/memory`. Existing adapter, storage, orchestration and CLI tests remain part of the complete test suite.
