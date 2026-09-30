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

The build is arm64 only, and unsigned unless `AGORYX_SIGN_IDENTITY` names a signing identity from your
keychain (see banners below). On the first open, macOS refuses an unsigned build: right-click the app → Open.
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
   Otherwise it starts `node <root>/bin/agoryx.js up`, detached (or through launchd, when the
   [login service](#the-daemon-at-login-without-the-app) is installed), with its output in
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
│                                        │/api/health│                              │
│   BrowserPanes   the room's browser    │ ◀───────▶ │   browser relay: commands    │
│                  over CDP              │ host link │   from agents' agoryx mcp    │
│                                        │ SSE, POST └──────────────▲───────────────┘
│ window                                 │                          │
│   start page   file:, preload, IPC     │                          │ http://127.0.0.1:<port>
│   room UI      ────────────────────────┼──────────────────────────┘ /?t=<token> → cookie
│   room's browser  one view per room    │
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

## The daemon at login, without the app

```bash
agoryx service install     # a LaunchAgent for this AGORYX_HOME; loads it now and at every login
agoryx service status      # the plist, launchd's state and pid, and whether the running daemon is the service's
agoryx service uninstall   # unload it (launchd stops the daemon it runs) and remove the plist
```

- **What it runs.** `~/Library/LaunchAgents/dev.agoryx.daemon.plist` runs `<node> <root>/bin/agoryx.js up
  --login-env`, with the node and the install that ran `install`. Moved the install or upgraded node? Run
  `install` again; `agoryx doctor` and `service status` say when a path in the plist is gone.
- **One per `AGORYX_HOME`.** The default home gets `dev.agoryx.daemon`; any other gets the label plus a hash
  of its path. The plist pins that home (`AGORYX_HOME`, `AGORYX_WORKSPACES`, `XDG_STATE_HOME` as set at
  install), so an rc file that exports another `AGORYX_HOME` does not move the service's daemon.
- **No keys in the plist.** It holds PATH, SHELL and the home only. With `--login-env`, `up` reads the login
  shell's environment at each start, the way the app does, so keys and PATH changes in your rc files apply
  at the next start. The log says which: «environment from the login shell (…)».
- **When it runs.** At load (login, or `install`) and again after a crash (`KeepAlive` on an unsuccessful
  exit, at most every 10s). `agoryx down` exits cleanly, so launchd leaves the daemon down until the next
  login or `agoryx up -d`. A daemon that is already running when the service starts makes `up` exit 0 at
  once: the service never races it or spins.
- **Output** goes to `<AGORYX_HOME>/daemon.log`, as with the app.

The app and `agoryx up -d` start a loaded service's daemon through launchd (`launchctl kickstart`), never
beside it. The supervisor still watches it and kickstarts it after it goes away. Stopping the service
(`uninstall`, logout) sends the daemon SIGTERM: it stops the running turns and closes its rooms. In
source mode (no `dist/`), `bin/agoryx.js` passes SIGTERM and SIGHUP on to the daemon it runs.

Before attaching, the app checks that the process listening on the daemon's port is the pid in
`daemon.json` (by `lsof`). A port held by another process, or by another user, is reported and never
given the token.

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

## When a room waits for you

The daemon keeps track of which rooms need you, and the app shows them. A room waits for you after:

- **an agent's `@<you>`** in a message or a mid-turn update;
- **a run that ended with something to read:** the agents finished, or the turn budget ran out;
- **a run stopped by an agent** (from its own room or another), **or cut short** with nobody credited:
  a crash, or Ctrl-C on `agoryx up`. The banner says «<агент> зупиняє розмову», or «Розмову перервано»
  when nobody is credited; the menu and the sidebar say «зупинено» for both;
- **an agent's turn that failed** (not logged in, a CLI that would not start …). This comes as one item
  at the run's end, naming the agent.

Never: your own messages and stops (from the UI, `agoryx say` or `agoryx down`), a run in which every
agent passed, `@all` alone, table moves, and what the agents say in their own CLI sessions. One room has
one item, the most important unseen one: «агенти закінчили» never hides an unseen question, stop or error.

A room stops waiting once you see it:

- **Looking at it.** In the app, that means its window is focused, visible and not minimized, shows that
  room, and the screen is not locked. The main process reports this once a second, and says it stopped
  looking when the app quits (best effort: the quit does not wait for it). In a browser tab, the
  tab is visible and focused. A room you are looking at never starts waiting.
- **Acting in it:** a message, a table move, a stop, a rename, settings.
- **«Позначити все переглянутим»** (Mark all as seen) in the menu-bar icon's menu.

What the app shows:

- **The menu-bar icon** gets a dot while any room waits. Its menu lists them (up to 10), each with its
  reason; choosing one opens that room in the window. The menu also has «Позначити все переглянутим»,
  «Відкрити Agoryx» and «Вийти з Agoryx». It says «Agoryx не відповідає» while the daemon does not answer.
- **The Dock badge** is the number of rooms waiting.
- **Banners**, expected in a signed build only. This is not verified yet, and is Ivan's to do: a signed
  build (the banner spike in `docs/plans/2026-09-29-desktop-attention.md`) has not shown a banner so far, and an unsigned one fails each banner (`UNErrorDomain error 1`, logged once). A room gets
  a banner when it starts waiting, not again for each new reason. Rooms that start waiting together get
  one banner, 2.5 s after the first, and there is at most one banner every 10 s. Clicking a banner opens its room. Banners for other rooms still show while
  the app is focused, but the room on screen never gets one. An unsigned build has the icon, the badge and
  the sidebar dot only. If macOS refuses a banner, the menu says «macOS не показує сповіщення» (macOS
  shows no notifications); turn them on in System Settings → Notifications, or build signed:
  `AGORYX_SIGN_IDENTITY="Apple Development: …" npm --prefix desktop run dist`, with an identity from your keychain.
- **The room UI**, in the app and in a browser, has a dot next to each waiting room in the sidebar.

Security notes:

- What you have not seen is yours. `GET /api/attention`, `POST /api/attention/view` and
  `POST /api/attention/seen` answer 403 to an agent's key, and `GET /api/rooms` carries `waiting` for the
  human's token only. Agents' calls never mark a room seen.
- The seen cursors live in `<AGORYX_HOME>/attention.json` (mode 0600). Like `daemon.json`, any process of
  your user can read it, agents' processes included: the 403 keeps it out of the API, and is not a
  confidentiality boundary.
- The app follows whichever daemon `daemon.json` names. A process of your own user could write that file
  and stand in for the daemon; it would learn which room you look at, and could already read the real
  token. Checking the listener's pid belongs to the supervisor, and is not done yet.

## The room's browser

In the app, each room has one real browser page. The room's agents drive it and you watch: open the dev
server they started, click through a form, read the console, take a screenshot. The page lives inside the
Agoryx window, so the room UI in another browser has no such panel.

**What you see.**

- «Браузер» in the room's header, next to «Документ», shows the page in the side panel. The panel never
  opens by itself: agents can use a page nobody looks at.
- While an agent drives the page, the panel names it, and the name stays 3 s after its last command.
- The toolbar has «Назад», «Вперед», «Оновити», the address, and «Відкрити у своєму браузері» (the page's
  address in your default browser). The address goes wherever an agent may go (below). What you do in the
  page is yours too: an agent's next result says that the human used the browser since its last command.

**How agents use it.** Both CLIs get one MCP server from the room, `agoryx mcp` (the agents' own `agoryx`
shim), with seven tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_press`, `browser_screenshot` and `browser_eval`. `docs/AGORA.md` has the table. Verified with the real CLIs on 2026-09-29:
Claude per turn (`claude -p`) and live, `codex exec`, and Codex live (`app-server`). Each navigated,
read, clicked, typed, pressed Enter and took a screenshot with no prompt, and both agents shared one page in
the same round (a shared counter ended at 10 after 5 + 5 clicks, each step credited to the right agent).
A tool works only:

- from the agent's own running turn, with its own key;
- while the room's network is on;
- while the app runs and is connected to this daemon. Otherwise the tool says the room's browser needs
  the Agoryx app, and nothing is opened.

The daemon only relays: it checks who may send a command and passes it to the app over the host link
(`GET /api/browser/host`, an event stream: `hello`, `command`, `cancel`, `close`, `replaced`). The app runs
it in the page and posts the result to `/api/browser/answer/<id>`. When an agent's turn ends, or it cancels
a call, its commands still in flight are withdrawn: the agent gets an error at once, the daemon sends
`cancel`, and the pane skips the command if it has not started it (one already running finishes). If the
daemon refuses an answer as too large or not valid, the app posts a short error instead, so the agent is
not left waiting.

**One page per room.**

- All agents of a room share its page. Commands run one at a time, in the order they arrive; rooms run in
  parallel.
- Each result starts with the page's title, URL and viewport. Its notes say what other agents and you did
  in the page since that agent's last command, which dialogs were answered, which navigations were
  blocked, refused downloads, and new console errors.
- A snapshot is an outline with refs (`e12`). A ref is never reused: after the page changes, an old one
  fails and says to take a new snapshot. It never hits another element.

**Its size.** The page is laid out 1280 CSS px wide and scaled to fit the panel (a zoom between 0.25 and
1), so a narrow panel does not switch a site to its phone layout. Coordinates and screenshots are in CSS
px, so a snapshot, a screenshot and `browser_eval` agree.

With the panel closed, the page stays hidden and still works. Electron would stop drawing a hidden view,
and input and screenshots would fail, so the app keeps drawing it
(`setBackgroundThrottling(false)`). The page still reads `document.visibilityState` as `"hidden"`. While
the window is minimized nothing is drawn: a screenshot then fails, and a snapshot still works.

**Dialogs.**

- During an agent's command, `alert` and `beforeunload` are accepted, and `confirm` and `prompt` are
  dismissed. The result says so. To test the confirm path, an agent stubs `window.confirm` with
  `browser_eval`.
- Between commands, a dialog in the panel on screen is yours. A command sent meanwhile fails at once and
  says the page is blocked. With the panel closed, the dialog is answered as during a command, and the
  next result says so.

**When things go wrong.**

- A crashed page says so in the panel. «Оновити» opens a fresh page at its last address. The next agent
  command gets a fresh, empty page, and its result says the page crashed.
- Turning the room's network off closes its page. While it is off, the panel's address bar is disabled and
  says «Мережу вимкнено»; the app also refuses the human's address there, since it asks the daemon whether
  the room's network is on before it opens a page.
- Closing the window or quitting the app closes every page; commands then fail and say the window is
  closed.

**Its data.** Each room's browser has its own session, in memory only: cookies, storage and cache belong
to that room and are gone when the app quits. Nothing of it is written to disk.

**Logs.** The app's log has `[browser]` lines for the host link, crashes and dialogs it could not answer.
The daemon's log has one line per command: the agent, the room, the tool, the outcome and the time taken.

## What the window may do

- Only two things load in the window: the start page, and the daemon's origin. A same-origin
  `window.open` gets a child window with the same settings. An agent's file or HTML preview (`/raw/…`)
  opens in the default browser, as do other `http(s)` and `mailto` links. Anything else is refused.
- A window or a link outside opens only right after a click, a tap, or Enter/Space in that page, one per
  gesture. Electron has no popup blocker, and an agent's HTML preview runs its own scripts.
- `contextIsolation` and `sandbox` are on; `nodeIntegration` and `webviewTag` are off.
- The preload has two bridges:
  - `window.agoryxDesktop`, for the start page only: `onState`, `retry`, `openAnyway`, `openLog`,
    `runDoctor`. Each IPC handler checks that the call came from that page.
  - `window.agoryxBrowser`, for the daemon's page only, never a `/raw/…` preview: `place`, `states`, `go`,
    `outside`, `onState`. Each handler checks the sender again (`trustedUi`: the main window's main frame
    on the daemon's origin), so a window the UI opens gets the object, but its calls are refused.
- Permissions are denied, except for two, on the app's own pages only:
  - clipboard write, for the UI's copy buttons;
  - fullscreen, for videos.
- The token appears only in the login URL. After that, the UI uses the daemon's cookie.
- The menu «Вигляд» (View) acts on the focused window's own page: the UI, or a window it opened. Reload,
  zoom and the developer tools never reach the room's browser, even when it has the focus, so an agent's
  coordinates do not move under it.

The room's browser has rules of its own:

- **No preload.** The page gets nothing from the app. It runs sandboxed, with context isolation, in its
  room's own in-memory session; `<webview>` is refused.
- **No permissions and no devices.** Every permission request and check is denied, and the HID, serial,
  USB and Bluetooth choosers pick nothing.
- **No certificates or sign-ins.** A client-certificate request or an HTTP sign-in gets nothing, and the
  agent's next result has a note saying so.
- **No chooser, print or download.** The file chooser is suppressed, `window.print()` does nothing, and a
  download is refused. Each leaves a note (print, in the console lines).
- **Walled off from Agoryx.** Every request from the pane carries `x-agoryx-pane: 1`, and every daemon
  of this version refuses such a request before anything else. Loopback on ports 7717–7736, and on every
  daemon port the app has seen, is blocked too; the block never lapses. `file:`, `chrome:`, `devtools:`
  and extension pages are refused. A pop-up (`window.open`) loads in the same page, under the same checks.

The app keeps two files in `~/Library/Application Support/Agoryx`:

- `window.json`, the window's bounds;
- `desktop.json`, the warnings you opened past.

## Files

| Path | What |
|------|------|
| `desktop/src/main.ts` | the main process: start sequence, supervisor events, window, menu, navigation rules |
| `desktop/src/preload.cts` | the bridges (CommonJS: sandboxed preloads cannot be ES modules): `agoryxDesktop` for the start page, `agoryxBrowser` for the daemon's UI |
| `desktop/src/attention.ts` | the tray, the Dock badge and banners for rooms that wait for you (wiring; the decisions live in the core) |
| `desktop/src/trayicon.ts` | the tray's template image, drawn in memory |
| `desktop/src/browserpane.ts` | the room's browser: one pane per room inside the window, driven by agents over the daemon's host link |
| `desktop/static/start.{html,css,js}` | the start page (strict CSP, no inline script) |
| `desktop/scripts/make-icon.mjs` | draws the icon (`build/icon.png`, `build/icon.icns`) at build time |
| `desktop/scripts/stage-core.mjs` | the core's production `node_modules` for the package |
| `desktop/electron-builder.config.cjs` | packaging |
| `internal/desktop/` | the core the app loads: `shellenv`, `doctor`, `supervisor`, `attention` (following the rooms that wait), `browserlink` and `browserpage` (the room browser's host link and page helpers), `launchd` (the login service) |
| `cmd/agoryx/service.ts` | `agoryx service install/uninstall/status` |

## What's next

- `agoryx open .` bringing up the app, through a control socket.
- `agoryx://` links.
- For the room's browser: tabs, browser data that survives a restart, a browser without the app.
- Signing for distribution and notarization, and x64 or universal builds.
