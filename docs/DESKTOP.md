# Agoryx for macOS

`Agoryx.app` is the daemon and its room UI in one window. Opened from Finder or the Dock, it works like
`agoryx up -d && agoryx open` from a terminal: the same daemon (one per `AGORYX_HOME`), the same rooms,
and the environment your shell would give the agents. When a tool is missing, it says which one and what to run.

The app is a thin shell (`desktop/`). The daemon, the rooms and the UI are the ordinary Agoryx ones.

## Run it from the checkout

```bash
npm install
npm run build                 # once: the core and the web UI
npm --prefix desktop install
npm run desktop               # builds the core and the app, opens the window
```

`npm run desktop` is `npm --prefix desktop start`: `build:core`, the app's `tsc`, then `electron .`.
The window runs this checkout: its `bin/agoryx.js`, its `dist/`, its `ui/dist`.

To try it without your own rooms, give it another home:

```bash
AGORYX_HOME=/tmp/agoryx-try AGORYX_WORKSPACES=/tmp/agoryx-try-ws npm run desktop
```

## Build Agoryx.app

```bash
npm --prefix desktop run dist
```

This builds the core and the UI, then the app. It also stages the core's production `node_modules` in
`desktop/.stage`, and runs electron-builder. The results are in `desktop/release/`:

- `mac-arm64/Agoryx.app`;
- `Agoryx-<version>-arm64.dmg`.

The build is unsigned and arm64 only. On the first open, macOS refuses it: right-click the app → Open.
Or open it once and allow it in System Settings → Privacy & Security.

The app does not bring its own Node. The Mac it runs on needs `node` >= 22, and at least one logged-in
`claude` or `codex` CLI, both on the login shell's PATH. The first screen checks them.

## What happens when it opens

1. **Reading your shell environment.** The app runs your login shell once (`$SHELL -i -l -c …`) and
   takes its environment: PATH (Homebrew, `~/.local/bin`, nvm …), API keys, `CLAUDE_CONFIG_DIR`. A shell
   that does not answer in time is skipped; the usual install folders are added to PATH instead.
2. **Checking tools.** These are the checks of `agoryx doctor`, run with that environment:
   - Node, and the native sqlite module under that Node;
   - the Agoryx install the app runs;
   - `claude` and `codex`, installed and logged in (a room needs at least one);
   - git;
   - the state folder (`AGORYX_HOME`), and a daemon already running there.

   If something needed is missing, the screen lists it with the command that fixes it, and nothing is
   started. Warnings are shown once. After «Відкрити Agoryx» (Open Agoryx) they come back only when a check changes.
3. **Starting Agoryx.** The app uses the daemon already running for this `AGORYX_HOME`, if there is one.
   Otherwise it starts `node <root>/bin/agoryx.js up`, detached, with its output in
   `<AGORYX_HOME>/daemon.log`. If the daemon does not come up, the screen shows the end of that log.
   A daemon that is running but not answering is waited for (20s), and then reported. The app never
   starts a second one next to it.
4. **The room UI.** The window opens `<daemon url>/?t=<token>`. The daemon trades the token for its
   HttpOnly cookie, and the UI is the one `agoryx open` shows.

While the window is open, the app follows the daemon:

- a daemon restarted from a terminal: the window moves to the new one;
- a daemon that went away: the app starts it again, with backoff;
- after five failed starts in a row: the start page, with the log, «Спробувати знову» (Retry), and «Відкрити журнал» (Open log).

**Quitting leaves the daemon running** (⌘Q). Rooms and agents' turns keep going, and the CLI and a
browser still reach it. Closing the window keeps the app in the Dock; clicking the icon brings it back.

The app speaks Ukrainian, like the room UI. The menu **Демон** (Daemon) has:

| Item | What it does |
|------|--------------|
| Перевірити інструменти (Run Doctor) | the checks again, with «Перевірити агентів» (Test agents: one short real call to each logged-in agent; it costs a request each) |
| Відкрити журнал демона (Open Daemon Log) | `<AGORYX_HOME>/daemon.log` in the default viewer |
| Перезапустити демона (Restart Daemon) | stops the daemon through its API and starts a new one |
| Зупинити демона й вийти (Stop Daemon and Quit) | stops the daemon (running turns stop), then quits |

«Зупинити демона й вийти» wins over a start or a restart under way: nothing starts after it. If the daemon
does not stop, a dialog says why before the app quits. Stopping always goes through the daemon's API
with its own token. The app never signals a process it has not verified, and never touches a daemon of
another `AGORYX_HOME`.

## How it fits together

```
Agoryx.app (Electron)                                   your node (>= 22)
┌────────────────────────────────────────┐   spawn   ┌──────────────────────────────┐
│ main process          desktop/src/main │  detached │ agoryx up        the daemon  │
│   desktopEnv()   your login shell, once│ ────────▶ │   rooms, agents' CLIs, shim  │
│   runDoctor()    tools, logins         │           │   <AGORYX_HOME>/daemon.json  │
│   DaemonSupervisor  start/watch/restart│ ◀──────── │   <AGORYX_HOME>/daemon.log   │
│                                        │ /api/health└──────────────▲───────────────┘
│ window                                 │                          │
│   start page   file:, preload, IPC     │                          │ http://127.0.0.1:<port>
│   room UI      ────────────────────────┼──────────────────────────┘ /?t=<token> → cookie
└────────────────────────────────────────┘
```

The app holds no Agoryx logic of its own. At start it loads the desktop core from the install it runs:
`<root>/dist/internal/desktop/index.js`, which holds the shell probe, the doctor and the supervisor. The
core uses Node built-ins only, so Electron's main process can import it. The install `<root>` is found in
this order:

1. `AGORYX_ROOT`;
2. the app's own copy, `Agoryx.app/Contents/Resources/agoryx`;
3. from the checkout, the repository root.

The packaged copy holds:

- `dist/`, `bin/` and `ui/dist/`;
- `package.json`;
- the production `node_modules`, installed without scripts: `better-sqlite3` ships prebuilt Node-API binaries.

## Why the daemon runs on your node, not Electron's

- **Agents call back through it.** An agent's `agoryx` command is a shim that execs the daemon's own
  `process.execPath`. Under Electron that would be the app's binary, not a Node.
- **Native modules.** `better-sqlite3` is built for Node's ABI, not Electron's. Running the daemon under
  Electron would mean rebuilding it for every Electron version.
- **The daemon outlives the app.** Rooms keep running when the window is closed or the app quits. A
  daemon started from a terminal and one started by the app are the same thing, and each can find the other.

The cost is that Node >= 22 must be installed. The doctor's first check says so, with the command to install it.

## Environment

- The daemon gets the login shell's environment over the app's. Two kinds of variables are left out:
  - what only describes the probing shell (`PWD`, `SHLVL`, prompt, terminal);
  - Agoryx's turn variables.

  PATH is the shell's, then the app's entries it lacks.
- `AGORYX_HOME` and `AGORYX_WORKSPACES` set on the app's own launch win over the shell's, the way
  `AGORYX_HOME=… agoryx up` does in a terminal. Opened from Finder, the app has neither, so the shell's apply.
- **The Jev key.** `agoryx up` takes `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY` and `JEV_PROVIDER` from its
  environment first. Failing that, it reads them from a `.env` in the install it runs from.
  - From the checkout (`npm run desktop`), that is the checkout's `.env`, as in a terminal.
  - The packaged app's install sits inside the bundle and has no `.env`. Export the key in your shell's rc
    file instead: the app reads it from your login shell.

  Either way, the key goes to the daemon only, never to the agents.

## What the window may do

- Only two things load in the window: the start page, and the daemon's origin. A same-origin
  `window.open` gets a child window with the same settings. An agent's file or HTML preview (`/raw/…`)
  opens in the default browser, as do other `http(s)` and `mailto` links. Anything else is refused.
- A window or a link outside opens only right after a click, a tap, or Enter/Space in that page, one per
  gesture. Electron has no popup blocker, and an agent's HTML preview runs its own scripts.
- `contextIsolation` and `sandbox` are on; `nodeIntegration` and `webviewTag` are off.
- The preload gives `window.agoryxDesktop` to the start page only: `onState`, `retry`, `openAnyway`,
  `openLog`, `runDoctor`. Each IPC handler checks that the call came from that page.
- Permissions are denied, except for two, on the app's own pages only:
  - clipboard write, for the UI's copy buttons;
  - fullscreen, for videos.
- The token appears only in the login URL. After that, the UI uses the daemon's cookie.

The app keeps two files in `~/Library/Application Support/Agoryx`:

- `window.json`, the window's bounds;
- `desktop.json`, the warnings you opened past.

## Files

| Path | What |
|------|------|
| `desktop/src/main.ts` | the main process: start sequence, supervisor events, window, menu, navigation rules |
| `desktop/src/preload.cts` | the start page's bridge (CommonJS: sandboxed preloads cannot be ES modules) |
| `desktop/static/start.{html,css,js}` | the start page (strict CSP, no inline script) |
| `desktop/scripts/make-icon.mjs` | draws the icon (`build/icon.png`, `build/icon.icns`) at build time |
| `desktop/scripts/stage-core.mjs` | the core's production `node_modules` for the package |
| `desktop/electron-builder.config.cjs` | packaging |
| `internal/desktop/` | the core the app loads: `shellenv`, `doctor`, `supervisor` |

## What's next

- Notifications, a menu-bar icon, a Dock badge: for when a room waits on you.
- A launchd service: the daemon at login, without the app.
- `agoryx open .` bringing up the app, through a control socket.
- `agoryx://` links.
- A shared browser pane.
- Signing and notarization, and x64 or universal builds.
