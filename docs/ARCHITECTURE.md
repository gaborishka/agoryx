# Architecture

Agoryx 0.1.1 has a **room runtime** shared by the web UI, desktop app and room CLI. It also retains a separate legacy SQLite chat runtime for compatibility.

## Runtime map

```text
React UI / room CLI / Electron shell
                  |
        authenticated HTTP + SSE
                  |
             AgoraDaemon
           /             \
    RoomEngine       WorkflowService
    shared native    private phase execution
    sessions         + atomic reveal
           \             /
          local persisted records
```

The Electron shell supervises a daemon running on system Node. It does not run the model itself. Native Claude/Codex sessions remain the execution engines.

## Rooms and persistence

`internal/agora/store.ts` appends room events to `rooms/<id>/events.jsonl`. `projection.ts` folds those events into the current `RoomState`. The event log, rather than an editable snapshot, is the source of truth. A room engine lock prevents two processes from driving the same room.

The room contains its roster, messages, turns, run state, table, document revisions, workspace changes and parent/thread relationships. Agent actions keep actor identity and origin. Human authentication and agent-scoped keys are distinct; an agent cannot become the human by supplying an author field.

`daemon.ts` exposes authenticated HTTP operations and SSE updates. CLI commands can operate through the daemon; selected room commands can drive the room locally when no daemon is running. The browser UI consumes snapshots and ordered events, and guards asynchronous responses against route changes and stale state.

Default state is `$XDG_STATE_HOME/agoryx/agora` or `~/.local/state/agoryx/agora`; `AGORYX_HOME` overrides it. `AGORYX_WORKSPACES` sets where newly created Work folders live. With a custom `AGORYX_HOME` and no explicit workspace override, generated workspaces live beneath that home.

## Native Chat and Work

Both modes use `RoomEngine`, native provider sessions and the same conversation history.

- **Chat** works in the conversation's materials folder. It can belong to a project without receiving that project's additional writable context roots.
- **Work** connects an execution folder, optionally through a separate Git worktree.
- `projectKey` is logical project membership. `workspace` is the active execution directory. `project` preserves a Work location when switching to Chat. They are intentionally different.
- An explicit null project key means standalone. Older logs without the field keep their legacy folder-derived membership.
- Membership and execution-mode changes are human operations, wait for idle execution, and preserve conversation history. A directory change restarts native context. Child work threads retain their parent's project membership.

A human message starts addressed available agents in parallel. Subsequent conversation turns run against the updated shared state. Mentions select recipients; pass responses, Stop and an optional turn budget bound the discussion. The engine records cursor progress so resumed sessions receive deltas rather than the entire conversation on every turn.

Claude stream-json and Codex app-server support retained processes between turns, with process-per-turn fallbacks. `turn-context.ts` supplies current turn identity to tools. `native.ts` reconciles external native-session activity. These sessions use the ordinary room's settings; they are not the privacy boundary for blind work.

Optional Jev calls can assist coordination when separately configured. Core room operation does not require that service.

## Structured workflows

`WorkflowService` in `workflows.ts` owns Verification, Council, Tournament and Debate state machines. Runs persist separately under `workflows/` in the Agora home. State and history are human-visible; normal agent credentials cannot inspect or control them.

A start freezes the brief, criteria, roster, roles, budgets and selected materials. The service validates structured reviews, complete criterion coverage, permitted role transitions, references and human gates. Worker submissions remain sealed until the entire validated round is ready. A failed or stopped round never publishes a partial batch.

The daemon serializes native and private execution through a room-wide lease. Ordinary messages, roster changes, project/mode changes and table-preparation requests cannot start conflicting work during a private session. Deferred native wakes wait for the lease to end. Stop and shutdown revoke workers and their network gateways.

The worker boundary is implemented in `workflow-executor.ts`:

1. Create fresh working, temporary and native-home directories.
2. Resolve the trusted executable, Node runtime and installed CLI package payloads.
3. Start the whole process tree under macOS Seatbelt.
4. Supply a sanitized environment, fresh provider context and only the frozen inputs.
5. Route provider requests through a private, schema-restricted gateway. Real credentials remain in the parent.
6. Stop descendants, seal the workspace namespace, validate/export authored files, then remove temporary state.

There is no permissive fallback on unsupported platforms. `workflow-proxy.ts` restricts provider destinations, methods and payloads; `workflow-auth.ts` handles bounded parent-side credential refresh; `workflow-processes.ts` tracks cleanup. The boundary protects workers from one another, not from the human who controls the host.

See [workflow contracts](WORKFLOWS.md) for budgets, validation, recovery, APIs and known limits.

## Shared table and artifacts

`table.ts` validates authored table operations and preserves their identities, ownership and provenance. `work-table.ts` derives the presentation model: Heads-up, human decisions, current results, meaningful changes and team status.

Table components reference actual questions, proposals, steps and evidence. `intelligent-ui.ts` validates bounded declarative UI programs: 18 node types, typed controls and structured expressions. `ToolNode.tsx` renders the native layouts, charts and controls; `IntelligentTool.tsx` owns exploration, scenario saves, recovery and exports. No authored script executes in this format. `intelligent-ui-guide.ts` supplies the shared agent/CLI contract; `intelligent-ui-cli.ts` provides room-independent `ui guide` and `ui check` preflight. Native briefing version 4 migrates older bindings, and explicit tool requests include the guide even in resumed sessions.

Human input snapshots are version-checked `component-input` events and never imply approval or start turns. Each named scenario retains its author, event and model revision. Projection keeps at most 24 recent scenarios within 256,000 JSON characters; the full JSONL log retains older events. A replacement clears the active snapshot but preserves recent history for inspection/export. Earlier-model values cannot be loaded automatically into a new model.

`tool-draft.ts` stores per-tab, revision-scoped exploration and save-retry identity in bounded session storage. `tool-session.ts` validates snapshots/history, checks authoritative save receipts and recovers old drafts for explicit export. Matching a save requires nonce, actor, component and model revision, so an SSE acknowledgment before an HTTP response does not create a second scenario. The UI exposes storage failure and concurrent-save recovery rather than overwriting exploration silently.

Custom previews render behind sandboxed frames. `table-assist.ts` turns explicit human preparation requests into one ordinary agent assignment; it does not grant authority to decide on the human's behalf. `table-assist-retry.ts` preserves the selected executor, guidance and scope for a new attempt. Transport retries keep the existing nonce; a new agent attempt receives a new nonce.

The canonical document is a workspace file with recorded revisions, not a second independent transcript. Recovery snapshots and per-turn diffs retain the workspace root that produced them. Ordinary room execution does not automatically commit to the user's branch.

Agents' ```` ```viz ```` blocks are JSON specs parsed by `visuals.ts` and drawn by native components (`ui/src/components/md/Visual.tsx`), so no agent script runs in the page. Live ```` ```html ```` pages receive the room's theme as `--agoryx-*` custom properties through the frame script: it asks the page for the theme as soon as it runs, and the page sends it again on load and on every theme switch. The page's URL and hash stay its own. Workflow digests (`ui/src/lib/workflow-digest.ts`) derive argument maps, standings and criteria grids from revealed submissions only.

Private workflow artifacts remain separate from room files. The human can inspect, download, or explicitly carry revealed output forward. HTML previews use constrained, opaque-origin frames and cannot call the room API.

## Projects and memory

`projects.ts` stores project events under `projects/<hash>/events.jsonl`. The canonical folder identifies a project; rooms can share its name, goal, instructions, context folders, library and explicit memory.

`memory.ts` preserves attributed entries, reasons, sources, objections and unresolved positions. Memory changes are explicit events. `MEMORY.md` and `project.json` beside the log are generated views. Do not edit generated views as the persistence API.

The user's profile is separate from project memory. Native provider histories are separate again. See [memory](MEMORY.md).

## Access and desktop boundaries

The daemon defaults to loopback. It validates its host/origin, distinguishes human and agent credentials, scopes browser cookies to the daemon, and uses separate paired-device credentials. Enabling phone access is an explicit exposure change.

The main Electron window receives a narrowly scoped preload bridge. Agent-driven browser panes have their own sandboxed session, no preload, denied device/permission access, and explicit blocking of Agoryx endpoints. An arbitrary localhost port does not make the agent browser an authorized self-test surface.

The macOS shell uses login-shell environment discovery, setup checks, daemon supervision, tray/Dock attention and an optional launchd service. It does not ship Node. [Desktop details](DESKTOP.md).

## Source map

| Location | Responsibility |
| --- | --- |
| `cmd/agoryx/agora.ts` | Room commands and help |
| `internal/agora/daemon.ts` | HTTP/SSE, authentication, room lifecycle, workflow integration |
| `internal/agora/engine.ts` | Native turns, wakes, context, table operations, attribution |
| `internal/agora/store.ts` / `projection.ts` | Room event persistence and reconstruction |
| `internal/agora/runners/` | Native Claude/Codex transports |
| `internal/agora/workflows.ts` / `workflow-*.ts` | Private protocols, execution, auth, artifacts and handoff |
| `internal/agora/table*.ts` / `work-table.ts` | Table records, preparation and presentation |
| `internal/agora/visuals.ts` | Visual block specs: parser, plain-text reading, agent guide |
| `internal/agora/projects.ts` / `memory.ts` | Project records and explicit memory |
| `internal/desktop/` | Setup, shell environment, supervision, browser host, launchd |
| `ui/src/` | React UI; Vite output is `ui/dist/` |
| `desktop/src/` | Electron shell; output is `desktop/dist/` |
| `bin/agoryx-agent.mjs` / `bin/agoryx-mcp.mjs` | Agent command and browser integration shims |
| `tests/agora/` / `tests/ui/` | Room, boundary, lifecycle and UI-state regressions |

## Legacy compatibility runtime

`agoryx chat` uses `internal/engine/`, `adapters/`, `session/`, `orchestrator/` and `storage/sqlite.ts`. Its SQLite sessions, transport modes and `/team` commands are separate from Rooms and private workflow sessions. The project layout deliberately includes `ui/src` and `desktop/src`; the old ban on every `src/` directory no longer describes this repository.

## Verification

Build core, UI and desktop separately. Run the complete suite under `scripts/test-guard.mjs` with bounded concurrency; tests must use disposable state and repositories. Browser, native-provider, signature and notarization checks are additional evidence, not substitutes for tests. A green test suite does not prove model reasoning correct.

The legacy plain `web/` page is a fallback when no built React UI exists. Release builds must include `ui/dist` to provide the current product.
