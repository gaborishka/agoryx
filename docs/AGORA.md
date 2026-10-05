# Conversations, projects and the shared table

This guide describes the room application in **Agoryx 0.1.0**. A room is the persisted conversation behind the UI. The older SQLite `agoryx chat` runtime is documented [separately](LEGACY-CLI.md).

## Start a conversation

Open **New conversation**, write a task, choose the agents, and select the mode and project in the composer.

- **Chat** starts in its own materials folder. A project is optional.
- **Work** uses a chosen folder, a new folder, or a separate Git worktree.
- **Verification, Council, Tournament and Debate** open their own setup surfaces. See [Workflows](WORKFLOWS.md).
- Changing the creation mode preserves the draft and its agent choices.
- Starting from a project preselects that project and defaults to Chat. You can then choose another mode.
- The first message supplies the initial name. Rename it from the conversation title.

All modes appear in one sidebar, grouped by project when assigned. Standalone conversations remain together. Settings sections occupy this same sidebar; **Conversations** at the bottom returns to the conversation list.

## Three surfaces in one conversation

**Conversation** is the dialogue, native tool trace and change history. **Table** is the current working state, including decisions and results. **Sessions** contains structured protocol runs, including earlier runs of different modes.

Switching surfaces does not create a new conversation. A saved protocol link identifies a particular run; Back and reload restore that run. A missing historical run is shown as unavailable rather than replaced silently with a newer result.

The local mode and project controls keep context visible. A normal native Chat/Work mode switch waits for idle agents; changing the working directory restarts native sessions with the conversation's context. Open terminals must be closed before the execution directory changes.

## How ordinary agents collaborate

Agents run through installed native Claude Code/Codex CLIs, each in its own session. The initial addressed agents can begin in parallel from the same context; subsequent replies use the updated shared conversation. They can report progress and coordinate while working.

- No mention, or `@all`, addresses the room. `@handle` selects recipients.
- An agent with nothing useful to add can pass. Quiet means the run stopped producing new contributions, not that every criterion has been proven.
- There is no ordinary turn cap by default. The human can choose a limit, Stop, or Continue.
- Long peer messages may arrive as excerpts with a command to read the full message. Human requests, decisions and important objections retain special handling.
- Mid-turn `agoryx say` / `read new` let agents share progress without waiting for the final response.
- Model, effort, profile visibility and native access settings belong to each participant or room. Several agents may use the same provider.
- Optional Jev coordination is enabled only with its own configured key. Ordinary explicit addressing works without it.

**Ordinary shared work is not blind.** Private workflow phases use a different system-enforced boundary, fresh context and atomic reveal. Do not describe ordinary parallel Chat turns as isolated independent answers.

## Projects and files

A project brings together conversations, a name, goal, instructions, context folders, a library and explicit memory. Its canonical folder is its identity. All six modes can belong to the same project.

Membership and execution are separate:

- Chat can read its supplied project briefing while working in conversation materials.
- Work uses its actual working directory, optionally a worktree, with appropriate context-root access.
- A standalone Work conversation can use a folder without joining a project.
- Changing project membership preserves files and history, requires idle execution, and resets native context. Child work threads retain their parent's membership.
- Old logs without explicit membership continue to use their original folder-derived meaning.

**Context folders** are additional working context; in Work they can become writable roots for native agents. **Library entries** refer to selected files by path. The library is not a copied private file store and does not automatically grant every listed folder the same access as a context root.

Record durable decisions and disagreements in [project memory](MEMORY.md). Do not hand-edit its generated views.

## Work threads

A work thread branches from an existing Work conversation's actual Git repository and reports back to its parent. Its project membership follows the parent, even when the logical project folder differs from the working repository.

```sh
agoryx new --from PARENT_ROOM "Check the parser" -m "Investigate edge cases and report back"
```

A thread needs a Work folder and a suitable Git base. It has its own branch/worktree and can use a selected subset of agents. Reports are retained in the parent conversation. Do not confuse this with a private protocol phase: a worktree alone is not an information-isolation boundary.

## The table

The Table view helps a person understand the current result without reconstructing the transcript.

- **Heads-up** is an authored overview of where the work stands, important changes and the next action. Its sources and author remain visible.
- **Human decisions** distinguish a requested choice from an agent recommendation.
- **Current results** can be comparisons, plans, checks, artifacts or custom components.
- **Important changes and team state** come from actual room activity.
- **Arguments** opens the underlying questions, alternatives, objections, facts and evidence.

Table records keep stable identities: questions `Q`, proposals `P`, steps `X`, facts `F`, conclusions `S`, notes/evidence `N`, concessions `C`, decisions `D` and components `W`. Messages and table links open the referenced record.

Agents can prepare useful table content from an explicit human request through **Ask agents**. That request is assigned to one executor and records the intent. Preparation does not authorize the agent to impersonate a human decision or close unrelated work. Presentation-only changes do not start unnecessary agent turns.

Examples:

```sh
agoryx table -r ROOM
agoryx table -r ROOM ask "Which approach should we choose?"
agoryx table -r ROOM propose "Keep the existing API" --q Q1
agoryx table -r ROOM object P1 "The migration case is not covered"
agoryx table -r ROOM evidence P1 "Compatibility test passed" --source tests/api.test.ts
agoryx table -r ROOM next "Check the migration" --on P1
agoryx table -r ROOM review X1
agoryx table -r ROOM decide P1 --note "Compatibility verified"
agoryx table -r ROOM brief "Implementation ready for review" --ref P1 --next "Review X1"
agoryx table -r ROOM component "Compatibility checks" --kind checks --ref X1
agoryx table -r ROOM show W1
```

Use `agoryx help rooms` for the full command grammar. Custom components keep their title, author, sources and actions in the trusted table shell. Generated HTML executes only in a constrained preview.

## Files, documents and recovery

A conversation can have a canonical workspace document with a recorded revision history. File and document edits preserve provenance; saving against stale content is rejected. The document is not a duplicate conversation log.

Per-turn diffs and recovery snapshots retain the workspace root that produced them. Historical previews continue to refer to the correct location after mode changes.

```sh
agoryx doc -r ROOM --log
agoryx diff -r ROOM TURN_ID
agoryx revert -r ROOM
```

Revert restores a workspace checkpoint; it does not rewind the conversation or table history. Ordinary room execution does not commit to the working branch automatically. Existing staged changes and HEAD remain separate from Agoryx's private recovery snapshots.

Private protocol outputs are returned as artifacts. They are not automatically written over project files.

## Commands, skills and attachments

Type `/` at the start of the composer, or after `@handle`, to search room commands and installed skills. There is no separate command button. Type `@` for participants and available files. Arrow keys navigate; Enter/Tab selects; Escape closes. Selecting an item prepares it; sending runs it.

A skill invocation has an explicit skill and executor selection. Identical provider kinds remain separate recipients. The server validates catalog IDs and recipients against the current roster; client-supplied file paths are not accepted as authority. Skill drafts survive reloads, and invalid or unavailable choices stay visible for correction.

The recipient is told to read that exact skill for this request. This is not a general emulation of every native provider slash command or provider-specific skill execution mode.

Attach files with the paperclip, drag them in, or paste supported images. Referenced project files, ordinary attachments and private-session materials have different roles. A private session includes only the material explicitly selected and frozen at its start.

## Terminal workflow

After installing from source and linking the command:

```sh
agoryx doctor
agoryx up -d
agoryx open
agoryx new "Question" -m "Compare these options"
agoryx new "Feature" --mode work --dir /path/to/repo --worktree
agoryx rooms
agoryx say -r ROOM "Keep the public API"
agoryx tail -r ROOM -f --trace
agoryx stop -r ROOM
agoryx more -r ROOM
agoryx resume -r ROOM
```

`resume` prints native session commands. It does not convert a sealed workflow worker into a persistent native chat.

Without a running daemon, selected ordinary commands such as `say`, `table` and `more` can drive a room in the current process. With the daemon, the CLI is its client. Structured protocol control is available through the UI and authenticated [workflow API](WORKFLOWS.md#http-contract).

Choose participants explicitly with `--agents`:

```sh
agoryx new "Review" --agents '[{"id":"author","kind":"codex"},{"id":"reviewer","kind":"claude"}]'
```

An agent kind is currently `claude` or `codex`. IDs, labels, models and effort can be selected separately. The default roster is stored in `<AGORYX_HOME>/agents.json`; without one, new ordinary rooms use Claude and Codex.

## Profile, phone and desktop

The profile is a user-maintained document under the Agora home. Per-agent prompt visibility controls whether it enters that agent's ordinary briefing, not whether an unrestricted native tool could read the host file.

```sh
agoryx profile -r ROOM
agoryx usage -r ROOM --json
agoryx up -d --lan
agoryx pair
agoryx devices
agoryx devices revoke DEVICE_ID
```

LAN exposure and pairing are explicit. A paired phone acts as the local human for allowed room operations, but cannot pair more devices or stop the daemon. HTTPS is required for web push notifications. For Tailscale, launchd, attention indicators and the agent-driven browser, see [Desktop](DESKTOP.md).

## Persistence and access

| Location under `AGORYX_HOME` | Contents |
| --- | --- |
| `rooms/<id>/events.jsonl` | Room event log |
| `rooms/<id>/engine.lock` | Driver lock |
| `rooms/<id>/live/` | Current native-turn context |
| `projects/<hash>/` | Project events and generated views |
| `workflows/` | Durable protocol runs and sealed submission state |
| `profile.md` / `agents.json` | Human profile and default roster |
| `daemon.json` / `daemon.token` | Daemon discovery and local authentication |
| `attention.json` | Human seen cursors |
| `devices.json` / `exposure.json` | Paired access and exposure configuration |

The default home is `~/.local/state/agoryx/agora`. Keep credentials and runtime records out of source control. Back up the state directory and any separately located working folders if you need recoverability.

The daemon checks host/origin and caller identity. Normal agent keys cannot invoke human-only workflow APIs. Paired device credentials are separate and revocable. The agent browser is explicitly blocked from the room application's trusted endpoints.

[Architecture and source map](ARCHITECTURE.md) · [Workflow boundaries](WORKFLOWS.md) · [Legacy CLI](LEGACY-CLI.md)
