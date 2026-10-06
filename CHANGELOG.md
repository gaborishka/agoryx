# Changelog

## Unreleased

- Visual replies: agents lead with native ```` ```viz ```` cards (claims, compare, chart, stats, steps, stance, tradeoff, decision) instead of long prose; the room briefing makes this the default and `agoryx viz check` validates a block before posting.
- Workflow digests: Debate opens on an argument map (concessions, confidence by phase, the crux and its decisive test, the bench's leaning), Council and Tournament on anonymous standings, Verification on a criteria-by-round grid; full submissions fold behind one control.
- Live html pages receive the room's theme as `--agoryx-*` variables, live across light and dark.

## 0.1.0 — 2026-10-05

The current Agoryx release brings the room-based product into one distribution.

- Shared native Claude Code/Codex conversations with inspectable sessions, tool traces and file changes.
- Separate Chat and Work modes, plus Verification, Council, Tournament and Debate with dedicated result surfaces.
- System-enforced private phases, equal participant limits, frozen inputs, atomic reveal and preserved disagreements.
- A compact mode/project composer and one conversation list grouped by project.
- Projects with instructions, context folders, a library, explicit memory and linked work threads.
- A shared table with an authored overview, decisions, evidence, plans, checks and custom components.
- Persistent protocol history, explicit handoff materials, downloadable artifacts and editable discussion drafts.
- A macOS Apple Silicon desktop shell, setup checks, daemon supervision, attention indicators, phone pairing and optional launchd integration.
- A documented legacy SQLite CLI for existing workflows.
- Updated installation, architecture, user and release documentation.

Private execution currently uses macOS Seatbelt. The desktop app needs system Node.js 22+ and compatible installed native agent CLIs. See the release assets for the signed distribution and checksums.
