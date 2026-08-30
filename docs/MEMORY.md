# Agoryx Long-Term Memory

This document describes the *ideas* behind long-term memory in Agoryx — why it exists, what it promises, and the design forces that shaped it. Implementation details live in the code.

## 1. Why Memory Exists

Agoryx is a shared space for humans and multiple agents. A conversation that forgets itself every session is not a collaborator — it's a disposable tool. Memory closes that gap.

An agent returning to a room should already know:

- What the team decided, and why.
- What branch is active, which worktrees are live.
- What went wrong recently.
- What's blocked, and what's next.

Without memory, every session begins at zero. With memory, context is a given, not a chore.

## 2. The Core Idea: Log + Projection

Memory is built on the **event-sourced reducer–snapshot** pattern:

- **The log is the truth.** Every meaningful event — a decision, a note, a dispatch, a worktree created — is appended as an immutable row. History is never rewritten.
- **The snapshot is a projection.** It answers "what is the current state?" — goal, branch, key decisions, blockers, next actions. It is *derived* from the log, not independently stored.

If the snapshot is lost, it can be rebuilt from the log. If the reducer (the function that projects events into state) changes, old events can be replayed to produce a new snapshot.

This split is deliberate. It separates *what happened* from *what it means now*. Meaning can evolve; history cannot.

## 3. The Viewport

Humans and agents read prose, not database tables. So the snapshot is rendered into an auto-generated Markdown file that anyone can open and read.

Three rules govern the viewport:

- **Auto-generated.** It is written from the snapshot. Hand-edits don't survive the next render.
- **Atomic.** Readers never see a half-written file. Writes are swapped into place as a single operation.
- **Debounced.** A burst of events produces one render, not twenty.

The viewport is a read-only window into memory. To change what memory says, you append an event — you do not edit the Markdown.

## 4. What Gets Remembered

Not everything is worth keeping. Events fall into two categories:

- **Signal** — decisions, notes, worktree lifecycle. These record what the team has committed to or observed. They are protected: never pruned by age.
- **Noise** — operational events like dispatches and errors. Useful for a while, then clutter. These fade.

The bias is toward preserving human intent. Operational exhaust is disposable; decisions and notes are not.

## 5. Recovery

When a room loads, memory asks one question: *is the snapshot consistent with the log?*

There are only a few possible answers:

- **Already current** — nothing to do.
- **Snapshot behind the log** — fold the new events forward.
- **Snapshot missing or built by an older reducer** — replay the whole log from scratch.
- **Snapshot claims to be ahead of an empty log** — it's stale; discard it.

Recovery is cheap when nothing is wrong, and a full replay deterministically reproduces the state implied by the log. That determinism is the safety net: any corruption can be fixed by running the reducer again.

The one asymmetry is consolidation (§6): it refines the *snapshot* without rewriting the log. A full replay therefore restores exactly what the log holds — including near-duplicate decisions that a consolidation pass had collapsed — until the next pass runs.

## 6. Consolidation ("Dream")

Periodically, memory does a pass of pruning:

- Stale operational events age out.
- Similar decisions collapse into one. "Use Postgres" and "Decision: use Postgres" are the same thought; the restatement is dropped.

This pass is rule-based, not driven by an LLM. Pruning memory is too consequential to leave to a model that might hallucinate relevance. The rules are conservative, and the whole pass is opt-in — by default, nothing is ever pruned.

The two halves of the pass touch different layers. Aging out stale operational events removes them from the log itself. Collapsing similar decisions edits only the snapshot's decision list — the underlying decision events stay in the log, so a rebuild from the log brings the restatements back until the next pass collapses them again.

The name *dream* is deliberate: it is the background pass that lets an agent wake up with a clearer head.

## 7. Concurrency

One room, one writer at a time. Every mutation that ends in a render is serialized per room. This avoids a class of bugs where two overlapping events produce a snapshot that reflects neither.

The log itself leans on the database's transactional guarantees. Events carry unique identifiers, so a retry cannot produce a duplicate entry.

## 8. The CLI Surface

Memory is exposed through a small `/memory` command set:

- Inspect the current state.
- Record a decision or a note.
- Browse the history with filters.
- Force a rebuild of the snapshot from the log.
- Force a fresh render of the viewport.

The surface is intentionally narrow. Adding a memory entry is trivial; editing or deleting past entries is not. Memory is something you grow, not something you manicure.

## 9. Guarantees

A reader of memory can rely on the following:

- **Decisions and notes are never silently lost.** Only an explicit action or a reducer-version bump can remove them.
- **Events are strictly ordered within a room.** Order is defined by the log's identifiers, not by timestamps.
- **The viewport is always internally consistent.** You read a complete snapshot or none at all, never a half-written one.
- **Rebuilds are safe.** A full rebuild deterministically reproduces the state implied by the log. With consolidation enabled, snapshot-level dedup of similar decisions is not replayed, so collapsed restatements reappear until the next consolidation pass.
- **Nothing is ever pruned unless consolidation is explicitly enabled.** The default is hoarding, not forgetting.

## 10. Design Forces

Three forces shaped the memory system:

- **Durability over cleverness.** A simple append log beats a smart cache. Events are cheap; regret over lost decisions is expensive.
- **Derived state over stored state.** If it can be computed, compute it. Don't hold two copies of the same truth.
- **Readable by default.** If humans cannot open and read memory, they cannot trust it. Markdown is non-negotiable.

## 11. What's Not Done

Today, memory captures *that* things happened — which events fired, which decisions were made. It does not yet interpret them deeply. The reducer is intentionally thin: it mostly accumulates decisions and tracks its position in the log. Richer state (goal, blockers, next actions) is allowed by the schema but not yet derived automatically.

Directions, not promises:

- A richer reducer that derives goal, blockers, and next actions from structured notes.
- Semantic deduplication using embeddings, not string similarity.
- Cross-room memory — user profile, shared knowledge.
- Alternate viewports: JSON for tooling, concise digests for humans.
- Export and import for portability between machines.

Until then, memory is a floor, not a ceiling: enough for continuity, with room to grow.
