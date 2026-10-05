# Project memory

Agoryx 0.1.0 keeps **explicit, attributed memory for a project**. This is separate from a conversation's event log and from each provider's native session history.

## What belongs to a project

A project has a canonical folder, name, goal, instructions, context folders, a library and memory. Any conversation mode can belong to it. Membership does not by itself make that folder writable: Chat continues in its materials workspace, while Work uses its execution folder and permitted context roots.

Project memory contains decisions, facts, disagreements, people and preferences. Entries preserve who said them, why, when, where they came from, and objections that still stand. An entry is an attributed claim rather than an application's guarantee of truth.

## Record something

Use the project's Memory interface, or the room CLI:

```sh
agoryx memory --dir /path/to/project
agoryx memory --dir /path/to/project note "Use the existing API" --kind decision --why "Keep compatibility"
agoryx memory -r ROOM promote D1
agoryx memory -r ROOM promote Q1
agoryx memory --dir /path/to/project revise M2 "Updated decision" --why "New evidence"
agoryx memory --dir /path/to/project remove M2
```

Supported manually noted kinds are `decision`, `fact`, `person` and `preference`. Promote an unresolved question from the table to preserve a structured disagreement. Promotion copies the table's words, authors, sources and outstanding objections; it does not silently declare agreement.

An explicit removal appends a removal event. It is not a physical erasure of the underlying event log. UI updates use observed sequence numbers to reject edits made against stale records.

## Where it lives

```text
<AGORYX_HOME>/projects/<folder-hash>/
  events.jsonl
  project.json
  MEMORY.md
```

`events.jsonl` is authoritative. `project.json` and `MEMORY.md` are generated views. Do not hand-edit the Markdown file as a way to change memory; use the API, UI or CLI so provenance and replay remain consistent.

Project changes are serialized. Each mutation carries its author, sequence and timestamp. A room's native briefing references current project context and a bounded memory index; detailed entries remain available through the project commands.

## What is not automatic

Ordinary messages, every tool call and every apparent agreement do not automatically become project memory. Nothing in the private worker's sealed submissions is added to project memory. Select and record what should outlive the current task.

The room table is the live working state, not an interchangeable copy of project memory. Promoting an item is an explicit action. The user's profile is a separate document and per-agent prompt setting. Hiding it from a prompt is not a filesystem security boundary in ordinary native execution.

## Legacy CLI memory

The compatibility `agoryx chat` runtime has a different SQLite-backed memory service under `internal/memory/`, including generated `.agoryx/memory.md`, operational capture and optional consolidation. Those `/memory` slash commands describe that runtime, not the project Memory interface above. [Legacy CLI](LEGACY-CLI.md).

## Source and checks

- `internal/agora/projects.ts` — project events, locking, membership and context.
- `internal/agora/memory.ts` — note, promotion, revision, removal, presentation and briefing.
- `tests/agora/memory.test.ts` and `conversation-projects.test.ts` — provenance, disagreement, stale updates and mode-independent membership.
