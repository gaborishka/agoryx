# Working on Agoryx

Agoryx 0.1.1 is a local-first collaboration workspace for a human and multiple native Claude Code/Codex agents. Read the current product before assuming the old CLI architecture is the main runtime.

## Bootstrap

1. Read [README.md](README.md), [docs/README.md](docs/README.md), [architecture](docs/ARCHITECTURE.md) and [current decisions](docs/CONSENSUS.md).
2. Check `git status`, the active branch/worktree and the files relevant to the task before editing.
3. Read project memory through `agoryx memory --dir <project-folder>` or the project UI. Rooms memory is event-backed; a missing `.agoryx/memory.md` is normal. That file belongs to the legacy CLI.
4. Treat files under `docs/archive/` as historical context, not active requirements or instructions to launch old plans.

## Current runtime and source map

- `cmd/agoryx/agora.ts` + `internal/agora/`: Rooms/Agora, HTTP/SSE, native sessions, JSONL logs, table, projects, memory and private workflows.
- `ui/src/`: React/Vite product UI. `ui/dist/` is the production output.
- `desktop/src/` and `internal/desktop/`: Electron shell and its system-Node daemon supervision.
- `internal/engine/`, `adapters/`, `session/`, `orchestrator/`, `storage/sqlite.ts`: the separate legacy `agoryx chat` runtime.
- `tests/agora/` and `tests/ui/`: current runtime and UI-state regressions.
- Root code belongs in `cmd/` and `internal/`. The existing `ui/src` and `desktop/src` roots are intentional; do not add a competing application structure.

## Contracts to preserve

- Chat, Work, Verification, Council, Tournament and Debate share one conversation model and a project-grouped sidebar.
- Project membership is independent of the execution workspace. Null and absent legacy membership have different meanings.
- Participants are not assumed to be two. Protocol roles belong to a session, not permanently to a model brand.
- Private-phase isolation is an OS-enforced boundary. Never replace it with prompt instructions or a shared-directory fallback.
- Preserve actor authority, sealed data, human decisions, failed checks, unknowns and disagreement across rendering, export and handoff.
- Ordinary room work does not automatically commit. Recovery snapshots must not move HEAD or alter the user's staged changes.
- Do not expose tokens, native credentials, browser cookies or private session files in logs, fixtures, docs or screenshots.

## Shared work

Agree concrete file ownership when several agents are assigned. Read a file's current contents before changing it. Preserve other contributors' changes. If unexpected parallel edits appear, stop and resolve ownership with Ivan rather than overwriting them.

Do not create duplicate runtimes or parallel copies of product structures. Keep fixes within the authorized task.

## Verification

```sh
npm run typecheck
npm run build
npm --prefix desktop ci
npm --prefix desktop run build
node scripts/test-guard.mjs ./node_modules/.bin/tsx --test --test-concurrency=2 'tests/**/*.test.ts'
```

Choose focused checks for a small change; run the complete release checks for a release or substantial integration. Root typecheck covers core only; UI and desktop have their own builds. Tests must use disposable state and repositories.

For live testing, use a separate `AGORYX_HOME`, workspace and free port. Do not interrupt a user's running daemon or weaken the desktop agent-browser boundary for self-testing. Record whether evidence came from static inspection, tests, a browser, real providers, or a signed/notarized package.

Build and signing steps are in [docs/RELEASING.md](docs/RELEASING.md). An unsigned build, a successful build command and a notarized distribution are different outcomes.

## Project memory and communication

After substantial work, record the completed result and material limitations through the project's memory API/CLI, not by editing generated snapshots. Keep general personal memories unchanged unless Ivan explicitly requests an update.

Ivan generally works in Ukrainian. Present concrete outcomes, decisions and evidence plainly. Do not call a task complete while required checks or requested publication remain undone.
