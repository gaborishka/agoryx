# Agoryx Rooms

A room puts you and a configurable group of Claude and Codex agents in one conversation. Each agent works in its **own native session**
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
- **The delta is thin; the depth is one command away.** Another agent's message over 1,200 characters
  arrives as its gist, not whole:
  - its start and its end;
  - whole, every paragraph that @addresses the reader or takes a stance against something;
  - a marker: `[excerpt — N of M chars … agoryx read m12]`.

  Some things are never shortened:
  - the human's words;
  - decisions;
  - Agoryx notices;
  - `object` and `concede` moves, which keep their whole reason.

  Every message is copied whole to `.agoryx/messages/<room>/m12.md` inside the workspace, where the
  sandbox can read it:
  - `agoryx read m12` prints a message;
  - `agoryx read` alone lists the recent ones.

  A delta over 60,000 characters, such as a rejoin or a long absence, drops its oldest ordinary entries
  first. After that, old messages that addressed the reader or objected shrink to a stub. The stub keeps
  what the message did and names the message to read.
- **Blind first round, then one at a time.** On a human message the addressed agents answer in parallel
  without seeing each other, so the first opinions are independent. After that they take the floor one
  at a time (whoever has waited longest goes first), so each reply answers the latest state — one
  conversation, not two crossing ones. A new message from the human still reaches an idle agent at
  once, even while the other one is working.
- **Silence is an answer.** An agent that has nothing to add replies `::pass::` (optionally with a short
  reason). A run ends when the room goes **quiet** (everyone passed) or the **turn budget** runs out.
- **The human is a participant,** not a dispatcher. Write any time — your message reaches the agents in
  their next delta. `@id` wakes only that participant first; `@all` addresses everyone.
- **Work is attributed.** Files changed during a turn are credited to that turn; at run end Agoryx makes a
  checkpoint commit (in workspaces it created, or when `autocommit` is on).

## The table (Стіл)

The conversation and the table are not two chats. The conversation is the talk — reasoning, questions,
what someone did — and it scrolls away. The table is the room's working state: open questions, the real
alternatives with the arguments and evidence attached to each, facts, settled points, steps someone owns,
decisions. Agents change it with a tool during their turn, the way they edit a file; each move shows up
as a card under that turn's message (an option card keeps its live standing — ✓ supports, ✕ objections,
◆ evidence, chosen or withdrawn — and has "Підтримати / Заперечити / Обрати" for the human). The board
beside the conversation shows the same state grouped by question. Every agent delta ends with the table's
current state, so nobody has to reconstruct it from the scroll. Agents and the human use the same verbs:

| Op | Meaning |
|----|---------|
| `ask "question"` | Open question `Q1` |
| `propose "title" [--body … \| --body-file f.md \| --body -] [--file path] [--q Q1]` | Option `P1`: a markdown body (diagrams and live blocks render), a file previewed live |
| `object P1 "why"` / `support P1 "why"` | Objection or support note `N1` |
| `evidence P1 "finding" [--source …]` | Evidence that backs or breaks an option |
| `fact "…"` / `settle "…" [--q Q1]` | Established fact `F1` / something both sides agree on `S1` |
| `next "…"` → `done X1` | Next step `X1`, and marking it done |
| `decide P1 [--note …]` | Decision: posts "Decision №N" into the conversation and wakes the agents |
| `withdraw P1` / `reopen Q1` | Retract an option / reopen a question |
| `concede "…" [--on P1]` | Something I no longer hold, and why |

Agents use `agoryx table …` from their shell. Agoryx puts a shim first on `PATH` and also exports
`AGORYX_CLI` (absolute path), because login shells can reorder `PATH` and an older global `agoryx` may win.
Each op is acknowledged, and the rendered table lives at `<workspace>/.agoryx/rooms/<room>/TABLE.md`.

Several rooms may work in one directory. Each keeps its own inbox, acks, `TABLE.md` and turn patches
under `.agoryx/rooms/<room>/`, so one room's op or `t1` never lands in another. Message copies stay
in `.agoryx/messages/<room>/`.
- **In a room turn,** the agent tool knows its room from `AGORYX_ROOM`.
- **Outside a turn,** it uses `--room <id>` or the only room in the directory. With several rooms and
  none named, a write is refused with their ids.
- **Older rooms and tools:** the shared `.agoryx/ops` and `.agoryx/turns` are still read, but only
  by a room that the room logs show is alone in that directory. Otherwise an op there is refused with
  an ack that says to add `--room`.
- **Turns of two rooms at once** are credited like parallel turns in one room. Every turn leaves a marker
  in `.agoryx/live/<room>.<turn>.json` (pid, start, end), which rooms in this process and in other
  processes read. A file changed while another room's turn ran is this turn's only if its own edit tool
  changed it, or it changed after the other turns ended; a shell change made meanwhile is nobody's.
  "After they ended" needs the workspace as the last of them left it, which only rooms in the same
  process hand to each other: with a room in another process, only the edit tool credits a file.
  A marker left by a dead process counts as ended when a room first sees it dead. A canonical-file
  change seen between turns, when another room's turn ran since the file was last seen, is recorded as
  "Ivan or room "B"" (whose is not known), never as the human's alone.
- **The checkpoint commit**, for a room alone in its directory, is everything there as before. A room
  that shares the directory (or saw another room's turn during the run) commits through a temporary index and only files credited to that run's turns.
  Files changed since their last credited tree snapshot, files without a tree snapshot, and files
  with existing staged changes are skipped. Uncredited work stays uncommitted; foreign staged entries
  are preserved. Index-lock contention skips the checkpoint; a HEAD compare-and-swap prevents overwriting
  a concurrent commit.

## The canonical file (Документ)

A room can name one file in its workspace as **the text it is making**: an essay, a spec, a plan.
Rooms created with a fresh workspace get `README.md`. Set it with `agoryx new --doc PATH`,
`agoryx settings --doc PATH` or in the UI settings; `none` turns it off. Agoryx names the file and
keeps its history. It never says what goes in it, and anyone can write it with any tool.

- **Every revision has an author.** A change made during a room turn is credited to that turn, using
  git status and the turn's own edit trace (parallel turns don't steal each other's edits). A change
  made between turns goes to the only agent in a native exchange (marked "у власній сесії").
  Otherwise it is the human's (their editor or the UI). The version the room found is the baseline.
- **The others get the diff.** An agent's delta carries the revisions made since its last turn, as a
  compact diff with a few lines of context. It sees who made each one. The briefing names the file.
  A revision wakes nobody. Agents read it when something else wakes them.
- **In the UI,** the Документ panel renders the file (markdown as paper, code as code). "Історія"
  lists the revisions, and each one opens as a diff with a link to its turn in the conversation.
  "Редагувати" edits the file in place. A save carries the version it started from. If the file
  changed meanwhile, the UI shows the conflict and loses nothing. Revisions also appear in the
  conversation, as chips on the turn that made them or as their own line.
- **From the CLI:** `agoryx doc` prints the file, `agoryx doc --log` lists the revisions and
  `agoryx doc --diff 26` shows one of them.

Writes from the UI stay inside the workspace. They never go through symlinks out of it, or into
`.git` or `.agoryx`. Revisions over 256 KB are recorded with their stats only.

## Every turn's exact change

What an agent says it did and what it did are different things, and cross-review needs the second.
So Agoryx keeps **the exact change of every turn**, and the other agents see it.

- **Snapshots, not trust.** When a turn starts and ends, Agoryx writes the whole working tree
  (untracked files included, ignored ones not) into a git tree object. It uses a scratch copy of the
  index, so the real index, HEAD and the files are never touched. The diff between the two trees,
  limited to the files credited to this turn, is the turn's change. Parallel turns don't get each
  other's edits.
- **Counts in the delta, depth on demand.** The next delta of every other agent shows
  `↳ changed: src/clock.ts +2 −1, README.md +40 −0 (new) — the exact diff: agoryx diff t7`. A turn
  that passed but changed files is still reported. The briefing tells the agents that the diff
  holds what was actually done.
- **`agoryx diff`** works inside the sandbox, from the agent shim. It needs no daemon.
  `agoryx diff` lists recent turns with their files, `agoryx diff t7` prints that turn's patch, and
  `agoryx diff t7 src/clock.ts` prints one file of it. The human CLI has the same command,
  with `-r room` to use it from anywhere.
- **In the UI,** the files a turn changed are chips with `+/−` counts. A chip opens a dialog with every
  file of the turn and the patch.
- **Storage:** `.agoryx/rooms/<room>/turns/t7.patch` in the workspace. The file has a `#` header saying who and
  when, then a plain `git diff`. The `turn.ended` event carries the counts and both tree ids, so a
  lost patch file is rebuilt from git. Patches over 256 KB are cut, and the note names the
  `git diff <before> <after>` that has the rest. Snapshots are skipped when more than 3000 files
  are dirty. The turn then lists its files without counts.

## Using it

### Choose the participants with JSON

Save a roster anywhere you can read it, for example `roster.json`:

```json
[
  { "id": "opus", "kind": "claude", "label": "Claude Opus", "model": "opus" },
  { "id": "sonnet", "kind": "claude", "label": "Claude Sonnet", "model": "sonnet" },
  { "id": "codex", "kind": "codex", "label": "Codex" }
]
```

```bash
agoryx new "Three voices" --agents ./roster.json
agoryx say "@sonnet compare the alternatives"
```

`--agents` accepts a file path (relative to your current directory) or inline JSON.
Both an array and `{ "agents": [...] }` are accepted. The HTTP equivalent is
`POST /api/rooms` with `{ "name": "Three voices", "agents": [...] }`.

Without an explicit roster, new rooms use `<AGORYX_HOME>/agents.json` if present,
otherwise the original Claude + Codex pair. `agoryx --help` prints the state directory
when `AGORYX_HOME` is unset. This default also applies to rooms created in the web UI,
whose start screen shows who will be seated (`GET /api/info` returns it as `agents`). An
invalid default file produces an error instead of silently using the pair.

Only `kind` is required: it selects the installed `claude` or `codex` CLI and may repeat.
`id` is the @handle and defaults to the kind: a unique lowercase handle, 2–32 characters,
starting with a letter and containing only letters, digits, `_` or `-`. `all`, `agoryx`
and the human's name cannot be used. `label` (1–40 characters) defaults to the id with a
capital letter, and no two agents may share one. `model` is optional and passed to the CLI
as given (also when you resume the session); omitting it uses that CLI's default. Any other
field is refused. A refused roster creates nothing: no room, no folder.

The resolved roster is stored in the room's event log. Editing or deleting the source
JSON does not change existing rooms. Each participant has its own cursor and native
session, even when several use the same CLI. `agoryx resume` lists their commands by
handle. From a native session, use `agoryx table ... --as opus` if the provider hint is
ambiguous because multiple Claude agents are active.

### As a daemon without UI

```bash
agoryx new "Storage choice" -m "Pick a storage format for rooms and prototype it"
agoryx say "Keep it to one file, no native deps"   # posts and follows until quiet
agoryx tail -f --trace                              # watch the conversation with tool traces
agoryx table                                        # show the table
agoryx table decide P2 --note "simplest"
agoryx doc --log                                    # who changed the canonical file, and how much
agoryx diff t7                                      # exactly what turn t7 changed in the workspace
# inside a room (agents): agoryx read m12 prints a message whole, agoryx read lists recent ones
agoryx more                                         # one more round after the budget ran out
agoryx resume                                       # print `claude --resume …` / `codex resume …`
```

Without a running daemon, `say`, `table` and `more` drive the room in the current process until it goes
quiet. With `agoryx up -d` the daemon drives all rooms and the CLI becomes a client.

### Web UI

```bash
agoryx up -d        # start the daemon in the background
agoryx open         # opens the browser with a login link (it becomes a 30-day cookie; the token stays the same)
```

- **Start by writing.** "Нова кімната" opens a composer: the first message starts the room and names it
  (the name is editable later by clicking the title). The workspace, canonical file and turn budget
  sit under "Параметри" and have defaults. `agoryx new -m "…"` does the same without a name.
- **The conversation** is one column. Replies stack in order. A divider marks the independent replies
  right after your message. Each reply shows its trace (commands, edits), the files it changed with
  +/− counts (each opens the turn's exact patch), and what it put on the table. A turn with more
  than four table moves keeps questions, proposals, objections and decisions in view and folds the
  rest (support, evidence, facts, steps) into one line with counts. Live turns stream in, and a page
  that connects mid-turn gets the text streamed so far.
  A line above the composer says who is working, or that the agents are waiting for you, with
  "Зупинити" / "Продовжити".
- **Стіл** and **Документ** open in a panel beside the conversation (full screen on a phone):
  questions with their options, notes and evidence, a "Де ми зараз" summary of decisions, settled
  items and next steps; the canonical file with its history, diffs and an editor.
- Table ids in messages (`P1`, `X1` …) open the table at that item. The header shows each agent's
  state and holds the workspace files, the native sessions and the room settings.

### Rich content

Messages, option bodies and the canonical file are rendered markdown, and agents are told to show
rather than only tell:

- ```` ```mermaid ```` fences render as diagrams (the React UI imports mermaid on the first diagram,
  `securityLevel: strict`; `ui/src/components/md/Markdown.tsx`).
- ```` ```html ```` fences render live: the daemon serves each block as its own page at
  `/raw/<room>/<hmac>/~block/<m:id|o:id>/<hash>` — found by the cyrb53 hash of its body in that message
  or option (`internal/agora/blocks.ts`, same hash in `ui/src/lib/format.ts`) — under the sandbox CSP, so scripts
  run but the page has an opaque origin and cannot reach the API. The frame reports its content height.
- ```` ```svg ```` fences render as images; other fences are highlighted with a copy button.
- `![caption](path)` embeds a workspace file: images inline, `.html/.svg/.pdf` live, anything else as a
  file link. Markdown tables (with alignment), task lists and strikethrough render too.

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
  - Codex: `-s workspace-write` (`read-only` when the room's access is readonly).
  - Claude: `--permission-mode acceptEdits` with a sandbox settings file that auto-allows Bash only
    inside the sandbox.
  - Network is **on** by default for both: sandboxed commands may reach the network. A room turns it off
    with `agoryx settings --network off` (`internal/agora/types.ts`, `DEFAULT_SETTINGS`).
- No bypass or "dangerous" flags are ever passed.
- The daemon listens on `127.0.0.1` only, checks the `Host` header (DNS rebinding) and refuses
  cross-origin writes.
- Every `/api/*` call except `/api/health` needs the token from `daemon.json` (mode 0600). The token arrives as a header,
  or as an HttpOnly, SameSite=Strict cookie set by the `agoryx open` login link.
- Workspace files are served under `/raw/<room>/<hmac>/…`, with a `sandbox` CSP and an opaque origin.
  Agent-made HTML (files and ```` ```html ```` blocks) can run but cannot call the API. Paths are resolved through symlinks and
  must stay inside the workspace. `.git` is never served.

## Storage

State lives in `$AGORYX_HOME` (default `~/.local/state/agoryx/agora`):

| Path | What |
|------|------|
| `rooms/<id>/events.jsonl` | Append-only event log. Replaying it reproduces the room state. |
| `rooms/<id>/engine.lock` | Single-writer lock. A second process follows the log instead of driving. |
| `bin/agoryx` | The agent shim. |
| `daemon.json`, `daemon.token` | The running daemon's address and token. |
| `workspaces/<slug>/` | Room workspaces, only when `AGORYX_HOME` is set. |

Without `--dir`, a room's workspace is `~/agoryx/<slug>/` (git-initialised); `AGORYX_WORKSPACES` overrides it.

## Code map

| File | Role |
|------|------|
| `internal/agora/engine.ts` | Room engine: wake rules, deltas, blind rounds, pass, budget, table inbox, attribution, per-turn changes, checkpoints |
| `internal/agora/workspace.ts` | Workspace git helpers: dirty snapshots, tree snapshots and turn patches, checkpoints, safe paths |
| `internal/agora/prompts.ts` | Briefing (first turn) and delta prompts |
| `internal/agora/runners/{claude,codex}.ts` | Native CLI runners: session ids, stream parsing, activity traces |
| `internal/agora/native.ts` | Finds and reads the agents' native session files; imports turns taken outside the room |
| `internal/agora/doc.ts` | The canonical file: path rules, reading, line diff, baseline revision |
| `internal/agora/table.ts`, `table-cli.ts`, `bin/agoryx-agent.mjs` | Table ops, rendering, CLI parsing, zero-dependency agent shim (`table`, `diff`) |
| `internal/agora/store.ts`, `projection.ts` | JSONL event log and state projection |
| `internal/agora/daemon.ts`, `snapshot.ts`, `client.ts` | HTTP/SSE daemon, snapshots and patches, CLI client |
| `internal/agora/blocks.ts` | Live html/svg fences: finding a block in a message by the hash of its body |
| `cmd/agoryx/agora.ts` | `agoryx up/new/say/tail/table/doc/diff/…` |
| `ui/` | The web UI (React; `npm run build` builds it into `ui/dist`, which the daemon serves) |
| `web/` | The older plain page, served only when `ui/dist` is not built |

Tests: `npx tsx --test tests/agora/*.test.ts`. They use fake `claude`/`codex` binaries and need no
network or subscriptions.
