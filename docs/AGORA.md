# Agoryx Rooms

A room puts Claude, Codex and you in one conversation. Each agent works in its **own native session**
(`claude -p --session-id/--resume`, `codex exec` / `codex exec resume`), with its full toolset, in a
shared workspace. Agoryx sets the context; it does not assign roles, pick speakers or summarise for anyone.

```
you ──┐                     ┌── Claude  (native session, sandboxed, full tools)
      ├── room event log ───┤
table ┘   (JSONL, replayable)└── Codex   (native session, workspace-write sandbox)
```

## How a room runs

- **No orchestrator.** Every new message wakes the agents that have not seen it yet. Each gets only the
  **delta** since its last turn — its native session already holds the rest.
- **Blind first round.** On a human message both agents answer in parallel without seeing each other,
  so the first opinions are independent. After that they see each other's replies.
- **Silence is an answer.** An agent that has nothing to add replies `::pass::` (optionally with a short
  reason). A run ends when the room goes **quiet** (everyone passed) or the **turn budget** runs out.
- **The human is a participant,** not a dispatcher. Write any time — your message reaches both agents in
  their next delta. `@claude` / `@codex` wakes only that agent first.
- **Work is attributed.** Files changed during a turn are credited to that turn; at run end Agoryx makes a
  checkpoint commit (in workspaces it created, or when `autocommit` is on).

## The table (Стіл)

The conversation is where agents think; the table is where the room keeps what matters. Agents and the
human write to it with the same verbs:

| Op | Meaning |
|----|---------|
| `ask "question"` | Open question `Q1` |
| `propose "title" [--body …] [--file path] [--q Q1]` | Option `P1` (a file can be previewed in the UI) |
| `object P1 "why"` / `support P1 "why"` | Objection or support note `N1` |
| `evidence P1 "finding" [--source …]` | Evidence that backs or breaks an option |
| `fact "…"` / `settle "…"` | Established fact `F1` / something both sides agree on `S1` |
| `next "…"` → `done X1` | Next step `X1`, and marking it done |
| `decide P1 [--note …]` | Decision: posts "Decision №N" into the conversation and wakes the agents |
| `withdraw P1` / `reopen Q1` | Retract an option / reopen a question |

Agents use `agoryx table …` from their shell. Agoryx puts a shim first on `PATH` and also exports
`AGORYX_CLI` (absolute path), because login shells can reorder `PATH` and an older global `agoryx` may win.
Each op is acknowledged, and the rendered table lives at `<workspace>/.agoryx/TABLE.md`.

## Using it

### As a daemon without UI

```bash
agoryx new "Storage choice" -m "Pick a storage format for rooms and prototype it"
agoryx say "Keep it to one file, no native deps"   # posts and follows until quiet
agoryx tail -f --trace                              # watch the conversation with tool traces
agoryx table                                        # show the table
agoryx table decide P2 --note "simplest"
agoryx more                                         # one more round after the budget ran out
agoryx resume                                       # print `claude --resume …` / `codex resume …`
```

Without a running daemon, `say`, `table` and `more` drive the room in the current process until it goes
quiet. With `agoryx up -d` the daemon drives all rooms and the CLI becomes a client.

### Web UI

```bash
agoryx up -d        # start the daemon in the background
agoryx open         # opens the browser with a one-time login link
```

- **Розмова**: the conversation. Blind rounds are shown side by side. Each reply links to its trace
  (commands, edits), the files it changed, and what it put on the table. Live turns stream in.
- **Стіл**: questions with their options, notes, evidence and previews. The "Де ми зараз" rail
  shows decisions, settled items and facts, next steps and open questions.
- Table ids in messages (`P1`, `X1` …) link to the table. The header links to the workspace files,
  the native sessions and the room settings.

### In the agents' own apps

The conversation is **their** session. `agoryx resume` (or the sessions button in the UI) prints the
exact `claude --resume <id>` and `codex resume <id>` commands. Open them to see or continue the same
thread natively — in the terminal, in Claude Code or in Codex.

It works both ways. Whatever you say to an agent there comes back into the room:

- Agoryx watches both native session files (`~/.claude/projects/…/<id>.jsonl`,
  `~/.codex/sessions/…/rollout-…-<id>.jsonl`; `CLAUDE_CONFIG_DIR` / `CODEX_HOME` are honoured) and
  imports every finished exchange: your prompt and the agent's final answer. Tool calls, reminders,
  harness wrappers and the room's own turns are skipped.
- Imported messages are marked in the UI ("напряму в сесії Claude", "у власній сесії") and in
  `agoryx tail`.
- A side conversation **does not wake anyone.** The other agent reads it in its next delta as
  "Ivan (human) → Claude, directly in Claude's own session". The agent you talked to does not get
  it again: its session already holds it.
- To bring the other agent in from there, `@mention` it (`@codex check the units`) or write `@all`.
  That starts a room run as if you had written in the room.
- **Busy guard.** While you are mid-exchange with an agent in its own app (the session file changed in
  the last 5 minutes and the turn is still open), the room does not resume that session in parallel.
  Its room turn waits until your exchange ends, and the room says so once. Meanwhile the UI rings that
  agent's avatar with a dashed line and the run bar reads "У сесії Codex розмова напряму"; `agoryx tail -f`
  prints a line when it starts.
- **The table works there too.** An agent in its own session can run `agoryx table …` from the room's
  workspace (the briefing gives it the exact command, with `--as <id>`). The move is signed as that agent:
  by `--as`, by its shell (`CLAUDECODE` for Claude Code, `CODEX_SANDBOX` for Codex), or, when unsigned,
  as the only agent working right now (in a room turn or mid-exchange in its own session). If it can't
  tell, the room refuses and asks for `--as`. Such moves are marked "у власній сесії" and, like side
  conversations, wake nobody. Run from your own terminal, `agoryx table` stays a human move (inside an
  agent's shell, use `--as <your name>` for that).
- The daemon opens rooms active in the last 14 days at start, so all of this reaches them without
  anyone opening the room first.

## Safety

- Agents run **sandboxed but capable**:
  - Codex: `-s workspace-write`, with network off unless the room enables it.
  - Claude: `--permission-mode acceptEdits` with a sandbox settings file that auto-allows Bash only
    inside the sandbox.
- No bypass or "dangerous" flags are ever passed.
- The daemon listens on `127.0.0.1` only, checks the `Host` header (DNS rebinding) and refuses
  cross-origin writes.
- Every `/api/*` call needs the token from `daemon.json` (mode 0600). The token arrives as a header,
  or as an HttpOnly, SameSite=Strict cookie set by the `agoryx open` login link.
- Workspace files are served under `/raw/<room>/<hmac>/…`, with a `sandbox` CSP and an opaque origin.
  Agent-made HTML can be previewed but cannot call the API. Paths are resolved through symlinks and
  must stay inside the workspace. `.git` is never served.

## Storage

State lives in `$AGORYX_HOME` (default `~/.local/state/agoryx/agora`):

| Path | What |
|------|------|
| `rooms/<id>/events.jsonl` | Append-only event log. Replaying it reproduces the room state. |
| `rooms/<id>/engine.lock` | Single-writer lock. A second process follows the log instead of driving. |
| `bin/agoryx` | The agent shim. |
| `daemon.json`, `daemon.token` | The running daemon's address and token. |
| `workspaces/<slug>/` | Default room workspaces (git-initialised). Override with `--dir`. |

## Code map

| File | Role |
|------|------|
| `internal/agora/engine.ts` | Room engine: wake rules, deltas, blind rounds, pass, budget, table inbox, attribution, checkpoints |
| `internal/agora/prompts.ts` | Briefing (first turn) and delta prompts |
| `internal/agora/runners/{claude,codex}.ts` | Native CLI runners: session ids, stream parsing, activity traces |
| `internal/agora/native.ts` | Finds and reads the agents' native session files; imports turns taken outside the room |
| `internal/agora/table.ts`, `table-cli.ts`, `bin/agoryx-agent.mjs` | Table ops, rendering, CLI parsing, zero-dependency agent shim |
| `internal/agora/store.ts`, `projection.ts` | JSONL event log and state projection |
| `internal/agora/daemon.ts`, `snapshot.ts`, `client.ts` | HTTP/SSE daemon, snapshots and patches, CLI client |
| `cmd/agoryx/agora.ts` | `agoryx up/new/say/tail/table/…` |
| `web/` | The web UI (vanilla JS, no build step) |

Tests: `npx tsx --test tests/agora/*.test.ts`. They use fake `claude`/`codex` binaries and need no
network or subscriptions.
