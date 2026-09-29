# Features 2 and 3 in parallel: the split

Date: 2026-09-29. Status: plan.

Two engineers build two desktop features at the same time, in this one working tree:

- **Attention** (feature 2): the tray, the Dock badge and banners. Spec:
  `docs/plans/2026-09-29-desktop-attention.md`.
- **Browser** (feature 3): the room's shared browser pane over MCP. Spec:
  `docs/plans/2026-09-29-desktop-browser-pane.md`.

One person, **the lead**, applies the scaffold (section 2) before either engineer starts. The lead can be
one of the two engineers. After the scaffold, each engineer edits only the files they own (section 3).
The frozen files change only through the lead. Ivan settles any disagreement.

**Status: checked on a scratch copy of this tree, with the scaffold applied.**

- These pass:
  - `npm run typecheck`;
  - the desktop typecheck;
  - the UI typecheck;
  - the full `npm test`: 901 tests, one of them skipped without `dist/`.
- An in-process daemon (temp home, `port: 0`) answered the new routes exactly as the stubs promise (step
  2.5).

**Working in one tree.**

- **Before each edit to a shared doc, re-read the file**, then make an exact-string edit. Never rewrite a
  whole file from an older copy: no Write, no editor buffer opened long ago, no `sed -i` over a stale read.
- **A failing test in the other feature's files belongs to its owner.** Tell them; do not fix it yourself.
- **Commit or push only if Ivan asks.**
- **Experiments use a temp `AGORYX_HOME` and a free port.**
- **Never touch Ivan's daemon** (127.0.0.1:7717, pid 17815) or `~/.local/state/agoryx`.

## 1. Where the two specs meet, and how each is settled

The two specs meet in twenty places. Each item below says what the specs say, how it is settled, and who
yields.

1. **Route prefixes** (`internal/agora/daemon.ts`, `api()`).
   - **Specs:**
     - attention: `/api/attention`, plus `/view` and `/seen`;
     - browser: `/api/browser`, plus `/host` and `/answer/<id>`.
   - **Settled:**
     - The prefixes are distinct.
     - Both dispatch lines sit just above the `rooms` 404, with one signature:
       `(req, res, parts.slice(1), method, caller)`.
     - The scaffold writes both handler methods in full. The logic they call lives in each feature's own
       module.
   - **Yields:** attention. Its `attentionApi(req, res, url, parts, …)` drops the unused `url`, and it
     gets the path parts without the prefix.

2. **Daemon hooks** (`daemon.ts`: imports, fields, constructor, `close()`, `room()`, `onRoomEvent`,
   `handle()`, `GET /api/rooms`, room POSTs).
   - **Specs:** both specs hook into these places.
   - **Settled:**
     - The scaffold writes every hook, then `daemon.ts` is frozen.
     - `close()` order:
       - `browser.close()` goes right after the `sseClients` teardown; the host stream is not in
         `sseClients`, and it would hold `server.close()` open.
       - `attention.close()` goes after the engines close and before `rooms.clear()`.
     - **Shared helper:** `readBody(req, limit = MAX_BODY)`, the browser's limit parameter. Attention uses
       the default.
   - **Yields:** browser.
     - Its A2 says `closeRoom(handle.id)`. `RoomHandle` has no `id`, so the glue uses `handle.store.id`.
     - Its field initializer becomes a constructor assignment, next to attention's. The behavior is the
       same.

3. **Who may call** (both route families).
   - **Specs:**
     - **Attention is the human's.**
       - Agents get 403 "attention is the human's".
       - `waiting` on `GET /api/rooms` is for the human only.
     - **Browser commands come from agents.**
       - `POST /api/browser` takes an agent key only, from that agent's own turn processes.
       - `host` and `answer` take the human only.
   - **Settled:**
     - **Both as specified.**
     - **The first line of `handle()` refuses `x-agoryx-pane`.** Pane pages therefore cannot reach
       `/api/attention` either.
     - **Neither feature's app requests carry that header.**
     - **The browser's answers never mark a room seen.** They are not under `/api/rooms/…`.
   - **Yields:** none.

4. **Window layout: is Ivan looking?**
   - **Specs:**
     - **Browser:** the pane is a `WebContentsView` inside the main window.
     - **Attention:** Ivan is looking when all of these hold:
       - `BrowserWindow.getFocusedWindow()` is an Agoryx window, visible and not minimized;
       - the screen is unlocked;
       - that window's own `webContents` URL is on the daemon and not `/raw/`.
   - **Settled:**
     - **Focus in the pane counts as looking at the room beside it.** With focus there,
       `getFocusedWindow()` is still the main window.
     - **What attention reads:**
       - it reads `window.webContents.getURL()`;
       - it never reads `webContents.getFocusedWebContents()` or a pane's URL;
       - it never uses the UI's `document.hasFocus()` in the app, which is false while Ivan types in the
         pane. `startAttention` returns at once under Electron.
   - **Yields:** attention, as a rule to follow. Its design does not change.

5. **Opening a room from the tray or a banner.**
   - **Specs:**
     - attention: `focusWindow()`, then `executeJavaScript` sets `location.hash`;
     - browser: `attachWindow` hides every pane when the UI's main frame starts a new document, and the UI
       places the pane.
   - **Settled:**
     - The hash change is a same-document navigation, so the panes are not reset.
     - The UI moves to the new room and sends `place(newRoom, rect)`.
     - Attention runs its script on `win.webContents` only, never on the focused contents, which could be a
       pane.
   - **Yields:** none.

6. **Window closed or re-created.**
   - **Specs:** the tray and badge live without a window; the panes belong to the window.
   - **Settled:**
     - `createWindow` calls `panes.attachWindow(next)` before `render(next)`.
     - Closing the window closes the panes. A driver then gets the window-closed error.
     - The tray keeps working. A tray open re-creates the window, and attention's `did-finish-load` step
       routes it.
   - **Yields:** none.

7. **Preload** (`desktop/src/preload.cts`).
   - **Specs:** browser adds an `agoryxBrowser` block for the daemon page. Attention has no preload, no IPC
     and no renderer global.
   - **Settled:** browser owns `preload.cts`. The scaffold does not touch it.
   - **Yields:** browser. It deletes three stale lines in its own spec:
     - C3: "Feature 2 adds its own block with its own global";
     - the Coordination bullet on `preload.cts` blocks;
     - the Coordination line on "Feature 2's own event stream".

8. **IPC.**
   - **Specs:** browser uses `agoryx:browser:*`, each handler checked by `trustedUi`. Attention has none.
   - **Settled:** `trustedUi` lives in `main.ts` (scaffold). The handlers live in `browserpane.ts` and are
     registered by `panes.listen()`.
   - **Yields:** none.

9. **App menu** (`buildMenu()`).
   - **Specs:** browser turns the «Вигляд» roles into click items that act on the UI, not the pane.
     Attention has only its own tray menu and no app-menu change.
   - **Settled:**
     - The scaffold writes the «Вигляд» items through one helper, `onPage()`. It acts on the focused
       `BrowserWindow`'s own page, else the main window.
     - So ⌘R and ⌘+ with the pane focused act on the UI.
     - A daemon child window still reloads and zooms itself. The spec said `win.webContents`; this keeps
       today's behavior for child windows.
   - **Yields:** browser, a small deviation.

10. **What the app keeps open to the daemon.**
    - **Specs:**
      - **Attention:** no stream. Main runs a 1 s `POST /api/attention/view` poll with global `fetch`,
        and the answer is the list of rooms.
      - **Browser:** one SSE `GET /api/browser/host` over `node:http`.
    - **Settled:**
      - **The two are independent.**
        - Both carry the human token from main.
        - Neither sends `x-agoryx-pane`.
        - Neither is in `sseClients`.
      - **Both keep their connection alive** (fetch's default keep-alive; never `connection: close`).
        While agents live, the daemon runs `lsof` once per new connection.
      - **Both follow `showDaemon`.** `attention.setDaemon(info)` and `panes.connect(info)` go after
        `view = "daemon"`, before the closed-window return.
        - Both are no-ops for the same info, because `render()` calls `showDaemon` again.
        - Neither throws.
      - **When the daemon goes down:**
        - `onDown` and `onFailed` call `attention.setDaemon(null)`;
        - the browser link notices the end of its stream and retries by itself.
    - **Yields:** none.

11. **Shared types** (`internal/agora/types.ts`).
    - **Specs:** browser adds `"browser"` to `ActivityKind`. Attention adds `AttentionReason` and
      `AttentionItem`.
    - **Settled:**
      - **The three `"browser"` edits land in one step.** `"browser"` breaks the UI typecheck unless both
        exhaustive `ICON` records get a `browser` entry. They are in `Trace.tsx` and `SessionPanel.tsx`.
        The scaffold does all three.
      - **`AttentionItem` goes into `types.ts`, not `attention.ts`.**
        - The UI gets it through `export type * from "@agora/types"`, without pulling `node:path` into
          the UI program.
        - `internal/desktop/attention.ts` imports it type-only from `../agora/types.js`.
      - **`types.ts` is then frozen.**
    - **Yields:** attention. Its item type lives in `types.ts`, and `ui/src/lib/types.ts` only adds
      `waiting?: AttentionItem` to `RoomSummary`.

12. **UI store** (`ui/src/lib/store.ts`).
    - **Specs:** browser adds `"browser"` to `PanelTab`; attention adds the `startAttention(...)` call in
      `boot()`.
    - **Settled:** the scaffold writes both, then `store.ts` is frozen.
    - **Yields:** none.

13. **How the app loads the desktop core** (`desktop/src/main.ts`, `internal/desktop/index.ts`).
    - **Specs:**
      - attention: `DesktopCore extends AttentionCore`, and one export line in `index.ts`;
      - browser: the pane loads `browserlink` and `browserpage` from `<root>/dist/internal/desktop/` by
        itself.
    - **Settled:** the scaffold writes `DesktopCore extends AttentionCore`. `index.ts` belongs to
      attention.
    - **Yields:** none.

14. **`web-contents-created`** (`main.ts`).
    - **Specs:** browser: pane contents skip `guard()`.
    - **Settled:**
      - The scaffold writes `if (!panes.owns(contents)) guard(contents);`.
      - **For the browser engineer:** this event fires while `new WebContentsView()` runs, before the
        constructor returns. So `owns()` must recognize a pane by something known in advance, such as its
        session or partition. A set filled after construction is too late.
    - **Yields:** none.

15. **Notifications.**
    - **Specs:** attention's banners use main's `Notification`. Browser denies `notifications` to pane
      pages.
    - **Settled:**
      - Browser activity is a trace, not a message, so it never raises attention.
      - Only the events in attention's `attentionOf` raise it.
    - **Yields:** none.

16. **Tests and shared fixtures.**
    - **Specs:** both use `tests/agora/helpers.ts` and `tests/agora/fixtures/fake-agent.mjs`, unchanged.
    - **Settled:**
      - **The browser's CLI flags do not break attention's daemon tests.**
        - The flags (`--mcp-config`, the `-c` pairs) are added only when the room has a shim, and
          `helpers.ts` sets one.
        - The fake agent ignores unknown flags.
      - **The runner unit tests keep their expected argv.** They have no shim.
      - **The fake agent's `run` rule already exists**, so neither feature changes the fixture.
      - **Every new timer is cleared by its `close()` or is `unref`'d.** Otherwise every daemon test,
        including the other feature's, hangs at exit. The new timers are:
        - attention's save and view expiry;
        - the relay's timeouts and pings;
        - the link's retry.
      - **New test files go directly under `tests/agora/` or `tests/desktop/`.** `npm test`'s glob runs
        under `sh`, where `**` matches one level.
    - **Yields:** none.

17. **CLI** (`cmd/agoryx/main.ts`).
    - **Specs:** neither feature adds a human subcommand. `mcp` exists only in the agents' shim,
      `bin/agoryx-agent.mjs`.
    - **Settled:** no change. The completions and the man page stay as they are.
    - **Yields:** none.

18. **Packaging** (`package.json`, `desktop/package.json`, `desktop/electron-builder.config.cjs`).
    - **Specs:**
      - Browser ships `bin/agoryx-mcp.mjs`.
      - Attention has an `identity` line, after the signing spike and Ivan's yes.
      - Attention's tray PNG fallback would touch `desktop/package.json`.
    - **Settled:**
      - `extraResources` already ships `dist`, `bin`, `ui/dist` and `package.json`, so no change is needed.
      - The `identity` line waits for Ivan.
      - The PNG fallback needs the lead's yes first.
    - **Yields:** none.

19. **Imports test** (`tests/desktop/imports.test.ts`).
    - **Specs:** both leave it unchanged.
    - **Settled:**
      - The walk covers new `internal/desktop/*.ts` files by itself.
      - It stays green as long as `internal/agora/browsertools.ts` stays dependency-free, meaning relative
        `.ts` files and `node:*` only.
      - `internal/desktop/attention.ts` must import `AttentionItem` type-only.
    - **Yields:** none.

20. **Docs** (`CHANGELOG.md`, `docs/DESKTOP.md`, `docs/AGORA.md`).
    - **Specs:** both add text at the same few places.
    - **Settled:**
      - Placeholders mark the spots where both insert, and the scaffold writes the shared table rows (step
        2.4).
      - Everything else in the docs is a line that only one feature touches.
    - **Yields:** none.

## 2. The scaffold (the lead, first, in one sitting)

### 2.1 Before

- `git status --short` shows only the plan files under `docs/plans/`.
- `npm run typecheck` passes.

### 2.2 Five stub modules (new files)

Each stub carries "SCAFFOLD STUB" in its doc comment, and the merge check greps for it. Each engineer
replaces their stubs with the real modules and **keeps these exported signatures**: the frozen files call
them. Changing a signature is a request to the lead.

**`internal/agora/attention.ts`** (attention replaces it)

```ts
import { join } from "node:path";
import { agoraHome } from "./paths.js";
import type { AttentionItem, EphemeralEvent, RoomEvent, RoomState } from "./types.js";

/**
 * Which rooms wait for the human, and which room the human looks at (docs/plans/2026-09-29-desktop-attention.md).
 * SCAFFOLD STUB: the signatures the daemon uses. It tracks nothing, so no room ever waits.
 */

/** Where one client (the app, or a browser tab) looks; in memory only. */
export interface AttentionView {
  view: string;
  room: string | null;
  looking: boolean;
}

/** What the board reads from a room: its store (RoomStore fits). */
export interface AttentionLog {
  readonly state: RoomState;
  since(seq: number): RoomEvent[];
}

export type RoomListener = (event: RoomEvent | EphemeralEvent) => void;

export interface AttentionBoardOptions {
  env: NodeJS.ProcessEnv;
  now?: () => number;
  viewTtlMs?: number;
  saveMs?: number;
  log?: (message: string) => void;
}

/** `<agoraHome>/attention.json`: the seen cursor per room. */
export const attentionFile = (env: NodeJS.ProcessEnv = process.env): string => join(agoraHome(env), "attention.json");

/** Whether an event needs the human, and why. Pure. */
export const attentionOf = (_state: RoomState, _event: RoomEvent): Omit<AttentionItem, "room" | "name"> | null => null;

/** A view report from `POST /api/attention/view`, or the text of the 400. */
export const parseView = (body: unknown): AttentionView | string => {
  const fields = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  if (typeof fields.view !== "string" || !/^[\w-]{1,64}$/.test(fields.view)) return "view must be 1-64 letters, digits, _ or -";
  if (fields.room !== null && (typeof fields.room !== "string" || fields.room.length > 200)) return "room must be null or a room id";
  if (typeof fields.looking !== "boolean") return "looking must be true or false";
  return { view: fields.view, room: fields.room, looking: fields.looking };
};

export class AttentionBoard {
  constructor(_options: AttentionBoardOptions) {}

  /** Follows one room's events; a no-op for a room already tracked. Never throws into the room's listeners. */
  track(_room: string, _log: () => AttentionLog, _listeners: Set<RoomListener>): void {}

  view(_view: AttentionView): void {}

  markSeen(_room: string): void {}

  markAllSeen(): void {}

  item(_room: string): AttentionItem | undefined {
    return undefined;
  }

  /** Newest first. */
  items(): AttentionItem[] {
    return [];
  }

  /** Flushes the pending save. */
  close(): void {}
}
```

**`internal/agora/browser.ts`** (browser replaces it)

```ts
import type { ServerResponse } from "node:http";
import type { ActorOrigin } from "./types.js";

/**
 * The room's browser: agents' commands relayed to the app's pane (docs/plans/2026-09-29-desktop-browser-pane.md, A1).
 * SCAFFOLD STUB: the signatures the daemon uses. It never has a host, so every command gets the 503.
 */

export type BrowserOp = "navigate" | "snapshot" | "click" | "type" | "press" | "screenshot" | "eval";

export interface BrowserCommand {
  id: string;
  room: string;
  roomName: string;
  agent: string;
  label: string;
  op: BrowserOp;
  args: Record<string, unknown>;
  /** Epoch ms. */
  deadline: number;
}

export interface BrowserResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  text?: string;
  image?: { data: string; mimeType: "image/png" };
  notes?: string[];
}

export interface BrowserHost {
  send(command: BrowserCommand): void;
  closeRoom(room: string): void;
  close(reason: "replaced" | "stopping"): void;
}

/** A refusal with its HTTP status; the daemon turns it into its own HttpError. */
export class BrowserFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const NO_HOST =
  "The room's browser needs the Agoryx desktop app, and it is not running (or not connected to this daemon). Nothing was opened.";

export class BrowserRelay {
  constructor(_options: { timeoutMs?: number; maxPerRoom?: number; log?: (line: string) => void } = {}) {}

  /** Returns the detach: idempotent, and a no-op unless this host is still the current one. */
  attach(host: BrowserHost): () => void {
    host.close("stopping");
    return () => {};
  }

  command(_origin: ActorOrigin, _body: unknown): Promise<BrowserResult> {
    return Promise.reject(new BrowserFailure(503, NO_HOST));
  }

  /** Throws BrowserFailure(404) for an unknown or expired id. */
  answer(_id: string, _body: unknown): void {
    throw new BrowserFailure(404, "no such browser command");
  }

  /** The room's network went off. */
  closeRoom(_room: string): void {}

  hasHost(): boolean {
    return false;
  }

  close(): void {}
}

/** The app's host stream over SSE. */
export const sseHost = (res: ServerResponse): BrowserHost => ({
  send: () => {},
  closeRoom: () => {},
  close: () => {
    if (!res.headersSent) res.statusCode = 503;
    res.end();
  },
});
```

**`desktop/src/attention.ts`** (attention replaces it)

```ts
import type { BrowserWindow } from "electron";

/**
 * When a room waits for the human: the tray, the Dock badge and banners (docs/plans/2026-09-29-desktop-attention.md,
 * Part B). Electron wiring only; what it decides lives in internal/desktop/attention.ts. Never throws into main.
 * SCAFFOLD STUB: does nothing.
 */

/** What attention needs from the core; missing when AGORYX_ROOT points at a core built before this feature. */
export interface AttentionCore {
  AttentionFollower?: unknown;
}

export interface AttentionOptions {
  core: () => AttentionCore | null;
  window: () => BrowserWindow | null;
  focusWindow: () => void;
  isDaemonUrl: (url: string) => boolean;
  daemonOrigin: () => string | null;
  log: (message: string) => void;
}

export interface Attention {
  /** The daemon to follow, or null while there is none. The same url and token is a no-op. */
  setDaemon(info: { url: string; token: string } | null): void;
  dispose(): void;
}

export const createAttention = (_options: AttentionOptions): Attention => ({
  setDaemon: () => {},
  dispose: () => {},
});
```

`AttentionFollower?: unknown` is a placeholder. Attention narrows it to its constructor type: main only
passes `() => core` through, and `main.ts` loads the core with an `as DesktopCore` cast, so no frozen file
changes.

**`desktop/src/browserpane.ts`** (browser replaces it)

```ts
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";

/**
 * The room's browser: one pane per room inside the main window, driven by agents over the daemon's host link
 * (docs/plans/2026-09-29-desktop-browser-pane.md, Part C). Never throws into main.
 * SCAFFOLD STUB: owns nothing and never connects, so agents get the daemon's 503.
 */

export interface BrowserPanesOptions {
  root: string;
  /** The daemon's UI in the main window's main frame, not a preview. */
  trustedUi: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** Takes the page's last click, as main's takeGesture does. */
  userGesture: (contents: WebContents) => boolean;
  log?: (line: string) => void;
}

export class BrowserPanes {
  constructor(readonly options: BrowserPanesOptions) {}

  /** A pane's contents: main's guard() leaves them to the pane's own rules. */
  owns(_contents: WebContents): boolean {
    return false;
  }

  /** The main window: panes live in it. */
  attachWindow(_win: BrowserWindow): void {}

  /** Idempotent: restarts the host link only when the url or the token changed. */
  connect(_info: { url: string; token: string; port: number }): void {}

  /** IPC handlers, and the app's certificate and login handlers. */
  listen(): void {}

  /** Stops the link and closes every pane. */
  close(): void {}
}
```

`new BrowserPanes(...)` runs when `main.ts` loads, before `app.whenReady()`. The real constructor must
therefore only store its options. Sessions, views and handlers come later, in `attachWindow`, `connect` and
`listen`.

**`ui/src/lib/attention.ts`** (attention replaces it)

```ts
/**
 * Tells the daemon which room this tab looks at (docs/plans/2026-09-29-desktop-attention.md, Part C). The
 * callbacks come from the store, so this module does not import it.
 * SCAFFOLD STUB: reports nothing.
 */
export const startAttention = (_currentRoom: () => string | null, _subscribe: (listener: () => void) => () => void): void => {};
```

### 2.3 Anchored edits (36)

**How to apply them:**

- Each anchor below occurs exactly once in today's file; all 36 were checked. Apply them with an
  exact-string edit, in order.
- "After" means: insert right after the anchor, and keep the anchor.
- "Replace" means: the anchor becomes the new text.
- Indentation is as shown.

#### `internal/agora/types.ts`

**T1.** After (in `ActivityKind`):

```ts
  | "web"
```

insert:

```ts
  | "browser"
```

**T2.** After the file's last line, `export type AgentModels = Record<AgentKind, KindModels>;`, insert:

```ts

// ---------------------------------------------------------------------------
// Attention: a room that waits for the human (internal/agora/attention.ts)
// ---------------------------------------------------------------------------

export type AttentionReason = "done" | "budget" | "stopped" | "error" | "mention";

/** A room that waits for the human: at most one per room, until the human sees it. */
export interface AttentionItem {
  /** The room's id. */
  room: string;
  /** The room's current name, read when the item is read, so a rename shows. */
  name: string;
  /** The event that needs the human; stable across restarts, so (room, seq) is the key. */
  seq: number;
  ts: string;
  reason: AttentionReason;
  /** Who mentioned, stopped or failed: an agent's label, or "<agent>@<room>" for a guest. */
  by?: string;
  /** One line, whitespace collapsed, at most 160 characters with "…". */
  text: string;
}
```

#### `ui/src/components/room/Trace.tsx` and `ui/src/components/session/SessionPanel.tsx`

**U1, U2.** In each file, after:

```ts
  web: GlobeIcon,
```

insert:

```ts
  browser: GlobeIcon,
```

Without these two lines, T1 breaks the UI typecheck: both `ICON` records are exhaustive. `web/app.js`
falls back to "·" for unknown kinds and needs nothing.

#### `internal/agora/daemon.ts`

**D1.** After `import { agentBehind } from "./agentprocs.js";` insert:

```ts
import { AttentionBoard, parseView } from "./attention.js";
import { BrowserFailure, BrowserRelay, sseHost } from "./browser.js";
```

**D2.** Replace `const readBody = (req: IncomingMessage): Promise<unknown> =>` with:

```ts
const readBody = (req: IncomingMessage, limit = MAX_BODY): Promise<unknown> =>
```

**D3.** Replace `      if (size > MAX_BODY) {` with:

```ts
      if (size > limit) {
```

**D4.** Anchor:

```ts
  private heartbeat?: NodeJS.Timeout;
  port = 0;
```

Replace with:

```ts
  private heartbeat?: NodeJS.Timeout;
  /** Which rooms wait for the human (attention.ts). */
  private readonly attention: AttentionBoard;
  /** The room's browser: agents' commands to the app's pane (browser.ts). */
  private readonly browser: BrowserRelay;
  port = 0;
```

**D5.** After `    this.log = options.log ?? (() => {});` insert:

```ts
    this.attention = new AttentionBoard({ env: this.env, log: this.log });
    this.browser = new BrowserRelay({ log: (line) => this.log(line) });
```

**D6.** After:

```ts
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
```

insert:

```ts
    // The app's browser host stream is not in sseClients: end it here, or server.close() waits for it.
    this.browser.close();
```

**D7.** Anchor (the end of the engines' close in `close()`):

```ts
    );
    this.rooms.clear();
```

Replace with:

```ts
    );
    this.attention.close();
    this.rooms.clear();
```

**D8.** After `    this.rooms.set(id, handle);` insert:

```ts
    this.attention.track(id, () => handle.store, handle.listeners);
```

This line goes before the `this.tryDrive(handle);` under it. Anchor on the `rooms.set` line:
`tryDrive(handle)` alone also matches the stream follow timer.

**D9.** Anchor (in `onRoomEvent`):

```ts
    } else if (event.type === "turn.ended") {
      handle.streams.delete(event.turnId);
    }
```

Replace with:

```ts
    } else if (event.type === "turn.ended") {
      handle.streams.delete(event.turnId);
    } else if (event.type === "settings.changed" && event.patch.network === false) {
      // The room's network went off, and its browser with it.
      this.browser.closeRoom(handle.store.id);
    }
```

**D10.** Anchor:

```ts
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.checkHost(req);
```

Replace with:

```ts
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The room's browser pane marks every request it makes: no page it opens reaches Agoryx.
    if (req.headers["x-agoryx-pane"] !== undefined) throw new HttpError(403, "the room's browser cannot open Agoryx itself");
    this.checkHost(req);
```

**D11.** Anchor: `    if (parts[0] !== "rooms") throw new HttpError(404, "unknown endpoint");`. Replace with:

```ts
    if (parts[0] === "attention") return this.attentionApi(req, res, parts.slice(1), method, caller);
    if (parts[0] === "browser") return this.browserApi(req, res, parts.slice(1), method, caller);

    if (parts[0] !== "rooms") throw new HttpError(404, "unknown endpoint");
```

**D12.** Anchor (the `GET /api/rooms` mapping):

```ts
          return handle ? { ...handle.store.summary(), driven: Boolean(handle.engine) } : summary;
```

Replace with:

```ts
          if (!handle) return summary;
          // What the human has not seen is the human's: an agent key never learns it.
          return { ...handle.store.summary(), driven: Boolean(handle.engine), ...(caller.agent ? {} : { waiting: this.attention.item(summary.id) }) };
```

**D13.** After `    const actor = this.actorFor(caller, engine.state);` insert:

```ts
    // The human acting in a room has seen it.
    if (!caller.agent) this.attention.markSeen(handle.store.id);
```

**D14.** Anchor (the end of `stream()` and of the class):

```ts
      handle.followers -= 1;
      if (handle.followers <= 0 && handle.followTimer) {
        clearInterval(handle.followTimer);
        delete handle.followTimer;
      }
    });
  }
}
```

Replace with the same lines, followed by the two route methods:

```ts
      handle.followers -= 1;
      if (handle.followers <= 0 && handle.followTimer) {
        clearInterval(handle.followTimer);
        delete handle.followTimer;
      }
    });
  }

  /** /api/attention: which rooms wait for the human, and where the human looks. The human's only; no stream. */
  private async attentionApi(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, caller: Caller): Promise<void> {
    if (caller.agent) throw new HttpError(403, "attention is the human's");
    const [what, ...rest] = parts;
    if (rest.length > 0 || (what !== undefined && what !== "view" && what !== "seen")) throw new HttpError(404, "unknown endpoint");
    if (what === undefined) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
    } else {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = await readBody(req);
      const fields = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      if (what === "view") {
        const view = parseView(body);
        if (typeof view === "string") throw new HttpError(400, view);
        this.attention.view(view);
      } else if (fields.all === true) {
        this.attention.markAllSeen();
      } else if (typeof fields.room === "string" && fields.room) {
        this.attention.markSeen(fields.room);
      } else {
        throw new HttpError(400, "send { room } or { all: true }");
      }
    }
    sendJson(res, 200, { rooms: this.attention.items() });
  }

  /** /api/browser: agents' commands to the room's browser, and the app that hosts it. */
  private async browserApi(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, caller: Caller): Promise<void> {
    try {
      if (parts.length === 0) {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        const origin = caller.agent;
        if (!origin) throw new HttpError(403, "browser commands come from agents, under their own key; the human uses the pane itself");
        const engine = this.rooms.get(origin.room)?.engine;
        if (!engine || engine.presence()[origin.agent] !== "working") throw new HttpError(409, "The room's browser works only while your turn runs.");
        if (!engine.state.settings.network) {
          throw new HttpError(403, "This room's network is off, so its browser is off too. The human can turn the network on in the room settings.");
        }
        // Any agent can compute any key from daemon.token: the command must come from this agent's own turn.
        const owner = await agentBehind(req.socket);
        if (!owner || "unknown" in owner || owner.room !== origin.room || owner.agent !== origin.agent) {
          throw new HttpError(403, "Browser commands must come from your own turn: your CLI, or a process it started.");
        }
        const result = await this.browser.command(origin, await readBody(req));
        sendJson(res, 200, { ok: true, result });
        return;
      }
      if (caller.agent) throw new HttpError(403, "only the Agoryx app hosts the room's browser");
      if (parts[0] === "host" && parts.length === 1) {
        if (method !== "GET") throw new HttpError(405, "method not allowed");
        const detach = this.browser.attach(sseHost(res));
        req.on("close", detach);
        return;
      }
      if (parts[0] === "answer" && parts.length === 2) {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        this.browser.answer(parts[1]!, await readBody(req, 8 * 1024 * 1024));
        sendJson(res, 200, { ok: true });
        return;
      }
      throw new HttpError(404, "unknown endpoint");
    } catch (error) {
      if (error instanceof BrowserFailure) throw new HttpError(error.status, error.message);
      throw error;
    }
  }
}
```

**Notes on D14:**

- The texts of the 409, the network-off 403 and the process 403 are the browser spec's A1 table, word for
  word.
- The order of the checks is the spec's: turn, then network, then process.
- `const engine = …` is a separate variable so that TypeScript narrows it. The one-liner in the spec does
  not narrow `handle`.

#### `desktop/src/main.ts`

**M1.** Replace:

```ts
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent, Rectangle, WebContents, WebPreferences } from "electron";
```

with:

```ts
import type { BrowserWindowConstructorOptions, IpcMainEvent, IpcMainInvokeEvent, Rectangle, WebContents, WebPreferences } from "electron";
```

**M2.** After `import { fileURLToPath, pathToFileURL } from "node:url";` insert:

```ts
import { createAttention, type AttentionCore } from "./attention.js";
import { BrowserPanes } from "./browserpane.js";
```

**M3.** Replace `interface DesktopCore {` with `interface DesktopCore extends AttentionCore {`.

**M4.** After `let stopping = false;` insert:

```ts
/** The tray, the Dock badge and banners for rooms that wait (attention.ts); made in ready(). */
let attention: ReturnType<typeof createAttention> | null = null;
```

**M5.** Anchor (in `showDaemon`):

```ts
  view = "daemon";
  if (!win || win.isDestroyed()) return;
```

Replace with:

```ts
  view = "daemon";
  // Also with the window closed. Neither throws, and both are no-ops for the same daemon (render() calls this again).
  attention?.setDaemon(info);
  panes.connect(info);
  if (!win || win.isDestroyed()) return;
```

**M6.** Anchor:

```ts
const onDown = (): void => {
  if (stopping) return;
  daemon = null;
```

After it, insert `  attention?.setDaemon(null);`.

**M7.** Anchor:

```ts
const onFailed = (failure: SupervisorFailure): void => {
  if (stopping) return;
  daemon = null;
```

After it, insert `  attention?.setDaemon(null);`.

**M8.** Anchor (in `createWindow`):

```ts
  win = next;
  render(next);
```

Replace with:

```ts
  win = next;
  panes.attachWindow(next);
  render(next);
```

**M9.** After:

```ts
const fromStartPage = (event: IpcMainInvokeEvent): void => {
  if (!isStartPage(event.senderFrame?.url ?? "")) throw new Error("only the start page may ask this");
};
```

insert:

```ts

/** The daemon's UI in the main window's main frame, not a preview: the only page that may use the room's browser. */
const trustedUi = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  win !== null &&
  !win.isDestroyed() &&
  event.sender === win.webContents &&
  event.senderFrame === win.webContents.mainFrame &&
  isDaemonUrl(event.senderFrame?.url ?? "") &&
  !isPreviewUrl(event.senderFrame?.url ?? "");

/** The room's browser (browserpane.ts): one pane per room, inside the main window. */
const panes = new BrowserPanes({
  root: agoryxRoot(),
  trustedUi,
  userGesture: (contents) => takeGesture(contents),
  log: (line) => console.log(`[browser] ${line}`),
});
```

`showDaemon` and `createWindow` sit above this and use `panes`. That is safe: they only run from `ready()`,
after the module has loaded.

**M10.** Anchor (the end of `listen()`):

```ts
    return runChecks(probe === true).then(() => checks);
  });
};
```

Replace with:

```ts
    return runChecks(probe === true).then(() => checks);
  });
  panes.listen();
};
```

**M11.** Before:

```ts
/** The standard menus spelled out, so that they speak Ukrainian like the rest (Electron's role menus are English). */
```

insert:

```ts
/**
 * «Вигляд» acts on the focused window's own page (the UI, or a daemon child window), never on the focused
 * contents: with the room's browser focused, the roles would reload it, zoom it (moving the agents' coordinates)
 * or open its DevTools.
 */
const onPage = (act: (page: WebContents) => void): void => {
  const target = BrowserWindow.getFocusedWindow() ?? win;
  if (target && !target.isDestroyed()) act(target.webContents);
};

```

**M12.** Replace these «Вигляд» items:

```ts
        { role: "reload", label: "Оновити" },
        { role: "forceReload", label: "Оновити повністю" },
        { role: "toggleDevTools", label: "Інструменти розробника" },
        { type: "separator" },
        { role: "resetZoom", label: "Справжній розмір" },
        { role: "zoomIn", label: "Збільшити" },
        { role: "zoomOut", label: "Зменшити" },
```

with:

```ts
        { label: "Оновити", accelerator: "CmdOrCtrl+R", click: () => onPage((page) => page.reload()) },
        { label: "Оновити повністю", accelerator: "Shift+CmdOrCtrl+R", click: () => onPage((page) => page.reloadIgnoringCache()) },
        { label: "Інструменти розробника", accelerator: "Alt+CmdOrCtrl+I", click: () => onPage((page) => page.toggleDevTools()) },
        { type: "separator" },
        { label: "Справжній розмір", accelerator: "CmdOrCtrl+0", click: () => onPage((page) => page.setZoomLevel(0)) },
        { label: "Збільшити", accelerator: "CmdOrCtrl+Plus", click: () => onPage((page) => page.setZoomLevel(page.getZoomLevel() + 0.5)) },
        { label: "Зменшити", accelerator: "CmdOrCtrl+-", click: () => onPage((page) => page.setZoomLevel(page.getZoomLevel() - 0.5)) },
```

`togglefullscreen` stays a role.

**M13.** Anchor (in `ready()`):

```ts
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  void boot();
```

Replace with:

```ts
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  attention = createAttention({ core: () => core, window: () => win, focusWindow, isDaemonUrl, daemonOrigin, log: (message) => console.log(`[attention] ${message}`) });
  void boot();
```

**M14.** Replace:

```ts
  app.on("web-contents-created", (_event, contents) => guard(contents));
```

with:

```ts
  // A pane of the room's browser has its own rules (browserpane.ts); every other page gets guard().
  app.on("web-contents-created", (_event, contents) => {
    if (!panes.owns(contents)) guard(contents);
  });
```

**M15.** Anchor:

```ts
  app.on("before-quit", () => {
    supervisor?.removeAllListeners();
```

Replace with:

```ts
  app.on("before-quit", () => {
    attention?.dispose();
    panes.close();
    supervisor?.removeAllListeners();
```

#### `ui/src/lib/store.ts`

**S1.** After `import { api, ApiError, local, roomPath, setUnauthorizedHandler, Unauthorized } from "./api";`
insert:

```ts
import { startAttention } from "./attention";
```

**S2.** Replace:

```ts
/** The right-hand panel: the shared document, or an agent's own session; the table is a view of its own. */
export type PanelTab = "doc" | "session";
```

with:

```ts
/** The right-hand panel: the shared document, an agent's own session, or the room's browser (in the app); the table is a view of its own. */
export type PanelTab = "doc" | "session" | "browser";
```

Until the browser engineer adds its branch in `App.tsx`, `"browser"` falls through to the doc panel.
Nothing sets it before then.

**S3.** Anchor (in `boot()`):

```ts
  window.addEventListener("hashchange", syncRoute);
  setInterval(() => void useStore.getState().loadRooms(), 5000);
```

Replace with:

```ts
  window.addEventListener("hashchange", syncRoute);
  startAttention(
    () => {
      const s = useStore.getState();
      return s.route.kind === "room" ? (s.snap?.state.id ?? s.route.id) : null;
    },
    (fn) => useStore.subscribe(fn),
  );
  setInterval(() => void useStore.getState().loadRooms(), 5000);
```

### 2.4 Docs: placeholders and the shared rows

Placeholders are HTML comments, so the rendered docs stay clean in the meantime. Each owner replaces
their own placeholder line. All five anchors below were checked to occur once.

**`CHANGELOG.md`**. After the line that ends
``… `--probe` also makes one short real call to each logged-in agent.`` (the `agoryx doctor` bullet),
insert:

```md
<!-- SCAFFOLD: feature 2 (attention) Added bullet goes here -->
<!-- SCAFFOLD: feature 3 (browser) Added bullet goes here -->
```

**`docs/DESKTOP.md`**, new sections. Just before the `## What the window may do` heading, insert:

```md
<!-- SCAFFOLD: feature 2 (attention) section "When a room waits for you" goes here, with its security notes -->

<!-- SCAFFOLD: feature 3 (browser) section "The room's browser" goes here -->

```

**`docs/DESKTOP.md`**, Files table. Replace the preload row
(`` | `desktop/src/preload.cts` | the start page's bridge (CommonJS: sandboxed preloads cannot be ES modules) | ``)
with:

```md
| `desktop/src/preload.cts` | the bridges (CommonJS: sandboxed preloads cannot be ES modules): `agoryxDesktop` for the start page, `agoryxBrowser` for the daemon's UI |
| `desktop/src/attention.ts` | the tray, the Dock badge and banners for rooms that wait for you (wiring; the decisions live in the core) |
| `desktop/src/trayicon.ts` | the tray's template image, drawn in memory |
| `desktop/src/browserpane.ts` | the room's browser: one pane per room inside the window, driven by agents over the daemon's host link |
```

Also replace the `` | `internal/desktop/` | … | `` row with:

```md
| `internal/desktop/` | the core the app loads: `shellenv`, `doctor`, `supervisor`, `attention` (following the rooms that wait), `browserlink` and `browserpage` (the room browser's host link and page helpers) |
```

**`docs/AGORA.md`**, Safety. After the line
``  must stay inside the workspace. `.git` is never served.`` (the end of the `/raw/` bullet), insert:

```md
<!-- SCAFFOLD: feature 2 (attention) Safety bullet goes here -->
<!-- SCAFFOLD: feature 3 (browser) Safety bullet goes here -->
```

**`docs/AGORA.md`**, Code map. After the `` | `internal/agora/daemoninfo.ts` | … | `` row, insert:

```md
| `internal/agora/attention.ts` | Rooms that wait for the human: what counts, what was seen (`attention.json`), where the human looks; `/api/attention` |
| `internal/agora/browser.ts` | The room's browser: agents' commands relayed to the app's pane over `/api/browser` |
| `internal/agora/browsertools.ts`, `bin/agoryx-mcp.mjs` | The MCP flags both CLIs get and the browser's trace labels; the zero-dependency MCP server the room hands them (`agoryx mcp` in the shim) |
```

In the `` | `internal/desktop/` | … | `` row, replace the ending
``daemon supervisor (`supervisor.ts`) |`` with:

```md
daemon supervisor (`supervisor.ts`), the attention follower (`attention.ts`), the room browser's host link and page helpers (`browserlink.ts`, `browserpage.ts`) |
```

Everything else in the docs is one owner's (section 3). A later change to these shared rows, such as a
renamed file, goes through the lead.

### 2.5 Verify, then hand over

```sh
npm run typecheck
desktop/node_modules/.bin/tsc -p desktop/tsconfig.json --noEmit
npm --prefix ui run typecheck
npm test
```

All four pass on the scaffolded scratch copy. The full suite runs 901 tests; one is skipped without
`dist/`.

To check the stubs' routes, run a throwaway `node:test` file in the scratchpad against an in-process
`AgoraDaemon`: a temp `AGORYX_HOME`, `port: 0`, `advertise: false`, fake runners from
`tests/agora/helpers.ts`, and the `call()` pattern of `tests/agora/daemon.test.ts`. Close the daemon at the
end. Expected answers:

| Request | Expected |
|---------|----------|
| `GET /api/attention`, human | 200 `{"rooms":[]}` |
| `POST /api/attention` | 405 |
| `GET /api/attention/view` | 405 |
| `GET /api/attention/nope` | 404 |
| `POST /api/attention/view` `{"view":"bad id!","room":null,"looking":true}` | 400 |
| `POST /api/attention/view` `{"view":"app-1","room":"<id>","looking":true}` | 200 |
| `POST /api/attention/seen` `{}` | 400 |
| `POST /api/attention/seen` `{"all":true}` | 200 |
| `GET /api/attention`, agent key (`agentKey(token, room, "claude")`) | 403 |
| `POST /api/browser`, human token | 403 |
| `POST /api/browser`, agent key, no turn running | 409 |
| `GET /api/browser/host`, agent key | 403 |
| `GET /api/browser/host`, human | 503, ended at once (the stub has no host) |
| `POST /api/browser/answer/abc`, human | 404 |
| `/api/health` or `/` with `x-agoryx-pane: 1` | 403 |
| `GET /api/rooms` | no room has `waiting` |
| `POST /api/rooms/<id>/messages`, human | 2xx, as before |

Then tell both engineers to start.

### 2.6 What the scaffold does not touch, and why

| File | Why not |
|------|---------|
| `desktop/src/preload.cts` | Only the browser adds a block; attention has no preload, IPC or global. The browser owns it from the start. |
| `cmd/agoryx/main.ts` | Neither feature adds a human subcommand. `mcp` lives in the agents' shim, `bin/agoryx-agent.mjs`, which the browser owns. |
| `ui/src/App.tsx` | Only the browser changes it: the `SidePanel` branch, title, width, the lazy loader, the `Toaster` position. |
| `package.json` | `npm test` (`tests/**/*.test.ts`, one level deep under `sh`) already finds new files directly under `tests/agora/` and `tests/desktop/`; `build:core` already compiles every new `internal/` file. |
| `desktop/package.json`, `desktop/tsconfig.json` | `tsconfig` includes `src/**/*.ts`, so the new desktop files compile. No new dependency. Attention's PNG fallback would need a change here: ask the lead. |
| `desktop/electron-builder.config.cjs` | `extraResources` already ships `dist`, `bin`, `ui/dist` and `package.json`. The `identity` line waits for Ivan's decision 1. |
| `tests/desktop/imports.test.ts` | The walk covers new `internal/desktop/*.ts` by itself. Its allow-lists (`node:*`, dependency-free relative files) and forbidden lists (`daemon.ts`, `store.ts`, `engine.ts`, `service.ts`) stay as they are. |
| `internal/desktop/index.ts` | Only attention adds an export line. The browser pane loads its two modules itself. |
| `web/app.js` | Its `ACT_ICON` falls back to "·" for unknown kinds. |

## 3. Who owns what after the scaffold

### 3.1 Attention (feature 2)

**New files:**

- `internal/agora/attention.ts` (replaces the stub);
- `internal/desktop/attention.ts`: dependency-free, with a type-only `AttentionItem`;
- `desktop/src/attention.ts` (replaces the stub);
- `desktop/src/trayicon.ts`;
- `ui/src/lib/attention.ts` (replaces the stub);
- `tests/agora/attention.test.ts`;
- `tests/agora/daemon-attention.test.ts`;
- `tests/desktop/attention.test.ts`.

**Existing files:**

- `internal/desktop/index.ts`: one export line;
- `ui/src/lib/types.ts`: `waiting?: AttentionItem` on `RoomSummary`, and nothing else;
- `ui/src/components/Sidebar.tsx`: the waiting dot.

**Docs:**

- its spec;
- `CHANGELOG.md`: its placeholder;
- `docs/DESKTOP.md`:
  - its section placeholder, including its security notes;
  - in "What's next", removing the line "Notifications, a menu-bar icon, a Dock badge…";
- `docs/AGORA.md`:
  - its Safety placeholder;
  - the `attention.json` row in Storage;
  - the sidebar-dot sentence in "Web UI".

**Only after Ivan says yes to decision 1:** the `identity` line in `desktop/electron-builder.config.cjs`.

**Keep these as they are:**

- the stub signatures: `AttentionBoard`'s options and methods, `parseView`, `createAttention` and its
  options, `AttentionCore`, `startAttention`;
- the route behavior that D14 implements.

### 3.2 Browser (feature 3)

**New files:**

- `internal/agora/browser.ts` (replaces the stub);
- `internal/agora/browsertools.ts`: dependency-free;
- `bin/agoryx-mcp.mjs`;
- `internal/desktop/browserlink.ts`;
- `internal/desktop/browserpage.ts`;
- `desktop/src/browserpane.ts` (replaces the stub);
- `ui/src/lib/desktop.ts`;
- `ui/src/components/browser/BrowserPanel.tsx`;
- `ui/src/components/browser/BrowserToggle.tsx`;
- `tests/agora/browser.test.ts`;
- `tests/agora/browser-mcp.test.ts`;
- `tests/agora/browser-runners.test.ts`;
- `tests/agora/fixtures/mcp-call.mjs`;
- `tests/desktop/browserpage.test.ts`;
- `tests/desktop/browserlink.test.ts`.

**Existing files:**

- `desktop/src/preload.cts`;
- `internal/agora/runners/claude.ts` and `internal/agora/runners/codex.ts`;
- `bin/agoryx-agent.mjs`: the `mcp` block;
- `ui/src/App.tsx`;
- `ui/src/components/room/RoomHeader.tsx`;
- `ui/src/components/room/Feed.tsx`;
- `ui/src/components/room/Trace.tsx` and `ui/src/components/session/SessionPanel.tsx`, after the
  scaffold's icon line.

**Docs:**

- its spec, including deleting the stale lines in item 7 of section 1;
- `CHANGELOG.md`: its placeholder;
- `docs/DESKTOP.md`:
  - its section placeholder;
  - the diagram in "How it fits together";
  - "What the window may do";
  - in "What's next", the line "A shared browser pane.";
- `docs/AGORA.md`:
  - a new "### The room's browser" under "Using it";
  - its Safety placeholder.

**Keep these as they are:**

- `BrowserRelay`'s constructor options, `attach`, `command`, `answer`, `closeRoom` and `close`;
- `BrowserFailure(status, message)`;
- `sseHost(res)`;
- `BrowserPanes`' options, `owns`, `attachWindow`, `connect`, `listen` and `close`.

### 3.3 Neither: ask the lead (Ivan decides disputes)

**Frozen by the scaffold:**

- `internal/agora/daemon.ts`;
- `internal/agora/types.ts`;
- `desktop/src/main.ts`;
- `ui/src/lib/store.ts`.

**Shared core both rely on:**

- `internal/agora/`: `engine.ts`, `store.ts`, `service.ts`, `agentprocs.ts`, `actor.ts`, `paths.ts`,
  `prompts.ts`, `projection.ts`, `client.ts`, `daemoninfo.ts`;
- `internal/desktop/`: `supervisor.ts`, `shellenv.ts`, `doctor.ts`;
- `ui/src/lib/api.ts`.

**Tests and fixtures:**

- `tests/agora/helpers.ts`;
- `tests/agora/fixtures/fake-agent.mjs`;
- `tests/agora/daemon.test.ts`;
- `tests/desktop/imports.test.ts`;
- every other existing test.

**Build and packaging:**

- `package.json`, `package-lock.json`, `tsconfig.json`;
- `desktop/package.json`, `desktop/tsconfig.json`, `desktop/scripts/*`, `desktop/static/*`;
- `desktop/electron-builder.config.cjs`. Ivan decides; after his yes, attention adds the `identity` line;
- `ui/package.json`, `ui/tsconfig*.json`, `ui/vite.config.ts`.

**CLI and the old page:**

- `cmd/agoryx/*`;
- `bin/agoryx.js`;
- `web/*`.

**Docs:**

- the other feature's spec;
- the shared rows the scaffold wrote: the `DESKTOP.md` Files table and the `AGORA.md` Code map.

**How to ask.** Send the lead the exact edit (file, anchor, new text) and the reason. The lead applies it,
reruns the typechecks and tells the other engineer. After the merge, the lead updates the project memory
(`.agoryx/memory.md`).

## 4. Merge-time checks

### 4.1 Before the commands

- Each owner says their feature is done. Each spec's own tests and E2E have passed on this joint tree,
  not in a copy with only one feature.
- Leftovers:
  - `grep -rn "SCAFFOLD STUB" internal desktop/src ui/src` finds nothing;
  - `grep -n "SCAFFOLD:" CHANGELOG.md docs/DESKTOP.md docs/AGORA.md` finds nothing;
  - `grep -n "Feature 2 adds its own block\|Feature 2's own event stream" docs/plans/2026-09-29-desktop-browser-pane.md`
    finds nothing.
- `git status --short` lists only files from section 3, the two specs and this plan.
- `git diff -- internal/agora/daemon.ts desktop/src/main.ts ui/src/lib/store.ts internal/agora/types.ts`
  shows the scaffold, plus only the edits the lead applied on request.

### 4.2 Commands, from the worktree root, in this order

```sh
npm run typecheck                 # core: internal/ and cmd/
npm --prefix ui run typecheck     # UI (tsc -b), incl. the internal files it imports under its stricter options
npm run build                     # core into dist/, UI into ui/dist/
npm --prefix desktop run build    # desktop tsc and the icon
npm test                          # everything; with dist/ built, the built-core imports test runs too
```

**Then:**

1. `npm test 2>&1 | grep "the built core"` shows that test passed, not skipped.
2. The two browser modules the pane loads by itself also load in plain Node, with no Electron:
   ```sh
   node --input-type=module -e 'await import("./dist/internal/desktop/browserlink.js"); await import("./dist/internal/desktop/browserpage.js")'
   ```
3. `node --check bin/agoryx-mcp.mjs`.
4. Optional, before a release: `npm --prefix desktop run dist`. Check that the built `.app` has
   `Contents/Resources/agoryx/bin/agoryx-mcp.mjs` and `Contents/Resources/agoryx/dist/internal/agora/attention.js`.

### 4.3 Combined E2E: both features at once

Temporary state only. Never use 7717 or `~/.local/state/agoryx`, and stop everything you start.

**Setup:**

1. **Make the temp folders.**
   `T=$(mktemp -d <scratchpad>/wf-e2e.XXXX)`, `H=$T/home`.
2. **Build.** `npm run build`, then `npm --prefix desktop run build`.
3. **Start the page server.** Run the browser spec's fixture page server on a free port, from the
   scratchpad, not the repo. Call its port `$PAGE`.
4. **Write the fake agents.**
   - The fake bins `$T/claude` and `$T/codex` are `sh` wrappers:
     `exec node <worktree>/tests/agora/fixtures/fake-agent.mjs <kind> "$@"`.
   - `$T/rules.json`, for the `claude` agent:
     - match «відкрий»: `run` `[["node", "<worktree>/tests/agora/fixtures/mcp-call.mjs", "browser_navigate", "{\"url\":\"http://127.0.0.1:$PAGE/\"}"]]`,
       reply `@ivan the page is open`;
     - match «ще»: the same `run` with `/settings`, reply `@ivan opened settings`;
     - match «довго»: `sleepMs: 20000`.
5. **Launch the app** on temporary state, with the environment of the attention spec's E2E step 2:
   ```sh
   AGORYX_HOME=$H/agora AGORYX_WORKSPACES=$T/ws AGORYX_HUMAN=ivan AGORYX_CLAUDE_BIN=$T/claude AGORYX_CODEX_BIN=$T/codex \
   FAKE_RULES=$T/rules.json FAKE_LOG=$T/fake.log FAKE_STATE=$T/fake-state \
   desktop/node_modules/.bin/electron desktop --user-data-dir=$T/ud > $T/app.log 2>&1 &
   ```
   Keep the app's stdout: it holds the `[attention]` and `[browser]` lines.
6. **Check the temp daemon's port.** It takes the next free port after 7717, because Ivan's daemon holds
   7717. Read `url`, `token` and `pid` from `$H/agora/daemon.json`. **Stop if the port is 7717 or the pid
   is 17815.** Set `U=<url>` and `TOK=<token>`, and define `att() { curl -s -H "x-agoryx-token: $TOK" "$U/api/attention"; }`.
7. **Make two rooms, Claude only:**
   `AGORYX_HOME=$H/agora node bin/agoryx.js new A --agents '[{"kind":"claude"}]'`, and the same for B.
   Network is on by default.

**Checks** (action, then the expected result):

1. **A browser mention raises attention; the browser work does not.**
   - Action:
     1. Open A in the app and open «Браузер».
     2. Move focus away: `osascript -e 'tell application "Finder" to activate'`.
     3. `AGORYX_HOME=$H/agora node bin/agoryx.js say -r A "відкрий"`.
   - Expected:
     - The pane shows the fixture page, and the driver line shows while the command runs.
     - `app.log` has `[attention] arrived <A> mention` and `badge 1`; the tray has the dot.
     - `att` lists A once, with reason `mention` and the seq of Claude's message.
     - `fake.log` shows the run's output with the page lines.
2. **Focus in the pane counts as looking.**
   - Action:
     1. Choose A in the tray: the item clears, `badge 0`.
     2. Click inside the pane's page, so focus is in the pane.
     3. `say -r A "ще"`.
   - Expected:
     - The pane goes to `/settings`.
     - No new `arrived` line, and `att` is empty.
3. **Opening another room from the tray while the browser panel is open.**
   - Action:
     1. Move focus to Finder.
     2. `say -r B "відкрий"`: B's item arrives.
     3. With the panel still open on A, choose B in the tray.
   - Expected:
     - The window routes to B with no reload: `app.log` has no new-document navigation, and A's pane
       hides.
     - B's panel shows B's pane with the fixture page.
     - B's item clears within about 1 s.
     - Choose A again: A's pane comes back at the same URL.
4. **The menu acts on the UI, not the pane.**
   - Action: with focus in the pane, press ⌘+, then ⌘0, then ⌘R.
   - Expected:
     - The UI zooms and reloads; the pane's URL and page state stay.
     - After the zoom, the pane still lines up with its placeholder.
     - ⌥⌘I opens the UI's DevTools, not the pane's.
5. **The window closes; the tray lives on.**
   - Action:
     1. Close the window (⌘W).
     2. `say -r A "відкрий"`.
   - Expected:
     - The driver gets the window-closed error in the run's output.
     - The item still arrives: the tray dot and `badge 1`.
     - Choosing A in the tray re-creates the window on A, and the item clears.
     - The browser panel works again after the next command.
6. **Daemon restart.**
   - Action:
     1. Move focus to Finder.
     2. Start `say -r B "довго"` in the background.
     3. `kill -9` the temp daemon's pid from `$H/agora/daemon.json`, after checking again that it is not
        17815.
   - Expected:
     - The supervisor goes down and comes back up.
     - There is exactly one new `arrived <B> stopped`, and no repeats of older items.
     - `app.log` shows the browser link reconnecting once.
     - With A open, `say -r A "відкрий"` drives the pane again.
     - Re-read `U` and `TOK` from `daemon.json` for the next steps.
7. **Network off.**
   - Action:
     1. With A's pane open, run `AGORYX_HOME=$H/agora node bin/agoryx.js settings -r A --network off`.
     2. `say -r A "відкрий"`.
   - Expected:
     - A's pane closes.
     - The run's output has the network-off error.
     - `att` shows only the `mention`, from the reply that follows. The closing pane and the refused
       command raise nothing.
     - Turn the network back on.
8. **Agent keys.**
   - Action: compute A's Claude key:
     `KEY=$(TOK=$TOK ROOM=<A id> npx tsx -e 'import { agentKey } from "./internal/agora/actor.ts"; console.log(agentKey(process.env.TOK, process.env.ROOM, "claude"))')`.
   - Expected:
     - 403 with `-H "x-agoryx-token: $KEY"` on `GET $U/api/attention`, `GET $U/api/browser/host` and
       `POST $U/api/browser/answer/x`.
     - `GET $U/api/rooms` answers 200, with no `waiting` field.
     - `POST $U/api/browser` from this shell with the key answers 409 while no turn runs, and 403 during
       a «довго» turn: this shell is not the agent's process.
9. **Pane pages cannot reach Agoryx.**
   - Action: type `$U/api/health` into the panel's address field.
   - Expected: it is refused inline.
10. **Quit and clean up.**
    - Action: «Вийти» from the tray.
    - Expected:
      - The panes close.
      - `app.log` has attention's dispose and no errors.
      - The temp daemon keeps running.
    - Cleanup:
      - `AGORYX_HOME=$H/agora node bin/agoryx.js down`;
      - stop the page server;
      - check that no process from `$T` is left: `pgrep -fl "$T"` finds nothing;
      - `rm -rf $T`.

**If banners are built** (a signed build), steps 1, 3 and 6 also each show one banner. Clicking it opens
that room, and the pane follows as in step 3.

### 4.4 Out of scope, noticed while splitting

- **`routeFromHash` and a malformed hash.** In the UI, `routeFromHash` does not guard against a
  malformed hash such as `#%`. Attention's `lookingAt` does, so this is a separate UI fix.
- **The supervisor's listener check.** The supervisor does not check the listener's pid when it attaches
  to a running daemon. The attention spec's review decisions cover the risk; any hardening is separate.
