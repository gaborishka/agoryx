# Agoryx Rooms

A room puts you and a configurable group of Claude and Codex agents in one conversation. Each agent works in its **own native session**
(`claude -p --session-id/--resume`, `codex exec` / `codex exec resume`), with its full toolset, in a
shared workspace. Agoryx sets the context; it does not assign roles, pick speakers or summarise for anyone.

```
you ──┐                     ┌── Claude  (native session, your settings; sandbox only if the room limits it)
      ├── room event log ───┤
table ┘   (JSONL, replayable)└── Codex   (native session, its own workspace-write sandbox)
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

  If an agent's last reply objected, or put a question or a preference to someone by @name, only in prose
  — its turn made no table move — its next delta quotes that paragraph once. It then says: put it on the
  table (`ask` / `object`) if it still stands, or `concede` with what changed your mind. Otherwise it is
  gone in a few turns, and nobody has to answer it.
- **Parallel first round, then one at a time.** On a human message the addressed agents start in parallel
  from the same point, each forming its own view; while working they see each other only through what they
  say (`agoryx say`, `agoryx read new`). After that they take the floor one
  at a time (whoever has waited longest goes first), so each reply answers the latest state — one
  conversation, not two crossing ones. A new message from the human still reaches an idle agent at
  once, even while the other one is working.
- **Say it while you work.** `agoryx say "taking a.ts — the CLI is yours"` posts to the room at once, from the
  middle of a turn, as often as the agent finds useful: it is not a turn, is not counted against any turn limit, and
  wakes nobody (the turn's reply still does) — except an agent it @mentions that is not in a turn: that one
  starts at once, beside the asker, so a question asked mid-turn gets an answer instead of waiting on a reply
  that waits on it. `agoryx read new` prints what the others said since the reader's
  turn began, so two agents working at the same time can split files instead of colliding. The next delta shows
  an update as `── Claude · while working`; the web feed shows it as a line marked «по ходу». Only during a room
  turn: in an agent's own session its answer is read back into the room anyway.
- **Silence is an answer.** An agent that has nothing to add replies `::pass::` (optionally with a short
  reason). A run ends when the room goes **quiet** (everyone passed), or when the human stops it. There is no
  turn limit by default: counting the agents' turns is a rule set over them, so it is left to the human —
  `--budget N` (or the start screen's «ходів» chip, or the room's settings) caps a run at N agent turns,
  `--budget none` takes the cap off again. With a cap, the prompt counts the turns down and the run waits
  for the human when they are spent.
- **The human is a participant,** not a dispatcher. Write any time — your message reaches the agents in
  their next delta. `@id` wakes only that participant, and its answer goes back to the human: the others
  read it in their next turn, and are woken by it only if it names them (`@codex, check this`). `@all`, or no
  name at all, addresses everyone.
- **A second look, when Jev says it is worth it.** With a key for [Jev](https://typesafe.ai) in the daemon's
  environment (`TYPESAFE_API_KEY`, or `OPENROUTER_API_KEY`; `JEV_PROVIDER` picks one when both are set — `agoryx up` also
  takes these three from a `.env` in the Agoryx checkout, never over the environment, and never passes them on to
  the agents; the daemon log says «Jev on» or «Jev off» at start), such an
  answer that names no one is weighed: the human's question, the answer (a long one as its start and end) and the
  files it changed go to Jev, which gives each other agent a probability that its look is worth a turn. At
  `AGORYX_JEV_THRESHOLD` (default 0.5) or above, Agoryx says so in the room — «Jev: a second look at Claude's
  answer seems worth a turn (Codex 54%) — Codex takes a look.» — and that note wakes only the agents it names.
  Below it, or with Jev out of reach, nobody is woken. The run stays open the fraction of a second it takes; the
  daemon log keeps every verdict. No key, or `AGORYX_JEV=off`: nothing leaves the machine and nothing is asked.
- **Jev reads agent messages, with the same key.** Each agent message — an answer, a native reply, an
  `agoryx say` update — goes to Jev with two kinds of yes/no question: is it meant for each other agent (asks it
  something, hands it work, waits on it), `@name` or not; and does each paragraph (the first ten of at least 24
  characters) take a position the room still has to settle. An agent the message is meant for at the threshold
  or above, not woken already and not yet past it, is woken by a note — «Jev: Claude's m12 reads as meant for
  Codex (93%), with no @ — Codex is woken to answer it.» A paragraph Jev finds a position in (0.8 or above) is kept
  in the others' gists and, if it never reached the table, quoted back to its author next turn, like the ones the
  word lists find. The author's next turn waits the fraction of a second the reading takes. Jev only adds: a wake
  it misses is left to `@names` as before, and a failed call changes nothing. About 0.3–0.7 s and 450–750 tokens
  a message; each reading is kept as a `message.read` event and in the daemon log.
- **Work is attributed.** Files changed during a turn are credited to that turn; at run end Agoryx makes a
  checkpoint commit (in workspaces it created, or when `autocommit` is on).
- **So are actions.** Each agent's turn carries its own key to the daemon (`AGORYX_AGENT_KEY`). The human's own
  `agoryx` in an agent's shell works as usual — `more`, `stop`, `settings`, `new`, `down`, room messages —
  but the daemon records what it does as that agent's: `run.extended`, `run.ended` (a stop),
  `settings.changed`, `room.renamed`, `doc.revised` and table ops carry `by`, and the transcript says it
  («Codex зупиняє розмову», «Claude змінює налаштування: …»). An agent's message is kind `agent`, never
  `human`. A room an agent opens records `createdBy` (the agent and the room it came from); its human is
  still the human. A key used in another room works there too, signed as a guest — `codex@<room>`, named
  «Codex (з кімнати «…»)» — never as that room's own agent or its human. Logs from before keep reading as
  they did (no `by` means what it always did). A turn without a key of its own (a runner that gave it
  none) is refused by the CLI rather than sent with the human's token: it would be recorded as theirs.

## Fast turns: a CLI kept up between turns

A CLI is slow to start (Claude ~8 s of hooks, plugins and MCP on some machines, Codex 1–3 s) and slow to exit
(~3 s after its answer). Two things keep a room from waiting on that:

- **A turn ends when the CLI says the answer is ready** — Codex `turn.completed`, Claude `result` — not when the
  process exits. The process (its whole group, so tools it started too) is then taken down at once, before the
  turn's changes are counted: nothing it might still write while shutting down is credited to the turn, and
  nothing is left running.
- **A live process per agent.** Claude runs as `claude -p --input-format stream-json --output-format stream-json`,
  Codex as `codex app-server` (JSON-RPC over stdio; the same sandbox, network and effort as `codex exec`). Each
  turn is a new message into the same process, so the second turn onwards pays no startup. The session is the
  same native session, so the human's own `claude --resume` / `codex resume` still works.
  - **The turn is not in the process's environment** — that was fixed when it started. The room writes
    `rooms/<id>/live/<agent>.json` (`AGORYX_TURN_FILE`, mode 0600: turn, delta cursor, the agent's key) at the
    start of every turn and removes it at its end; `agoryx say`, `read new`, `table` and the full CLI read it each
    time they run. Between turns there is no turn and no key, so a command is refused rather than sent under a
    stale turn or as the human.
  - **Restarted** when the model, effort, access or network setting changes, when the session is not the one the
    process holds (rejoin), when the human wrote into the same native session (see "In the agents' own apps"),
    after a failed or stopped turn, and after `AGORYX_LIVE_IDLE_MS` without a turn (default 5 minutes; `0` closes
    it after every turn). Closed with the room and with the daemon. Stop kills the process and ends the turn.
  - **Falls back silently** to a process per turn if the live one cannot start (a CLI without the flags, a failed
    handshake), for that agent, for as long as the room is open. `AGORYX_LIVE=0` turns live processes off.

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
| `object P1 "why"` / `support P1 "why"` | Objection or support note `N1` — on an option, a settled point (`S1`) or a fact (`F1`) |
| `evidence P1 "finding" [--source …]` | Evidence that backs or breaks an option, a settled point or a fact |
| `fact "…"` / `settle "…" [--q Q1]` | Established fact `F1` / something both sides agree on `S1` |
| `next "…"` → `done X1` | Next step `X1`, and marking it done — anyone may; TABLE.md then says who: `(claude; done by codex)` |
| `decide P1 [--note …]` | Decision: posts "Decision №N" into the conversation and wakes the agents |
| `withdraw P1` / `withdraw F1` / `reopen Q1` | Retract an option, or a fact that turned out wrong (its author, or the human; it stays, struck out) / reopen a question |
| `concede "…" [--on P1]` | Something I no longer hold, and why |

"Settled" is one agent's word, not the room's: another agent that still disputes `S1` objects to it, and
TABLE.md, the turn summaries and the board show it as contested by that agent until the objector concedes on
it, or its author does (then it is given up). An agent does not object to its own point: it concedes on it
(`S1`) or withdraws it (`F1`).

Agents use `agoryx table …` from their shell. Agoryx puts a shim first on `PATH` and also exports
`AGORYX_CLI` (absolute path), because login shells can reorder `PATH` and an older global `agoryx` may win.
Each op is acknowledged, and the rendered table lives at `<workspace>/.agoryx/rooms/<room>/TABLE.md`.
The shim handles `say`, `table`, `read` and `diff` itself and hands every other command to the full `agoryx`,
so an agent has the same commands as the human, under its own key.

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
  git status and the turn's own edit trace (parallel turns don't steal each other's edits). In parallel
  turns a file a shell command changed is the turn's only if its own command named it as written
  (`> file`, `tee`, `sed -i … file`, `cp`/`mv`/`rm`, a script's `open('file', 'w')` or `Path('file').write_text`),
  read from the whole command even when its shown label is clipped; one no command named
  could be either's and is credited to nobody. A change
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
  `agoryx diff t7 src/clock.ts` prints one file of it. A turn still running (a parallel agent's, say) has
  no patch yet: `agoryx diff` says it is running and that its patch comes when it ends, instead of
  "changed no files". The human CLI has the same command,
  with `-r room` to use it from anywhere.
- **In the UI,** the files a turn changed are chips with `+/−` counts. A chip opens a dialog with every
  file of the turn and the patch.
- **Storage:** `.agoryx/rooms/<room>/turns/t7.patch` in the workspace. The file has a `#` header saying who and
  when, then a plain `git diff`. The `turn.ended` event carries the counts and both tree ids, so a
  lost patch file is rebuilt from git. Patches over 256 KB are cut, and the note names the
  `git diff <before> <after>` that has the rest. Snapshots are skipped when more than 3000 files
  are dirty. The turn then lists its files without counts.
- **A folder that is not a git repository** (one you pass with `--dir`) is tracked the same way through
  Agoryx's own repository in `.agoryx/shadow.git`, with your folder as its work tree. Your folder gains
  no `.git`, nothing is committed for it, and your `.gitignore` still applies. There the rest of a cut
  patch is `git --git-dir=.agoryx/shadow.git --work-tree=. diff <before> <after>`. A folder of more than
  20,000 files (a home directory) is left untracked. Once the folder becomes a repository of its own,
  that repository is used. The agents' briefing says which of these the folder is: in a git repository
  it tells them to check `git status` before overwriting; in a folder without git it says `git status`
  finds nothing there and that Agoryx tracks the changes; in an untracked one, that nobody's changes
  are recorded, so they name the files they touched.

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
as given (also when you resume the session); omitting it uses that CLI's default.
`effort` is optional too: how hard the model thinks on its room turns (`"xhigh"` → Claude's `--effort xhigh`,
Codex's `-c model_reasoning_effort="xhigh"`); omitting it uses that CLI's default.
`"profile": false` keeps your profile (below) out of that agent's prompts — only its prompts: the agent can still read the file with its own tools (see the limits under "Your profile"). Any other field is refused. A refused roster creates nothing: no room, no folder.

The resolved roster is stored in the room's event log. Editing or deleting the source
JSON does not change existing rooms. Each participant has its own cursor and native
session, even when several use the same CLI. `agoryx resume` lists their commands by
handle. From a native session, use `agoryx table ... --as opus` if the provider hint is
ambiguous because multiple Claude agents are active.

### Your profile

Write once who you are, how you work and what matters to you in `<AGORYX_HOME>/profile.md`. Agents in
every room get it as context, marked as your own words about yourself — except agents whose roster entry
says `"profile": false`. The room's history is seen by everyone in it; the profile only by those it is on for.

- A fresh session gets it in its briefing. A running session gets it only when it is new to that session: never
  had it, or you changed the file since. It is not repeated in every delta. If you delete or empty the file, a
  session that had it is told once that it no longer applies.
- Each `turn.started` records the **hash** of the version that agent now holds (a failed turn gives the version
  back, like the cursor). That is how a restarted daemon knows who needs the new version; the text itself is
  never written to the event log, the workspace, `.agoryx/` or a commit.
- An agent it is off for gets no word of it: not in the briefing, not in a delta.
- Over 4,000 characters, it is cut and agents are told that it was cut. No file, or an empty one: prompts are exactly
  as they would be without this feature.
- `agoryx profile [-r room]` prints the path, whether the file exists, and who in the room sees it (and who still
  has an older version). In the web UI, each agent's tooltip in the room header says whether it sees the profile.

Limits: the profile stays out of what Agoryx writes, but agents run with read access to your home directory, so a
curious agent could read `profile.md` with its own tools — `"profile": false` included: it keeps the profile out of that
agent's prompts, and is not a read boundary. Making it one would mean sandboxing the agent away from `AGORYX_HOME`,
which is a choice about how agents run (they run as in your own terminal), not made here. An agent that does see it
is asked not to copy it into the room, files or commits; that is an instruction, not something Agoryx enforces. Existing sessions of rooms from before
the profile get it once, on their next turn.

### Checking the setup

```bash
agoryx doctor           # node, this install, better-sqlite3, Claude Code / Codex and their logins, git, AGORYX_HOME, the daemon
agoryx doctor --probe   # also one short real prompt to each logged-in agent, timed
agoryx doctor --json    # { verdict, checks } for scripts
```

Each problem comes with the command that fixes it. The output names versions and paths, never an
environment value or the account behind a login, so it is safe to paste. It exits 1 when a room cannot
run (no Node 22+, better-sqlite3 not loading, no usable agent, no writable state folder); a missing or
logged-out second agent is only a warning. The macOS app runs the same checks
(`internal/desktop/doctor.ts`) with the environment of your login shell.

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
agoryx more                                         # one more round (after a stop, or a turn limit)
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
- **The conversation** is one column. Replies stack in order. A divider («Одночасно») marks the replies
  written at the same time right after your message. Each reply shows its trace (commands, edits), the files it changed with
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
- **A dot in the sidebar** marks a room that waits for you: an agent's `@<you>`, a run that ended or was
  stopped by an agent, or a failed turn. Its tip says why. Looking at the room (a visible, focused tab on it)
  or acting in it clears the dot. The macOS app also shows these in its menu-bar icon, Dock badge and
  banners ([DESKTOP.md](DESKTOP.md), "When a room waits for you").

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

### The room's browser

In the macOS app ([DESKTOP.md](DESKTOP.md)) each room has one real browser page. Its agents drive it, and
the human watches it live in the room's «Браузер» panel.

Whenever the room has its shim, it hands both CLIs its own MCP server, `agoryx mcp` (`bin/agoryx-mcp.mjs`,
zero dependencies). Claude gets it through `--mcp-config`, with its tools allowed by name
(`mcp__agoryx_browser__*`). Codex gets it through `-c mcp_servers.agoryx_browser.*`, with its calls
approved and 90 s per call. The human's own MCP servers stay. `mcp` exists only in the agents' shim, not in
the human's `agoryx`. Verified with the real CLIs (2026-09-29): Claude per turn (`claude -p`) and live,
`codex exec`, and Codex live (`app-server` takes the `-c` flags, so no `thread/start` fallback is needed).
Each ran navigate, snapshot, click, type, press and screenshot with no permission or approval prompt, and
the screenshot reached the model. Claude and Codex also drove one page in the same round.

| Tool | Input | What it does |
|------|-------|--------------|
| `browser_navigate` | `url`, or `go`: `back` / `forward` / `reload` | Loads a page and waits for it, up to 30 s |
| `browser_snapshot` | `waitForText?`, `timeoutMs?` (up to 30 000) | The page as an outline with refs (`e12`), and the latest console errors and warnings |
| `browser_click` | `ref`, or `x` and `y` (CSS px) | Clicks an element or a point |
| `browser_type` | `ref`, `text`, `clear?` (default true), `submit?` | Types into a field, or chooses a `<select>` option by its label |
| `browser_press` | `key` (`Enter`, `PageDown`, `Meta+a` …) | Key strokes to the focused element |
| `browser_screenshot` | `ref?` | A PNG of the viewport, or of one element |
| `browser_eval` | `expression` | Runs JavaScript in the page and returns its value as JSON |

Each result starts with the page's title, URL and viewport (a fixed 1280 CSS px layout), then notes, such
as what another agent did in the page since this agent's last command.

- **It needs the app.** The daemon relays each command to the app's pane. A daemon without the app has
  the tools, but a call answers that the room's browser needs the Agoryx desktop app, and nothing is opened.
- **Only during the agent's own turn.** A command carries the agent's key. It must come from that agent's
  CLI, or a process the CLI started, while its turn runs; anything else is refused. A native session the
  human opens (`claude --resume …`) does not get the tools.
- **Network off, browser off.** A room with the network off refuses every command, and turning the network
  off closes the room's page. Read-only rooms keep the browser: it writes no files.
- **One page per room, shared.** The pane runs one command at a time, in arrival order across the room's
  agents; the notes say what the others did in between. Refs stay valid while their element lives. A
  command waits at most 60 s in the room, with at most 20 in flight.
- **Nothing runs after the agent gave up.** When the agent's turn ends, its commands still in flight fail
  with 409 («Your turn ended while this command was in the room's browser…»); a call the agent cancelled
  (its request closed) fails with 499. The daemon tells the app (`event: cancel`), and the pane skips such a
  command if it has not started; one already running runs to its end, and its late answer gets 404.
  `POST /api/browser` checks the running turn and the network again after reading the body, in the tick
  that hands the command on.
- **What is kept.** The trace shows each step without its values, like a command: `browser navigate
  http://localhost:5173/settings`, `browser type e5 (12 characters)`, `browser eval (340 characters)`. The
  daemon log line holds the agent, the room, the op, the outcome and the time. Agoryx keeps no screenshots,
  page text or typed values, and never acts in the page by itself.

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

- Agents run **as in the human's own terminal**. Agoryx adds no sandbox of its own and no restriction the
  human does not have; restrictions come only from the human's own room settings:
  - Claude: the human's own settings and permission mode (e.g. `auto`). Only the room's shim is allowed by
    name. With network off or read-only access, Claude runs in its sandbox (Bash auto-allowed there),
    `--permission-mode acceptEdits` (`default` and edits denied when read-only).
  - Codex: its own sandbox, `-s workspace-write` (`read-only` when the room's access is readonly). Nobody is
    at a prompt, so in an unrestricted room a request to leave the sandbox goes to Codex's own automatic
    review (`approval_policy="on-request"`, `approvals_reviewer="auto_review"`, what `--approve-for-me`
    does); with network off or read-only access it is refused, as before.
  - Network is **on** by default for both. A room turns it off with `agoryx settings --network off`
    (`internal/agora/types.ts`, `DEFAULT_SETTINGS`).
- No bypass or "dangerous" flags are ever passed.
- The daemon listens on `127.0.0.1` only, checks the `Host` header (DNS rebinding) and refuses
  cross-origin writes.
- Every `/api/*` call except `/api/health` needs the token from `daemon.json` (mode 0600). The token arrives as a header,
  or as an HttpOnly, SameSite=Strict cookie set by the `agoryx open` login link.
- An agent's key (`agx1.<room>.<agent>.<hmac>`, the HMAC under the daemon's token) is accepted in the header
  only. It is checked, not stored: signed by this token, for a room that exists and an agent seated in it —
  otherwise a 401 that says why. It survives daemon restarts; a new `daemon.token` revokes every key. It is
  attribution, not a sandbox: agents keep the access they had (they can still read `daemon.token`).
- The human's token is refused from an agent's process: the daemon looks up who holds the other end of the
  connection (`lsof`) and walks its parents; under an agent's CLI (or in its process group, e.g. a server the
  agent started) the request gets a 403 naming the agent. Agents read the token file as the human can, but
  it signs nothing for them — the one restriction that protects Agoryx itself (who did what). The lookup runs
  only while agent processes live, once per connection; without `lsof` it lets the request through
  (`internal/agora/agentprocs.ts`). An agent that detaches into a new session (`setsid`) escapes it.
- Workspace files are served under `/raw/<room>/<hmac>/…`, with a `sandbox` CSP and an opaque origin.
  Agent-made HTML (files and ```` ```html ```` blocks) can run but cannot call the API. Paths are resolved through symlinks and
  must stay inside the workspace. `.git` is never served.
- Which rooms wait for the human is the human's: `/api/attention` (the list, `view` for where a client looks,
  `seen`) answers 403 to an agent's key, `GET /api/rooms` carries `waiting` for the human's token only, and
  agents' calls never mark a room seen. The seen cursors in `attention.json` (mode 0600) can be read by any
  process of the user, like `daemon.json`: the 403 keeps them out of the API and is not a confidentiality boundary.
- The room's browser (`POST /api/browser`) takes an agent's key only, never the human's token, and only
  from that agent's own processes while its turn runs: the same process lookup, but fail-closed here, so a
  process left from an earlier turn, a key computed for another agent, or a failed lookup is refused. Hosting
  the browser and answering its commands (`/api/browser/host`, `/api/browser/answer`) take the human's
  token only. The MCP server reads only `url` from `daemon.json`.
- Every daemon refuses any request that carries the pane's `x-agoryx-pane` header, before its Host, token and
  `?t=` checks, so a page in the room's browser cannot open Agoryx itself. The app's pane sends it on every
  request.

## Storage

State lives in `$AGORYX_HOME` (default `~/.local/state/agoryx/agora`):

| Path | What |
|------|------|
| `rooms/<id>/events.jsonl` | Append-only event log. Replaying it reproduces the room state. |
| `profile.md` | Your profile, written by you (see "Your profile"). Agoryx only reads it. |
| `rooms/<id>/engine.lock` | Single-writer lock. A second process follows the log instead of driving. |
| `bin/agoryx` | The agent shim. |
| `rooms/<id>/live/<agent>.json` | The current turn of an agent kept live (`AGORYX_TURN_FILE`); exists only during its turn. |
| `daemon.json`, `daemon.token` | The running daemon's address and token. |
| `attention.json` | The human's seen cursor per room (`{ "version": 1, "seen": { "<room>": <seq> } }`, mode 0600). What waits is derived from each room's log after it. |
| `workspaces/<slug>/` | Room workspaces, only when `AGORYX_HOME` is set. |

Without `--dir`, a room's workspace is `~/agoryx/<slug>/` (git-initialised); `AGORYX_WORKSPACES` overrides it.

## Code map

| File | Role |
|------|------|
| `internal/agora/engine.ts` | Room engine: wake rules, deltas, parallel first rounds, pass, budget, table inbox, attribution, per-turn changes, checkpoints |
| `internal/agora/workspace.ts` | Workspace git helpers: dirty snapshots, tree snapshots and turn patches, checkpoints, safe paths |
| `internal/agora/prompts.ts` | Briefing (first turn) and delta prompts |
| `internal/agora/runners/{claude,codex}.ts` | Native CLI runners: session ids, stream parsing, activity traces; the live Claude / Codex (app-server) processes; `process.ts` spawns and ends CLI processes |
| `internal/agora/turn-context.ts` | The turn file a live agent's tools read instead of the environment |
| `internal/agora/native.ts` | Finds and reads the agents' native session files; imports turns taken outside the room |
| `internal/agora/doc.ts` | The canonical file: path rules, reading, line diff, baseline revision |
| `internal/agora/table.ts`, `table-cli.ts`, `bin/agoryx-agent.mjs` | Table ops, rendering, CLI parsing, zero-dependency agent shim (`say`, `table`, `read`, `diff`; the rest goes to the full CLI) |
| `internal/agora/store.ts`, `projection.ts` | JSONL event log and state projection |
| `internal/agora/actor.ts` | Agents' keys to the daemon, and who did what (`by`, guests from other rooms) |
| `internal/agora/daemon.ts`, `snapshot.ts`, `client.ts` | HTTP/SSE daemon, snapshots and patches, CLI client |
| `internal/agora/daemoninfo.ts` | Finding the running daemon (`daemon.json` + `/api/health`) without loading it |
| `internal/agora/attention.ts` | Rooms that wait for the human: what counts, what was seen (`attention.json`), where the human looks; `/api/attention` |
| `internal/agora/browser.ts` | The room's browser: agents' commands relayed to the app's pane over `/api/browser` |
| `internal/agora/browsertools.ts`, `bin/agoryx-mcp.mjs` | The MCP flags both CLIs get and the browser's trace labels; the zero-dependency MCP server the room hands them (`agoryx mcp` in the shim) |
| `internal/desktop/` | Dependency-free core for the macOS app and `agoryx doctor`: login-shell environment (`shellenv.ts`), setup checks (`doctor.ts`), daemon supervisor (`supervisor.ts`), the attention follower (`attention.ts`), the room browser's host link and page helpers (`browserlink.ts`, `browserpage.ts`) |
| `internal/agora/profile.ts` | The human's profile: reading and cutting it, the prompt blocks, who sees it |
| `internal/agora/blocks.ts` | Live html/svg fences: finding a block in a message by the hash of its body |
| `cmd/agoryx/agora.ts` | `agoryx up/new/say/tail/table/doc/diff/profile/…` |
| `cmd/agoryx/doctor.ts` | `agoryx doctor` |
| `ui/` | The web UI (React; `npm run build` builds it into `ui/dist`, which the daemon serves) |
| `web/` | The older plain page, served only when `ui/dist` is not built |

Tests: `npx tsx --test tests/agora/*.test.ts`. They use fake `claude`/`codex` binaries and need no
network or subscriptions.
