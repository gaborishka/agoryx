# macOS app — when a room waits for you (tray, Dock badge, notifications)

Status: proposed (2026-09-29), revised after review (see "Review decisions"). This is feature 2 of the
macOS app's next steps, built at the same time as feature 3 (the shared browser pane over MCP) in the
same tree.

Inspirations:
- Chat apps that stay quiet about the channel you are looking at and ping about the others (Slack, Discord):
  they use window focus, not the page's own idea of visibility.
- Agent apps that ping when a run ends and waits for the user.

Research from this session:
- Electron banners fail on an unsigned app (`UNErrorDomain error 1`): both the dev `Electron.app`
  (`Signature=adhoc`, no team) and our build (`identity: null` in `electron-builder.config.cjs`). The tray
  icon and `app.dock.setBadge` work unsigned.
- **Not shown yet:** that a build signed with Ivan's "Apple Development: Ivan Habor" identity (it is in
  his keychain) shows a banner and routes its click. The spike below settles this before any banner
  code is written.
- `document.hasFocus()` is unreliable inside Electron.

**Spike (Ivan runs it, about 5 minutes; the keychain may ask for his password):**

```sh
S=$(mktemp -d); cp -R desktop/node_modules/electron/dist/Electron.app "$S/Spike.app"
codesign --force --deep --sign "Apple Development: Ivan Habor" "$S/Spike.app"
cat > "$S/main.cjs" <<'EOF'
const { app, Notification } = require("electron");
app.whenReady().then(() => {
  const n = new Notification({ title: "Agoryx", body: "Натисніть сюди" });
  n.on("show", () => console.log("shown"));
  n.on("failed", (_e, error) => { console.log("failed", error); app.quit(); });
  n.on("click", () => { console.log("clicked"); app.quit(); });
  n.show();
});
EOF
"$S/Spike.app/Contents/MacOS/Electron" "$S/main.cjs"   # allow notifications, then click the banner
```

`shown` and then `clicked` means banners go into v1, behind decision 1. `failed` means banners are cut
from v1: the "Banners" parts below are not built, and the tray, the badge and the sidebar dot ship alone.
Record the outcome here.

**Outcome: not run yet; it is still Ivan's to run** (2026-09-29, at implementation). Banners were built
anyway, behind decision 1 and gated at runtime: nothing is shown when `Notification.isSupported()` is
false, and a banner's `failed` event (an unsigned build, or notifications turned off) is logged once and
adds the disabled note «macOS не показує сповіщення» to the tray menu. An unsigned build therefore
behaves as "banners cut": the tray, the badge and the sidebar dot. If the spike fails, the banner code
can be removed without touching the rest.

## Goal

When a room needs Ivan and he is not looking at it, Agoryx says so:
- a dot on the menu-bar icon, with a menu of the rooms that wait;
- a count on the Dock icon;
- a native notification (signed build only). Clicking it opens that room.

An unsigned build gets the tray, the badge and the sidebar dot, and no banners.

When he is looking at the room (the app's focused window, or a focused browser tab on it), nothing
fires. This works across daemon restarts and with several clients open at once.

Agoryx only observes here. Nothing is written into rooms, and no agent is told anything (no extra
behavior for agents). The seen/unseen state is the human's, and it is kept beside `daemon.json`.
Agents cannot read it through the API.

Out of scope for v1:
- Web Notifications in browser tabs, and a count in the tab title or favicon.
- A CLI command (`agoryx attention`). No CLI subcommand is added, so completions and the man page are unchanged.
- A tray on Windows or Linux.
- Pausing, per-room mute, schedules and custom sounds. For a signed app, macOS already turns banners off
  per app (System Settings → Notifications) and during Focus.
- Idle detection. A person who walked away comes back to the room on screen; only a locked screen counts
  as not looking.
- Dock bounce, a count as the tray title, and replying from a notification.
- Rooms driven by a foreground `agoryx` process are tracked only while a UI follows them (see constraints).
- Telling "meant for Ivan" from prose. Jev's `message.read` scores only the other agents, not the human.
- Signing and notarization themselves. Signing is only decision 1.

## Key constraints found in the code

- Each room is an append-only JSONL log. Every event has a per-room `seq` that stays stable across daemon
  restarts. `RoomStore.since(seq)` returns the events after a seq from memory. Messages carry `runId`.
  ⇒ **An item that needs Ivan is identified by `(room, seq)`**, and it stays the same item after a restart.
  A seen cursor per room is enough persistent state.
- The daemon keeps `rooms: Map<id, RoomHandle>`, and a handle's `listeners` set survives a takeover
  (`relay()`). Which rooms have a handle:
  - rooms active in the last 14 days, opened at start (`watchRecentRooms`);
  - rooms created, or opened by any request, since the daemon started.

  A room locked by another agoryx process gets new events only while an SSE follower is attached
  (`followTimer` → `refresh()`).
  ⇒ Attention tracks exactly the rooms that have a handle, through one listener added when the handle is
  created. A locked room that nobody follows is caught up on its next refresh (a late item), and its
  events are never lost.
- `room()` stores the handle before `tryDrive()`, which can throw (not only `RoomLockedError`); later calls
  take the `existing` branch. What `recover()` appends reaches the handle's listeners through the old
  store's `refresh()`. `relay()` calls those listeners in a plain loop, with no try/catch per listener.
  ⇒ **Track right after `this.rooms.set(id, handle);`**, idempotent, with a listener that never throws.
- `room(ref)` calls `RoomStore.resolveId`, which calls `list()` and re-reads every room log.
  ⇒ **Attention routes never call `this.room()`**. They compare the ids they were given with the tracked ids.
- Who did something:
  - `run.ended {reason: quiet|budget|stopped, turns, by?, from?}`. `turns` (`run.used`) counts every
    started turn, **passes included**.
  - The engine's `byHuman(actor)` is: no `from`, and `by` is not an agent id.
  - `stop()` records `by`: the human, an agent, or a guest (`from`).
  - If the daemon is closed by a signal (SIGINT/SIGTERM in `agoryx up`), `run.ended stopped` has **no** `by`.
  - `recover()` after a crash also appends `run.ended stopped` with no `by`, then posts the system message
    "Agoryx restarted in the middle of a run…".
  - `POST /api/down` credits the human (`{human:true}` → `by: state.human`) or the agent that asked.
- Turn errors:
  - A failed turn posts a system message "X could not finish its turn", then `turn.ended {status:
    "error", error:{kind}}`. `auth`/`spawn` bench the agent until the human's next message.
  - Every turn has a `runId`, so an error always ends up in a `run.ended`: the run goes quiet once nobody can act.
- The answer to a human's `@agent` question (`askedAlone`) is posted with `wakes:false` and does not
  mention the human. The run that carries it ends `quiet`. Jev's second look may extend the run first.
- Mentions:
  - Mentions use the ASCII handle grammar. The handles are the agent ids, `state.human.toLowerCase()` and `all`.
  - The human's name can hold non-ASCII letters (`defaultHumanName`).
  ⇒ A Cyrillic human name can never be @mentioned, so the "mention" reason does not fire for it. Run ends still do.
  - Agents can create rooms (`POST /api/rooms` accepts agent keys) and post `@<human>` in any room as guests.
  ⇒ Agents control room names and message text, and can raise items in many rooms: banners need a
  global cap and cut text.
- Auth:
  - `/api/*` needs the human token (header or the UI's HttpOnly cookie) or an agent key (header only).
    `checkToken` accepts agent keys on every route, `GET /api/rooms` included.
  - The human token is refused from agent processes (`refuseHumanTokenFromAgent`). That check runs
    `lsof` and `ps` while agent processes are alive, cached per connection (`agentBehind`).
  - Node's HTTP server keeps an idle connection for 5 s.
  - The Host header must be loopback. A non-GET request that sends an Origin must be same-origin. Node's
    `fetch` sends no Origin, and the UI's `fetch` is same-origin.
  ⇒ The app calls with the token header, the UI with its cookie, and agents get a 403. The app polls
  every second on one kept-alive connection, so the process lookup runs once per connection, not per call.
- The UI's login cookie `agoryx_token` is set for the host with `Path=/`. Cookies are not scoped by
  port, so a temp daemon's `/?t=` login in Ivan's everyday browser overwrites the cookie of his real
  daemon on :7717.
- The UI routes by hash (`#<roomId>`, `#new`). With no hash it opens the most recently updated room.
  `boot()` polls `/api/rooms` every 5 s.
  ⇒ The sidebar can show a waiting dot from a field on the summaries, without a new stream.
- Electron:
  - The main process must never import a module whose import graph reaches better-sqlite3
    (`tests/desktop/imports.test.ts`). The app loads the core from `<root>/dist/internal/desktop/index.js`
    (`AGORYX_ROOT` can point at an older build), typed by the hand-written `DesktopCore` in `desktop/src/main.ts`.
  - Main has no `uncaughtException` handler, so a throw from a timer shows Electron's error dialog. A
    daemon-origin child window can open from an agent's Markdown link, so a window URL can carry a
    malformed hash such as `#%`.
  - `BrowserWindow.getFocusedWindow()`, `isMinimized()` and `isVisible()` are reliable, and
    `powerMonitor.getSystemIdleState(s)` reports `locked` while the screen is locked.
  - The single-instance lock is per `userData`, so the dev app and a packaged Agoryx.app can both run
    against one daemon.
  - On macOS, a tray with `setContextMenu` opens the menu on click, and template images follow the menu bar's appearance.
- Feature 3 is being built at the same time in the same tree.
  ⇒ Use new modules. Each existing file gets a few hook lines, each applied as its own small edit after
  re-reading the file. The data flow is main → daemon over HTTP only: **no preload block, no IPC, no
  renderer global**. Do not touch `desktop/src/preload.cts`, `desktop/package.json` or `desktop/static/`.
  `desktop/electron-builder.config.cjs` gets one line, and only if the spike passes and Ivan says yes to decision 1.

## What needs Ivan (exact)

`attentionOf(state, event)` returns an item or null. **Only these four count:**

1. **`run.ended` with reason `quiet`, when the run posted at least one `agent` or `update` message** → `done`.
   Nobody can act any more: the room waits for Ivan by construction. A run where every turn passed
   (Ivan wrote «дякую» and all agents passed) raises nothing.
2. **`run.ended` with reason `budget`, with the same condition** → `budget`. The engine stopped spending
   turns, and something may be left on the table.
3. **`run.ended` with reason `stopped`, not by the human** → `stopped`. That is:
   - `by` is an agent id, or `from` is set (a guest from another room), or
   - there is no `by`: a crash recovery, or a daemon killed by a signal. The log cannot tell these apart,
     and in both cases the run was cut short without Ivan's decision (decision 4).

   A stop by the human (`by` present, no `from`, and `by` not an agent id) never counts. A stopped run
   counts whether or not anything was posted.
4. **`message.posted` of kind `agent` or `update`, not `native`, whose `mentions` include
   `state.human.toLowerCase()`** → `mention`. An agent (or a guest) asks Ivan by name. This includes an
   `agoryx say` update in the middle of a turn.

How the reason of a run end is refined, in order: `stopped`, then `error` if any turn of this run
(`state.turns` with that `runId`) ended with `status: "error"`, then `budget`, then `done`. So a failed
turn is reported once, when its run ends, and names the agent (decision 3). `error` counts even when
nothing was posted.

**Never counts:**
- anything the human did: his messages, `continue`, `stop`, table ops, `rename`, settings, doc edits, `agoryx say`;
- a `quiet` or `budget` run in which no agent posted an `agent` or `update` message (all passed);
- messages of kind `pass`, `system` (including Jev's and Agoryx's notes, and the "could not finish" note) and `decision`;
- `native` messages (Ivan himself talked to the agent in its own session);
- an `@all` without Ivan's handle;
- agent messages that do not mention Ivan (their run end covers them);
- `table.op` on its own. The table has no addressee: an agent that needs a decision says `@name`;
- `turn.ended` on its own (error or `interrupted`), `turn.started`, `run.started`;
- `message.read`, `commit`, `doc`, `session`, `agent`, `settings` and rename events;
- ephemeral events (`turn.stream`, `presence`).

**Item:**

```ts
type AttentionReason = "done" | "budget" | "stopped" | "error" | "mention";
interface AttentionItem {
  room: string;      // room id
  name: string;      // the room's current name (filled when read, so a rename shows)
  seq: number;       // the event that needs Ivan: stable across restarts; dedupe key (room, seq)
  ts: string;
  reason: AttentionReason;
  by?: string;       // label: who mentioned / stopped / failed (agent label, or "<agent>@<room>" for a guest)
  text: string;      // one line, whitespace collapsed, ≤160 chars with "…"
}
```

What goes into `text`:
- `mention`: the message.
- `done` and `budget`: the last `agent` or `update` message of that run (there always is one).
- `stopped`: the last `agent` or `update` message of that run, or "".
- `error`: the first line of the turn's `error.message`.

**One item per room, and precedence.** A room has at most one unseen item. A newer needing event replaces
it, except that a `done` never replaces an unseen `mention`, `stopped`, `error` or `budget`. For example,
"@ivan which one?" at 10:00 followed by the run ending at 10:05 stays one mention. A replacement updates the
tray and the badge but never raises a second banner (see Banners).

## Looking, and where seen/unseen lives

**State lives in the daemon.** Every client sees the same thing, and the state is correct across
several clients and restarts.

- `seen[room] = seq`: the highest seq Ivan has seen. It is persisted in `<agoraHome>/attention.json`:
  - format `{ "version": 1, "seen": { "<roomId>": 123 } }`, mode 0600;
  - written through a temp file and a rename;
  - saves are debounced by 1 s, with a flush on `close()`;
  - ids whose room folder is gone are pruned on load.

  Like `daemon.json`, the file can be read by any process of Ivan's user, agents' processes included. The
  403 keeps the state out of the API; it is not a confidentiality boundary.
- Items are **derived, never stored**. When a room is tracked:
  - it replays `since(seen[room])` through `attentionOf` with precedence;
  - a room without a cursor is seeded with `seen = state.seq` of the store as opened, before `tryDrive`.
    So the first start after the upgrade (and a room seen for the first time) raises nothing, while the
    `stopped` that `recover()` appends right after still counts.
- An item exists while `seen[room] < item.seq`.
- **Views**, in memory only: `{ view, room|null, looking, at }`.
  - The `view` id matches `/^[\w-]{1,64}$/`, and `room` is null or a string of up to 200 characters.
  - At most 64 views; the oldest `at` is dropped first.
  - A view counts while `now - at ≤ 45 s`; the app's views (`app-…`, reported every second) count for 10 s,
    so a crashed app stops marking rooms seen soon.
  - `watched(room)` is true when some counting view has `looking && view.room === room`.
- What marks a room seen:
  1. **Watched:** each event of a watched room advances `seen` to its seq, so no item appears.
  2. **Starting to look:** a view report that is looking at room R, when that view's previous record was
     not (fresh, looking, R), sets `seen[R] = state.seq` and clears R's item. This covers switching rooms,
     focusing the window or tab, and unlocking the screen.
  3. **Acting:** any human POST in a room (`messages`, `table`, `continue`, `stop`, `rename`, `agent`,
     `settings`, `doc`), through the UI or the CLI (`agoryx say` with the human token), sets `seen = state.seq`.
     Agents' calls never mark anything.
  4. **Explicitly:** `POST /api/attention/seen` (tray «Позначити все переглянутим»).
- What "looking" means, per client:
  - **In the app:** the main process reports its own view, `app-<randomUUID()>` made once per app run, so
    the dev app and Agoryx.app never overwrite each other. It is looking only when all of these hold:
    - `BrowserWindow.getFocusedWindow()` is an Agoryx window (the main one or a daemon-origin child) that
      is visible and not minimized;
    - the screen is not locked (`powerMonitor.getSystemIdleState(60) !== "locked"`);
    - that window's `webContents` URL is on the daemon origin and not `/raw/…`.

    The room comes from that URL's hash: decoded in a try/catch, and a malformed hash (`#%`), `new` or an
    empty hash means no room. This is the pure `lookingAt()` (Part A.4). **Only the focused window counts**,
    so a second Agoryx window on another display does not. If feature 3's pane lives inside the main
    window, looking at the pane still counts as looking at the room beside it. If the pane opens its own
    window, focusing that window counts as looking at no room.
  - **In a browser tab:** the UI reports its own view (a random id per page load). It is looking when
    `document.visibilityState === "visible" && document.hasFocus()`. A focused tab left alone counts for
    as long as it keeps reporting. The UI skips all of this when `navigator.userAgent` contains
    `Electron/`, because the app's main process reports that window.
  - Several tabs and the app are separate views, OR-ed together. `agoryx tail` in a terminal is not a view.
- **Restarts:** views are lost with the daemon. The app re-reports within 1 s. Tabs re-report within
  15 s, and until then a new event can raise an item for the room on screen, which clears on their next report.

## Part A — core

1. **`internal/agora/attention.ts`** (new). It imports only `node:*`, `./paths.js` and types.
   - `attentionFile(env)`: `<agoraHome>/attention.json`.
   - `attentionOf(state, event): Omit<AttentionItem, "room" | "name"> | null`: pure.
   - `parseView(body): AttentionView | string`: the validation, with the error text for a 400.
   - `class AttentionBoard`:
     - `constructor({ env, now?, viewTtlMs = 45_000, saveMs = 1000, log? })`;
     - `track(room, log: () => { state; since(seq) }, listeners: Set<(e: RoomEvent | EphemeralEvent) => void>)`:
       a no-op for a room already tracked. Otherwise it seeds, then adds one listener that ignores events
       without a `seq`. The listener's body is wrapped in try/catch and logs once per room, so a bug
       here never costs the room's SSE clients an event;
     - `view(v)`, `markSeen(room)`, `markAllSeen()`;
     - `item(room)`, and `items()`, newest first; `name` is read from `log().state.name` at that moment;
     - `close()`: flushes the save.

   The board never appends to a room.
2. **`internal/agora/daemon.ts`** (hooks only; re-read before each edit):
   - `import { AttentionBoard, parseView } from "./attention.js";` and a field `private readonly attention: AttentionBoard;`.
     In the constructor, after `this.log = …`: `this.attention = new AttentionBoard({ env: this.env, log: this.log });`
   - `room()`: right after `this.rooms.set(id, handle);` and before the `this.tryDrive(handle);` under it:
     `this.attention.track(id, () => handle.store, handle.listeners);`. Anchor on the `rooms.set` line;
     `this.tryDrive(handle);` alone also matches the stream follow timer.
   - `api()`, just before `if (parts[0] !== "rooms")`: `if (parts[0] === "attention") return this.attentionApi(req, res, url, parts, method, caller);`
   - `GET /api/rooms` mapping, handle branch, **for the human only**:
     `...(caller.agent ? {} : { waiting: this.attention.item(summary.id) })`. Agent keys may call this
     route (a guest from another room too), and must not learn what Ivan has or has not seen.
   - Room POSTs, right after `const actor = this.actorFor(caller, engine.state);`: `if (!caller.agent) this.attention.markSeen(handle.store.id);`
   - `close()`, after the engines have closed and before `this.rooms.clear()`: `this.attention.close();`
   - A new private method `attentionApi()`, placed right after `stream()`. It is described next.
3. **Daemon API.** These routes are human only. With an agent key they answer 403 "attention is the
   human's". A bad payload gets 400, a wrong method 405, and an unknown path 404. There is no stream.
   - `GET /api/attention` → `{ rooms: AttentionItem[] }`.
   - `POST /api/attention/view` with `{ view, room: string|null, looking: boolean }` → `{ rooms }`, computed
     after the view is applied, so it never lists a room the caller just started looking at. `room` is
     compared as given; an id that is not tracked is harmless and expires with the view.
   - `POST /api/attention/seen` with `{ room }` or `{ all: true }` → `{ rooms }`. An unknown room is a no-op.
   - `GET /api/rooms` summaries gain `waiting?: AttentionItem`, for the human only.
4. **`internal/desktop/attention.ts`** (new, dependency-free: `node:events`, `node:crypto`, global `fetch`,
   and a type-only import of `AttentionItem`). Exported from `internal/desktop/index.ts` (one line).
   Everything the app decides lives here, so it is unit-tested; `desktop/src/attention.ts` stays wiring.
   - Pure helpers:
     - `lookingAt({ window: { url, visible, minimized } | null, locked, daemonOrigin }) → { room, looking }`,
       with the safe hash decode above.
     - `roomsWord(n)`: «1 кімната чекає на вас», «3 кімнати чекають на вас», «5 кімнат чекають на вас»,
       with the Ukrainian plural (11 → кімнат, 21 → кімната, 22 → кімнати).
     - `trayLabel(item)`: `«<назва> — <коротко>»`, the name cut at 40 characters. The short reasons:
       - `done`: «агенти закінчили»
       - `budget`: «ліміт ходів вичерпано»
       - `stopped`: «зупинено»
       - `mention`: «<by> кличе вас»
       - `error`: «хід <by> не вдався»
     - `bannerFor(items) → { title, subtitle?, body, room }`. One item: the title is the room name cut at
       60 characters, and the body is `text`. The subtitle:
       - `done`: «Агенти закінчили — чекають на вас»
       - `budget`: «Ліміт ходів вичерпано — чекають на вас»
       - `stopped` with `by`: «<by> зупиняє розмову»; without `by`: «Розмову перервано»
       - `mention`: «<by> звертається до вас»
       - `error`: «<by>: хід не вдалося завершити»

       Several items: the title is `roomsWord(n)` with a capital letter, and the body lists the names,
       cut to 160 characters. `room` is the newest item's room, which a click opens.
     - `nextBannerAt(firstPendingAt, lastBannerAt)`: `max(firstPendingAt + 2500, lastBannerAt + 10_000)`.
       The settle and the global cap in one place.
   - `class AttentionFollower extends EventEmitter`:
     - `constructor({ fetch?, now?, log? })`; the view id is `app-${randomUUID()}`;
     - `setDaemon(info: { url; token } | null)`: switches the URL and the token. The same url and token is
       a no-op. `null` stops calling, sets `connected` to false, and keeps the last items;
     - `report({ room, looking })`: `POST /api/attention/view` with the token header and a 3 s timeout.
       Skipped while a call is in flight: the next tick sends. The answer's `rooms` is the new snapshot;
     - `markSeen(room?)`: `{room}`, or `{all:true}` when no room is given; the answer is a snapshot too;
     - `items()` and `connected()`: the last call succeeded;
     - `dispose()`.

     Events:
     - `"state"` `(items, connected)`: when any field of any item (the name included) or the connection
       changes. So a rename reaches the tray.
     - `"arrived"` `(item)`: a room that waits now and did not wait in the previous snapshot. The first
       snapshot of the follower's life only seeds: what already waited when the app opened gets the badge
       and the tray, but no banner. A replacement (a mention followed by `stopped`) does not arrive again.
       A daemon restart keeps the previous snapshot, so it replays nothing.

     A non-2xx answer (a 404 from an older daemon) counts as not connected and is logged once per status.

## Part B — the app, `desktop/`

- **`desktop/src/attention.ts`** (new, Electron wiring only):

  `createAttention({ core, window, focusWindow, isDaemonUrl, daemonOrigin, log })` returns
  `{ setDaemon(info|null), dispose() }`. It runs on `darwin` only and creates the follower lazily on the
  first `setDaemon(info)`, from `core()`. It also exports `interface AttentionCore { AttentionFollower?: new (…) => … }`.
  - **Never throws into main.** `setDaemon` and `dispose` catch and log. If `core()?.AttentionFollower`
    is not a function (`AGORYX_ROOT` points at a core built before this feature), attention logs once and
    stays off. Every timer and event callback catches too.
  - **Looking reporter:** a 1 s timer, plus the window events `focus`, `blur`, `show`, `hide`, `minimize`,
    `restore` and `did-navigate-in-page`. Each calls `follower.report(lookingAt(...))`. The timer is also
    the poll that keeps the tray and badge current while the app is in the background.
  - **Tray:**
    - `new Tray(trayImage(false))`; the image becomes `trayImage(true)` while any item waits.
    - Tooltip: «Agoryx», or «Agoryx — » + `roomsWord(n)`.
    - `setContextMenu`, rebuilt on every `"state"`:
      - one item per waiting room, `trayLabel(item)`, which opens that room. Up to 10, then a disabled
        «…і ще N»;
      - «Позначити все переглянутим» (disabled at 0);
      - separator;
      - «Відкрити Agoryx» (`focusWindow`);
      - disabled notes, when they apply:
        - «Agoryx не відповідає» when not connected;
        - «macOS не показує сповіщення» after a banner `failed` (notifications off in System Settings, or
          an unsigned build). This is logged once;
      - separator;
      - «Вийти з Agoryx» (`app.quit()`; the daemon keeps running, as with the app menu's Quit).
  - **Dock badge:** `app.dock?.setBadge(n ? String(n) : "")`, where `n` is the number of rooms waiting.
    It updates on every `"state"`, focused or not, because the room on screen is never in the list. Each
    change is logged as `[attention] badge N`, for tests.
  - **Banners** (only if the spike passed), on `"arrived"`:
    - Skip when `!Notification.isSupported()`.
    - Add the room to one pending set, and arm one timer for `nextBannerAt(...)`: at least 2.5 s after the
      first pending arrival (settle), and at least 10 s after the last banner of any room (global cap).
    - When the timer fires, keep the pending rooms that still wait and that the app is not looking at now.
      None: nothing. Otherwise show one `new Notification(bannerFor(kept))`, and clear the pending set.
      Twenty rooms arriving within a second give one banner «20 кімнат чекають на вас».
    - A room banners once per waiting spell: only nothing → waiting arrives. Later replacements change
      the tray and the badge silently until Ivan looks.
    - On `"state"`, a live banner is closed when none of its rooms still waits.
    - The sound is the system default.
    - Logs: `[attention] arrived <room> <reason> seq=N`, then `banner <room…>` or `banner failed: …`.

    Banners for other rooms still show while the app is focused (decision 2).
  - **Opening a room** (tray item or banner click):
    1. If the window's URL is on the daemon origin and it is not loading, set `location.hash` to the
       JSON-encoded `#<encodeURIComponent(room)>` with `webContents.executeJavaScript(...)` first, then
       `focusWindow()` once the in-page navigation is done (at most 500 ms). The UI's `hashchange` routes,
       with no reload, and the room that was on screen is not marked seen by the focus.
    2. Otherwise `focusWindow()` first. If it is loading (a window just re-created), set the hash once on
       `did-finish-load`.
    3. If it is on the start page (doctor, warnings, daemon down), only focus it; the item stays in the tray.

    A banner clicked after the app was relaunched only activates the app; Electron does not route clicks
    on notifications from an earlier run.
- **`desktop/src/trayicon.ts`** (new): `trayImage(dot)` draws the favicon's three-dot mark at 18 pt
  (36×36 px, black with alpha).
  - It encodes a PNG in memory with `node:zlib`'s `deflateSync`, like `scripts/make-icon.mjs`, then calls
    `nativeImage.createFromBuffer(png, { scaleFactor: 2 })` and `setTemplateImage(true)`.
  - The dot variant shrinks the mark a little and adds a solid badge circle at the top right, with a
    transparent 1-unit ring around it.
  - There are no files, build step or packaging change. If the in-memory template misrenders in E2E, fall
    back to writing `dist/tray{,-dot}Template@2x.png` from `npm run build`, which does touch `desktop/package.json`.
- **`desktop/src/main.ts`** (hooks only; re-read before each edit):
  - `import { createAttention, type AttentionCore } from "./attention.js";`
  - `interface DesktopCore extends AttentionCore {`: a one-token edit.
  - `let attention: ReturnType<typeof createAttention> | null = null;`
  - `showDaemon`, right after `view = "daemon";` (before the early return for a closed window, so the tray
    follows with no window open): `attention?.setDaemon(info);`. It never throws, so it cannot stop the
    `loadURL` below it. `render()` calls `showDaemon` again with the same info, which is a no-op.
  - `onDown` and `onFailed`, after `daemon = null;`: `attention?.setDaemon(null);`
  - `ready()`, after `createWindow();`: `attention = createAttention({ core: () => core, window: () => win, focusWindow, isDaemonUrl, daemonOrigin, log: (m) => console.log(`[attention] ${m}`) });`
  - `before-quit`: `attention?.dispose();`
- **How the app follows the daemon:**
  - One poll for all rooms: the 1 s view report, whose answer is the list. The view and the snapshot come
    in one request, so there is no ordering problem on reconnect.
  - Supervisor `up` and `changed` (restarted from a terminal, or a new token) → `showDaemon` →
    `setDaemon(info)`: the next tick calls the new URL with the new token. Only rooms that were not
    waiting before arrive. For example, a crash mid-run makes `recover()` add `stopped`, which gives one banner.
  - `down` and `failed` → `setDaemon(null)`: the tray note, and the last items and badge are kept until a
    daemon says otherwise.
  - A busy daemon that does not answer in 3 s → not connected until a call succeeds.

## Part C — the web UI, `ui/`

- **`ui/src/lib/attention.ts`** (new): `startAttention(currentRoom: () => string | null, subscribe: (fn) => () => void)`.
  - It returns at once under Electron.
  - Its view id is `crypto.randomUUID()`.
  - It sends `{ view, room, looking }` on route or room change, and on `visibilitychange`, `focus` and `blur`.
  - It sends again every 15 s while looking.
  - On `pagehide` it sends `looking:false` with `keepalive`.
  - It uses a plain same-origin `fetch`, not `api()`: a failed heartbeat must never show an error or the
    login gate.
- **`ui/src/lib/store.ts`**, in `boot()` after the listeners (1 line):
  `startAttention(() => { const s = useStore.getState(); return s.route.kind === "room" ? (s.snap?.state.id ?? s.route.id) : null; }, (fn) => useStore.subscribe(fn));`
  Passing these callbacks avoids an import cycle.
- **`ui/src/lib/types.ts`**: `AttentionItem`, and `waiting?: AttentionItem` on `RoomSummary`.
- **`ui/src/components/Sidebar.tsx`**, `RoomRow`: when `room.waiting` is set and the row is not `on`,
  show a `size-2 rounded-full bg-amber` dot in the slot of the running dot, instead of the time or the
  breathing dot. A mention is mid-run by nature, so a running room shows it too. Its `Tip` gives the short
  reason, for example «Чекає на вас: агенти закінчили», plus « · агенти працюють» while running. The `on`
  row (the room on screen) never shows it, even before the next 5 s poll.

## Tests (node:test with tsx, `npm test`; every daemon runs on a temp `AGORYX_HOME` with `port: 0`)

1. **`tests/agora/attention.test.ts`** (pure and board, injected `now`):
   - `attentionOf`:
     - each of the four counting events;
     - each "never" case: the human's message and stop, `pass`, `system`, `decision`, `native`, `@all`
       alone, an agent message without a mention, `table.op`, `turn.ended` error or interrupted, a quiet
       run in which every turn passed, a budget run with no agent message;
     - a guest stop counts, and a stop with no `by` counts even with nothing posted;
     - the reason order `stopped` > `error` > `budget` > `done`;
     - `text` clipped to one line of 160 characters.
   - Precedence: a `done` after an unseen mention keeps the mention; a newer mention replaces it.
   - Seeding:
     - no cursor → `seen = seq` and no items;
     - with a cursor → the items are derived again with the same `seq`;
     - a room whose folder is gone is pruned;
     - `track` twice for one room adds one listener.
   - Views:
     - the watched room advances `seen` and raises no item;
     - starting to look clears the item;
     - after 45 s the view no longer counts;
     - the 64-view cap;
     - `parseView` rejects bad ids, rooms and `looking` values.
   - `attention.json` round trip: debounced save, flush on close, mode 0600.
2. **`tests/agora/daemon-attention.test.ts`** (real `AgoraDaemon`, fake bins with `FAKE_RULES`, helpers as
   in `daemon.test.ts`):
   - a fake reply «@ivan which one?» → `GET /api/attention` shows a `mention`;
   - the run ends → the item stays the mention; after marking seen, the next run raises `done`;
   - a run in which every agent passes raises nothing;
   - `POST /api/attention/view` looking at the room answers without it, and during a new run no item
     appears; after `looking:false`, the next run raises one;
   - a human `POST …/messages` marks the room seen;
   - an agent-key `POST …/stop` → `stopped` with `by`; the human's stop → none;
   - an error rule («Not logged in · Please run /login») → the run end has reason `error` with `by`;
   - `GET /api/rooms` carries `waiting` with the human token, and never with an agent key (own room or guest);
   - an agent key on each attention route → 403, and bad bodies → 400;
   - restart: close the daemon, start a new one on the same home → the same items, with the same `seq`;
     an item cleared before the restart stays cleared.
3. **`tests/desktop/attention.test.ts`**:
   - Pure helpers:
     - `lookingAt`: focused main window on a room; a child window; minimized; hidden; locked; the start
       page; `/raw/…`; `#new`; an empty hash; the malformed hashes `#%` and `#%E0%A4%A` give no room and
       do not throw;
     - `roomsWord` for 1, 2, 5, 11, 21 and 22;
     - `trayLabel` for each reason, and the 40-character cut;
     - `bannerFor`: each subtitle, the 60-character title cut, and several items;
     - `nextBannerAt`: 20 arrivals within 1 s → one banner time; a second arrival 3 s after a banner
       waits until 10 s.
   - `AttentionFollower` against a real daemon:
     - an item present at the first call → `"state"` with no `"arrived"`; a new item → `"arrived"` once;
       a replacement for the same room (mention, then an agent stop) → no second `"arrived"`;
     - a rename → `"state"` with the new name;
     - restart the daemon on the same home on a new port and `setDaemon(newInfo)` → no repeated arrival;
       a new item after the restart arrives;
     - `report()` reaches the daemon (the watched room raises nothing);
     - two followers have different view ids;
     - `setDaemon(null)` → `connected` is false and the items are kept;
     - a stub HTTP server that answers 404 → logged once, not connected, no crash.
4. **`tests/desktop/imports.test.ts`**: unchanged. It already walks every file in `internal/desktop/`, so
   the new module is covered. Also run it with the built `dist/`.
5. Type checks: `npm run typecheck`, `npm --prefix ui run typecheck`, `npm --prefix desktop run build`.

**E2E with the dev app.** A temp home only. Never `~/.local/state/agoryx`, never stop or signal pid 17815
or anything on port 7717, and never use Ivan's everyday browser profile. **Every CLI call is written
`AGORYX_HOME=$H/agora node bin/agoryx.js …`**: a bare `agoryx` reaches the real daemon, or runs the room
in-process under the real home.

1. Setup:
   - `H=$(mktemp -d)`;
   - build the core, the UI and `desktop/`;
   - write fake bins with a shell wrapper to `tests/agora/fixtures/fake-agent.mjs` for claude and codex,
     and a `rules.json` in which Claude answers the message «котрий?» with «@ivan which one?», and a
     `sleepMs: 20000` rule for the message «довго».
2. Launch:
   - `AGORYX_HOME=$H/agora AGORYX_HUMAN=ivan AGORYX_CLAUDE_BIN=… AGORYX_CODEX_BIN=… FAKE_RULES=$H/rules.json desktop/node_modules/.bin/electron desktop --user-data-dir=$H/userdata`.
   - The separate `userData` keeps its single-instance lock and prefs apart from any Agoryx.app Ivan has
     open. `LAUNCH_WINS` and the merge keep these variables.
   - The supervisor starts a daemon on the next free port after 7717. Read the port from `$H/agora/daemon.json`.
3. Create rooms A and B with `AGORYX_HOME=$H/agora node bin/agoryx.js new …`. Open A in the app, then take
   focus away from it (`osascript -e 'tell application "Finder" to activate'`). Post «котрий?» to B with
   `AGORYX_HOME=$H/agora node bin/agoryx.js say -r B`. The human's own message marks B seen; Claude's
   «@ivan which one?» reply is the item → the log shows `arrived B mention` and `badge 1`, then (if banners
   are built) `banner B` signed or `banner failed` unsigned. The tray shows the dot and lists B.
4. Choose B in the tray → the window opens on B → `badge 0` within about 1 s, and the dot disappears.
5. With the app focused on B, post to B from the agent's shell (a Bash call does not move focus; typing
   in Terminal would) → no `arrived`.
6. Browser tab, in a throwaway Chrome profile (the `/?t=` login sets a cookie that is not scoped by port):
   `open -na "Google Chrome" --args --user-data-dir=$H/chrome --no-first-run "<url from $H/agora/daemon.json>/?t=<token>#<id of A>"`.
   With the app unfocused and the tab focused on A, a run in A raises nothing. Switch the tab to B → the
   next run in A raises an item. Quit that Chrome instance.
7. Restart. Keep Finder focused throughout: after `up`, the reloaded window opens the most recently
   updated room, and a focused app would count as looking at it.
   - Start a «довго» run in B, then `kill -9` the temp daemon's pid read from `$H/agora/daemon.json`
     (never 17815);
   - supervisor `down`, then `up` → exactly one new `arrived B stopped` (and one `banner` line), and no
     repeats for older items.
   - `AGORYX_HOME=$H/agora node bin/agoryx.js down` during a run → no item.
8. Tear down: quit the app, `AGORYX_HOME=$H/agora node bin/agoryx.js down`, `rm -rf $H`.
9. Signed check (**required** if the spike passed and decision 1 is yes; Ivan runs the signing):
   - `AGORYX_SIGN_IDENTITY="Apple Development: Ivan Habor" npm --prefix desktop run dist`;
   - run `release/mac-arm64/Agoryx.app/Contents/MacOS/Agoryx` with the same env and `--user-data-dir`;
   - allow notifications, repeat steps 3 and 7, and click the banner → that room opens.
10. Manual, by Ivan only: lock the screen (⌃⌘Q) during a «довго» run in the room on screen → the item
    arrives; unlock → it clears. An agent never locks his screen: `lookingAt` with `locked` is unit-tested.

## Docs

- `docs/DESKTOP.md`:
  - a new section "When a room waits for you", covering:
    - the four events and what never counts;
    - what "looking" means in the app and in a tab;
    - the tray menu, the badge, banners with their cap, and that an unsigned build gets no banners
      (the tray, badge and sidebar dot only);
  - security notes: attention is the human's (403 for agents, no `waiting` for agent keys);
    `attention.json`, like `daemon.json`, is readable by any process of the user; and the app follows
    whichever daemon `daemon.json` names (a same-user process could stand in for it; see Review decisions);
  - Files table rows for `desktop/src/attention.ts`, `desktop/src/trayicon.ts` and `internal/desktop/attention.ts`;
  - remove "Notifications, a menu-bar icon, a Dock badge" from "What's next".
- `CHANGELOG.md`, Unreleased → Added: the tray, badge and notifications, the sidebar dot, and
  `/api/attention`. Say that banners need a signed build.
- `docs/AGORA.md`:
  - the security list: the attention routes are the human's, agents get a 403, and `GET /api/rooms`
    carries `waiting` for the human only;
  - `<agoraHome>/attention.json` among the state files;
  - a module-table row for `internal/agora/attention.ts`;
  - `internal/desktop/` gains the follower;
  - the sidebar's waiting dot.
- No CLI subcommand, so completions and the man page are unchanged.

## Open decisions for Ivan (defaults in bold)

1. **Sign local builds so banners work.** Unsigned, only the tray, badge and sidebar dot work.
   **Yes, opt-in, if the spike passes:** `electron-builder.config.cjs` gets
   `identity: process.env.AGORYX_SIGN_IDENTITY || null`, and Ivan's "Apple Development: Ivan Habor"
   identity stays in his keychain. Without the variable the build stays unsigned, as today. If the spike
   fails, banners are cut from v1.
2. Banners for other rooms while the Agoryx window is focused: **yes**. Only the room on screen stays
   silent; the alternative is no banners at all while the app is focused.
3. Turn errors: **one banner at the run end, as reason `error`**. The alternative is also an immediate
   banner for `auth`/`spawn`, which bench the agent while the others go on.
4. A run cut short with no `by` (a crash, or Ctrl-C on `agoryx up`): **counts**, as «Розмову перервано».
   The log cannot tell the two apart, and a stop through the app or `agoryx down` is credited to Ivan and
   never counts.

## Review decisions

Every finding of the three reviews was checked against the code, and all were real. They are fixed in the
text above, except these two, which are handled only in part:

- Spoofed daemon (a same-user process writes `daemon.json` and answers `/api/health` with that pid):
  documented, not fixed here. It is pre-existing in PR #9's supervisor, and such a process can already read
  the real token and post notifications itself; what feature 2 adds is only which room Ivan looks at. A
  listener pid check (`lsof -iTCP:<port> -sTCP:LISTEN -Fp`) belongs in the supervisor, as a follow-up.
- Preload contradiction with feature 3: this spec was already right (no preload block, no IPC). The fix
  belongs in the browser-pane spec: drop "Feature 2 adds its own block with its own global", the
  `preload.cts` entry in its coordination list, and "Feature 2's own event stream" (there is no stream now).

Noticed, out of scope: `ui/src/lib/store.ts` `routeFromHash()` has the same unguarded
`decodeURIComponent`, so a `#%` link breaks the page (pre-existing; a one-line follow-up).
