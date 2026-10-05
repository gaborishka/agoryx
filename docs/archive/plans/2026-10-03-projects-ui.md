# Projects, as Claude Code shows them — and the fixes from the UI/perf review

> **Archived design — not current instructions.** This document preserves an earlier proposal or implementation record. Versions, status claims and task lists below describe that period, not the Agoryx 0.1.0 release. Use the [current documentation](../../README.md) and source for implemented behavior.


Status: **done** 2026-10-03, all thirteen steps committed (SHAs in the route below); checked in a scratch daemon with real
claude and codex: a project made from New project with a context folder, both agents answering from it in a Work room,
a thread reported as a pill and resolved by the human, a passage sent To thread with the model and effort beside the
box, a file put in the library by + Add and named by both agents. Open: the agents read context folders listed under
the library as library files too (one agent did, one did not) — the briefing may need to say they are separate. Was:
plan, decisions by Ivan 2026-10-03. Source: a screen recording of Claude Code's projects (list, New project,
Overview panel with Threads / Library, thread pills in the chat, settings modal) and the UI/UX + performance review of
the projects work (`2026-10-02-projects.md`, done).

## Decisions (Ivan, 2026-10-03)

1. **A projects list and a New project step: yes.** This replaces "there is no separate make-a-project step" of the
   previous plan. A project is still its folder; creating one writes its name (and goal, context folders) for that
   folder. Opening a Work room in a folder stays a way in, as before.
2. **Context: several folders per project, yes.** A project has its own folder plus context folders. The agents of its
   Work rooms get access to them (Claude `--add-dir`, Codex `sandbox_workspace_write.writable_roots`), and the briefing
   names them. Adding one is a write with `by`, like any other.
3. Still in force: no coordinator (so no coordinator model/effort), Agoryx shows what agents did and never acts for
   them, nothing is auto-written, every write records `by`.

## What Claude Code shows, and what Agoryx takes

| Claude Code | Agoryx |
|---|---|
| Projects in the left nav: a grid of cards, search, sort, New project | `#projects`: cards (name, goal, folder, rooms, threads working, last activity), search, sort; "Projects" in the sidebar |
| New project: Name, Goal, Context (+ Add repos) | Dialog: Name, Goal, Folder, Context folders (+ Add); writes those for the folder, then opens it |
| Overview button in the chat header → right panel with Threads / Library | "Overview" in a Work room's header → panel tab Project with Threads / Library / Usage |
| Threads: Waiting on you / Idle / Resolved, a ✓ to resolve | Waiting on you / Working / Idle / Resolved; Resolve is the human's, recorded with `by`; Agoryx resolves nothing |
| A thread in the chat is a one-line pill | The report is a pill (status, name, agents, files, ±); the full card opens from it |
| "Sent to a thread" on a message | A message action: quote it into a thread's steer box; the human sends |
| Steer box with model and effort | The thread's agent's model and effort beside its steer box |
| Library: a tree by source, + Add, grid/list | Grouped by source (documents, attached, agents' media, context folders), + Add attaches a file to the project |
| Settings modal: General / Memory / Environment / Usage | A dialog: General (name, goal, instructions), Context, Memory, Usage, Changes |
| Coordinator model/effort | Not taken (decision 1 of the previous plan) |

## Data

- `events.jsonl` of a project gets `context.added` / `context.removed` `{ path }` and `library.added` /
  `library.removed` `{ path }` — each with `by`. `Project.context: string[]`, `Project.library: Array<{path, by, at}>`.
- `POST /api/projects` `{ dir, name, goal?, context? }` creates: the name, goal and folders written for `dir`, by the
  human. A folder that already has a name is refused with what it has (open it instead).
- A thread's resolution is an event in the thread's own room: `thread.resolved` / `thread.reopened`, human only, with
  `by`. It changes nothing for its agents; it moves the thread on the board.

## Route (one commit per step; tests, typecheck and UI build green before each)

1. **Phone header.** ✅ `ec951c0` The room header fits 375 px: secondary actions fold into its menu below a width; the side panel
   on a phone is a full-screen sheet again (no page wider than the viewport).
2. **Static assets.** ✅ `d279c57` Hashed assets served `immutable`, gzip/brotli when the browser takes it; `index.html` stays
   `no-cache`.
3. **Room list, cheaper.** ✅ `89f5976` The daemon keeps room summaries in memory (no full parse of every room per request;
   `resolveId` from the cache), and the page stops polling rooms while its tab is hidden (one load when it shows).
4. **Refresh on change.** ✅ `4191d3e` The project overview and the thread panel load again only when their rooms change (not
   every few seconds during a run), and not while the tab is hidden.
5. **Context folders.** ✅ `580ba78` Server + CLI (`agoryx project add-dir|remove-dir`), the runners pass them, the briefing names
   them, the project shows them. Tests: args for both CLIs, live fingerprints change with them, briefing lines, `by`.
6. **Projects list and New project.** ✅ `258140b` `#projects`, the sidebar entry, cards with search and sort, the New project
   dialog (folder picker, + Add context), `POST /api/projects`.
7. **Project settings dialog.** ✅ `bb25564` The gear on the project page (and in a Work room's menu) opens General / Context /
   Memory / Usage / Changes. The project page becomes its overview: rooms and threads beside the library, a "New
   room here" button, dim placeholders.
8. **Overview in the room.** ✅ `d6bc4dc` "Overview" in a Work room's header opens the panel tab Project: Threads / Library / Usage
   of its project, narrow layout.
9. **Threads by what they need from you; Resolve.** ✅ `904414f` `thread.resolved|reopened`, the groups on the board and in the
   panel, ✓ in the thread's header.
10. **Thread pill.** ✅ `17413c4` The report as one line in the feed; the full card opens in place.
11. **Send to a thread; model and effort when steering.** ✅ `9664512` The message action, and the thread's agent's model/effort
    beside its steer box.
12. **Library by source, + Add.** ✅ `e91f4e1` Groups, list/grid, `library.added|removed`, + Add from the attach flow.
13. **Feed rendering.** ✅ `470fc73` Narrow store selectors in message rows, the Markdown selector out of the per-token path.

Real E2E at the end in the scratch daemon (port 7791): create a project with a context folder, a Work room in it, an
agent reads a file in the context folder, a thread reports, the human resolves it.
