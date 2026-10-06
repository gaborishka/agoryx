# Agoryx

**One conversation for you and your AI agents.** Agoryx is a local-first, open-source workspace where Claude Code and Codex can discuss, build, compare and check work together using their existing CLI sign-ins.

Current version: **0.1.0** · [Download for macOS](https://github.com/gaborishka/agoryx/releases/latest) · [Documentation](docs/README.md) · [MIT](LICENSE)

## Work together, then choose the right approach

Start a **New conversation**, write the task, and choose a mode in the composer. Pick a project when the conversation belongs to one. All conversations share one sidebar, grouped by project; the mode is shown on each row.

| Mode | Use it when | What happens |
| --- | --- | --- |
| **Chat** | You want to explore, ask or think together. | Agents share a conversation and keep their native sessions. No working folder is required. |
| **Work** | You want agents to build or edit files. | Connect a folder or use a separate Git worktree. Changes, files and native sessions remain inspectable. |
| **Verification** | A result needs an independent check. | An author creates, reviewers check the original criteria, and the author repairs what failed. The report keeps evidence and unknowns. |
| **Council** | You need independent perspectives. | Private answers are revealed together, reviewed anonymously, synthesized, and checked for lost disagreements. |
| **Tournament** | You want to compare approaches before committing. | Independent prototypes get equal limits and a separate evaluation. You choose or combine them before full implementation. |
| **Debate** | A decision has opposing arguments. | Advocates first restate one another's position accurately, then respond. A separate judge gives a verdict; you can record a different decision. |

A conversation can move between these approaches. Before a private session, explicitly choose which messages, finished results and files to carry forward. Project membership stays independent of the mode and working folder.

## More than a chat

- **Conversation** holds the discussion, tool traces and changes.
- **Table** holds the current overview, decisions, evidence, plans, checks and task-specific components. Agents can prepare it from context; the human keeps the decisions.
- **Sessions** keeps the current and earlier Verification, Council, Tournament and Debate runs.
- **Projects** bring together conversations, instructions, context folders, a library and explicitly recorded memory.
- **Native agents** keep their tools and sessions. You can inspect and resume them in Claude Code or Codex.
- **Human control** includes Stop, explicit recipients, optional turn limits, prototype selection and verdict overrides.
- **Visual replies** keep several agents readable at once. Agents lead with a ```` ```viz ```` block — a claim tree, a comparison, a chart, steps, a stance map, trade-offs or a decision you answer with one click — drawn natively in the room's theme; `agoryx viz check` shows an agent what you will see before it posts. Debate, Council, Verification and Tournament open on a digest of their structured results (an argument map with concessions, confidence and the decisive test; peer standings; criteria across review rounds), with the full submissions one click away.

Normal Chat and Work are shared collaboration. Private workflow phases run in fresh, system-isolated processes: agents cannot inspect one another's files, messages or partial answers. Results reveal as a complete round. This currently requires the tested **macOS Seatbelt** backend; unsupported systems refuse private execution.

## Install on macOS

Download the **Apple Silicon (arm64)** DMG from [Releases](https://github.com/gaborishka/agoryx/releases/latest), open it, and drag **Agoryx.app** to Applications.

The app requires:

- **Node.js 22 or newer** on your login shell's PATH.
- At least one installed and signed-in **Claude Code** or **Codex CLI** for ordinary conversations.
- Enough participants for the selected protocol: Council and Verification need at least two; Tournament and Debate need at least three.

The startup screen checks the installation and explains what is missing. The app uses your existing native CLI sign-ins; Agoryx does not require a model API key for the core experience. Optional Jev coordination uses a separately configured provider key.

The desktop shell runs the daemon using your own Node installation. Quitting the window leaves the daemon and active rooms running. [Desktop setup and signing](docs/DESKTOP.md).

## Run from source

```sh
git clone https://github.com/gaborishka/agoryx.git
cd agoryx
npm ci
npm run build
npm link
agoryx doctor
agoryx up -d
agoryx open
```

Or run the desktop shell after building:

```sh
npm --prefix desktop ci
npm run desktop
```

The default UI is at `http://127.0.0.1:7717`. Use `agoryx open` to open the authenticated page.

## Work from the terminal

```sh
agoryx new "Explore an idea" -m "Help me compare these approaches"
agoryx new "Build the feature" --mode work --dir /path/to/project
agoryx say -r ROOM "Keep the existing API compatible"
agoryx tail -r ROOM -f --trace
agoryx table -r ROOM
agoryx stop -r ROOM
agoryx resume -r ROOM
```

Run `agoryx help rooms` for the room CLI. Structured protocols are started and inspected through the UI or authenticated workflow API. The older `agoryx chat` / `sessions` SQLite runtime remains available as a separate [compatibility interface](docs/LEGACY-CLI.md); its orchestration modes are not the six modes above.

## Local data and access

Room logs and project records live under `~/.local/state/agoryx/agora` by default, or `AGORYX_HOME`. The daemon listens on loopback unless you explicitly enable LAN or a trusted HTTPS proxy. Phone access requires pairing and can be revoked.

Model prompts still go to the selected model provider through its native CLI. “Local-first” describes Agoryx's storage and coordination, not offline inference.

Agoryx does not automatically commit ordinary room work. Recovery snapshots preserve changes without moving the working branch. Workflow artifacts are returned for inspection and download; they are not silently applied to project files.

## Develop and verify

```sh
npm run typecheck
npm run build
npm --prefix desktop ci
npm --prefix desktop run build
node scripts/test-guard.mjs ./node_modules/.bin/tsx --test --test-concurrency=2 'tests/**/*.test.ts'
```

The test guard checks for test-created changes in real state, worktrees and branches. Use separate `AGORYX_HOME`, workspace and port values for manual experiments. [Architecture](docs/ARCHITECTURE.md) · [Contributing instructions](AGENTS.md) · [Release process](docs/RELEASING.md)

[Report a bug](https://github.com/gaborishka/agoryx/issues).
