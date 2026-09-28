import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { findLiveBlock, LIVE_LANGS } from "./blocks.js";
import { DocConflictError, RoomEngine, RoomLockedError, roomTurnPatch } from "./engine.js";
import { agoraHome, daemonInfoPath, DEFAULT_PORT, roomsDir } from "./paths.js";
import { eventPatch, presenceOf, roomSnapshot, runningTurnsPresence, type StreamBuffer } from "./snapshot.js";
import type { AgentRunner } from "./runners/types.js";
import { createRoom, defaultRunners, openEngine, resumeCommands, roomNameFrom } from "./service.js";
import { RoomStore } from "./store.js";
import { describeTableOp, TableOpError } from "./table.js";
import type { AgentKind, AgentPresence, DocRevision, EphemeralEvent, RoomEvent, RoomSettings } from "./types.js";
import { diffHunks, diffLines, docHash, MAX_DOC_TEXT, normalizeDocPath, readDoc } from "./doc.js";
import { listWorkspaceFiles, repoRoot, resolveInside } from "./workspace.js";

export interface DaemonInfo {
  pid: number;
  port: number;
  url: string;
  token: string;
  startedAt: string;
}

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  port?: number;
  runners?: Partial<Record<AgentKind, AgentRunner>>;
  log?: (message: string) => void;
  /** Directory with the web UI; defaults to <repo>/web. */
  webDir?: string;
  /** Write daemon.json so the CLI can find us (default true). */
  advertise?: boolean;
  opsPollMs?: number;
  /** Rooms active within this many days are opened at start, so their native sessions are watched (default 14; 0 = lazily only). */
  watchDays?: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const MAX_RAW = 25 * 1024 * 1024;
/**
 * Workspace files are agent-authored: serve them as sandboxed documents with an
 * opaque origin, so an agent's HTML can run its own scripts but can never talk
 * to the daemon API with the human's cookie.
 */
const RAW_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; frame-ancestors 'self'";

/**
 * Appended to html the page embeds: reports the document's height to the page
 * so a live block is as tall as its content. The frame stays sandboxed; this
 * only sends a number up.
 */
const FRAME_REPORTER = Buffer.from(
  // The content's own height, not the viewport's: scrollHeight never drops below the frame, so a frame could only grow.
  '\n<script>(()=>{let last=0;const size=()=>{const d=document.documentElement,b=document.body;if(!b)return d.scrollHeight;const m=parseFloat(getComputedStyle(b).marginBottom)||0;let h=b.getBoundingClientRect().bottom+m;for(const el of b.children){const r=el.getBoundingClientRect();if(r.bottom>h)h=r.bottom}return h};const post=()=>{const h=Math.ceil(size()+scrollY);if(Math.abs(h-last)>2){last=h;parent.postMessage({agoryxFrame:1,h},"*")}};addEventListener("load",post);try{const o=new ResizeObserver(post);o.observe(document.documentElement);document.body&&o.observe(document.body)}catch{}setTimeout(post,400);setTimeout(post,1500)})()</script>\n',
);

const MAX_BODY = 1024 * 1024;
const MAX_FILE_PREVIEW = 2 * 1024 * 1024;

/**
 * Whether a resolved (real) path is the workspace's git directory or inside it — by real path, so a
 * symlink or a differently spelled alias (`sub/../.git`, `link-to-git/config`) is caught as well.
 */
const inGitDir = (workspace: string, full: string): boolean => {
  let gitDir: string;
  try {
    gitDir = realpathSync(join(workspace, ".git"));
  } catch {
    return false;
  }
  return full === gitDir || full.startsWith(`${gitDir}${sep}`);
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolveBody({});
      try {
        resolveBody(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
};

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const TOKEN_FILE = "daemon.token";
const COOKIE = "agoryx_token";

/** The token survives daemon restarts so an open browser tab keeps working. */
export const loadOrCreateToken = (env: NodeJS.ProcessEnv = process.env): string => {
  const path = join(agoraHome(env), TOKEN_FILE);
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // create below
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
};

const cookieValue = (req: IncomingMessage, name: string): string | undefined => {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
};

const findWebDir = (): string | null => {
  try {
    const dir = join(repoRoot(), "web");
    return existsSync(join(dir, "index.html")) ? dir : null;
  } catch {
    return null;
  }
};

interface RoomHandle {
  store: RoomStore;
  engine?: RoomEngine;
  /** Why this process cannot drive the room (another agoryx process holds it). */
  lockedBy?: string;
  streams: Map<string, StreamBuffer>;
  followers: number;
  followTimer?: NodeJS.Timeout;
  /** SSE senders. They listen to the handle, not to a store, so they survive a takeover (see relay). */
  listeners: Set<(event: RoomEvent | EphemeralEvent) => void>;
  relayOff?: () => void;
}

/** Forwards the handle's current store to every SSE listener. */
const relay = (handle: RoomHandle): void => {
  handle.relayOff?.();
  handle.relayOff = handle.store.subscribe((event) => {
    for (const listener of handle.listeners) listener(event);
  });
};

/**
 * The Agoryx daemon: owns the room engines, exposes a small local HTTP API
 * (JSON + server-sent events) and serves the web UI. Bound to 127.0.0.1 only;
 * every /api call needs the token from daemon.json (or the page's meta tag).
 */
export class AgoraDaemon {
  readonly env: NodeJS.ProcessEnv;
  readonly token: string;
  private readonly options: DaemonOptions;
  private readonly rooms = new Map<string, RoomHandle>();
  private readonly log: (message: string) => void;
  private readonly runners: Partial<Record<AgentKind, AgentRunner>>;
  private readonly webDir: string | null;
  private server: Server | null = null;
  private sseClients = new Set<ServerResponse>();
  private heartbeat?: NodeJS.Timeout;
  port = 0;

  constructor(options: DaemonOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.token = loadOrCreateToken(this.env);
    this.log = options.log ?? (() => {});
    this.runners = options.runners ?? defaultRunners(this.env);
    this.webDir = options.webDir ?? findWebDir();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<DaemonInfo> {
    const wanted = this.options.port ?? DEFAULT_PORT;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : error instanceof TableOpError ? 400 : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) this.log(`error: ${error instanceof Error ? (error.stack ?? message) : message}`);
        if (!res.headersSent) sendJson(res, status, { error: message });
        else res.end();
      });
    });
    this.server = server;
    const listen = (port: number) =>
      new Promise<number>((resolveListen, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          const address = server.address();
          resolveListen(typeof address === "object" && address ? address.port : port);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
    let port: number | null = null;
    const attempts = wanted === 0 ? [0] : Array.from({ length: 20 }, (_, index) => wanted + index);
    for (const candidate of attempts) {
      try {
        port = await listen(candidate);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    if (port === null) throw new Error(`no free port in ${wanted}..${wanted + 19}`);
    this.port = port;
    this.heartbeat = setInterval(() => {
      for (const client of this.sseClients) client.write(": ping\n\n");
    }, 15_000);
    this.heartbeat.unref();
    const info: DaemonInfo = { pid: process.pid, port, url: this.url, token: this.token, startedAt: new Date().toISOString() };
    if (this.options.advertise !== false) {
      const path = daemonInfoPath(this.env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(info, null, 2), { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    this.log(`listening on ${this.url} (state: ${agoraHome(this.env)})`);
    this.watchRecentRooms();
    return info;
  }

  /**
   * Open recently active rooms right away, so what happens in the agents' own
   * sessions (exchanges, table moves) reaches them without anyone opening the room.
   */
  private watchRecentRooms(): void {
    const days = this.options.watchDays ?? 14;
    if (days <= 0) return;
    const cutoff = Date.now() - days * 86_400_000;
    for (const summary of RoomStore.list(roomsDir(this.env))) {
      if (Date.parse(summary.updatedAt) < cutoff) continue;
      try {
        this.room(summary.id);
      } catch (error) {
        this.log(`cannot watch room ${summary.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    await Promise.all(
      [...this.rooms.values()].map(async (handle) => {
        if (handle.followTimer) clearInterval(handle.followTimer);
        if (handle.engine) await handle.engine.close();
      }),
    );
    this.rooms.clear();
    await new Promise<void>((resolveClose) => (this.server ? this.server.close(() => resolveClose()) : resolveClose()));
    this.server?.closeAllConnections?.();
    if (this.options.advertise !== false) {
      const path = daemonInfoPath(this.env);
      try {
        const current = JSON.parse(readFileSync(path, "utf8")) as DaemonInfo;
        if (current.pid === process.pid && current.port === this.port) rmSync(path, { force: true });
      } catch {
        // already gone
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  private room(ref: string): RoomHandle {
    const root = roomsDir(this.env);
    let id: string;
    try {
      id = RoomStore.resolveId(root, decodeURIComponent(ref), process.cwd());
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : String(error));
    }
    const existing = this.rooms.get(id);
    if (existing) {
      if (!existing.engine) this.tryDrive(existing);
      return existing;
    }
    const store = RoomStore.open(root, id);
    const handle: RoomHandle = { store, streams: new Map(), followers: 0, listeners: new Set() };
    relay(handle);
    this.rooms.set(id, handle);
    this.tryDrive(handle);
    return handle;
  }

  /** Take over driving the room unless another process holds its lock. */
  private tryDrive(handle: RoomHandle): void {
    if (handle.engine) return;
    try {
      const fresh = RoomStore.open(roomsDir(this.env), handle.store.id);
      const engine = openEngine(fresh, {
        env: this.env,
        runners: this.runners,
        log: (message) => this.log(`[${fresh.id}] ${message}`),
        ...(this.options.opsPollMs ? { opsPollMs: this.options.opsPollMs } : {}),
      });
      // Deliver what the followed store has not read yet — including what the engine just appended on
      // opening — then move the SSE listeners over to the store that now drives the room.
      handle.store.refresh();
      handle.store = fresh;
      relay(handle);
      handle.engine = engine;
      delete handle.lockedBy;
      if (handle.followTimer) {
        clearInterval(handle.followTimer);
        delete handle.followTimer;
      }
      fresh.subscribe((event) => this.onRoomEvent(handle, event));
    } catch (error) {
      if (!(error instanceof RoomLockedError)) throw error;
      handle.lockedBy = error.message;
      handle.store.refresh();
    }
  }

  private onRoomEvent(handle: RoomHandle, event: RoomEvent | EphemeralEvent): void {
    if (event.type === "turn.stream") {
      const buffer = handle.streams.get(event.turnId) ?? { agent: event.agent, text: "" };
      buffer.text = event.reset ? event.text : buffer.text + event.text;
      handle.streams.set(event.turnId, buffer);
    } else if (event.type === "turn.ended") {
      handle.streams.delete(event.turnId);
    }
  }

  private engineFor(handle: RoomHandle): RoomEngine {
    if (!handle.engine) {
      throw new HttpError(409, `${handle.lockedBy ?? "room is not available"} — stop that agoryx process or wait until it finishes`);
    }
    return handle.engine;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private checkHost(req: IncomingMessage): void {
    const host = (req.headers.host ?? "").toLowerCase();
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    if (!allowed.includes(host)) throw new HttpError(421, "unexpected Host header");
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD") {
      const ok = allowed.some((entry) => origin.toLowerCase() === `http://${entry}`);
      if (!ok) throw new HttpError(403, "cross-origin request refused");
    }
  }

  private checkToken(req: IncomingMessage, url: URL): void {
    const header = req.headers["x-agoryx-token"];
    const given = (Array.isArray(header) ? header[0] : header) ?? cookieValue(req, COOKIE) ?? url.searchParams.get("token") ?? "";
    if (!given || !safeEqual(given, this.token)) throw new HttpError(401, "missing or wrong agoryx token (see daemon.json)");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.checkHost(req);
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    if (path === "/api/health") {
      sendJson(res, 200, { ok: true, pid: process.pid, version: 1 });
      return;
    }
    if (path.startsWith("/raw/")) {
      this.serveRaw(req, res, path);
      return;
    }
    if (path.startsWith("/api/")) {
      this.checkToken(req, url);
      await this.api(req, res, url);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    const login = url.searchParams.get("t");
    if (login !== null) {
      // `agoryx open` hands the browser the token once; it lives on as a same-site cookie.
      if (!safeEqual(login, this.token)) throw new HttpError(401, "wrong token — run `agoryx open` again");
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${COOKIE}=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    this.serveStatic(res, path);
  }

  /** Per-room capability for /raw/: lets sandboxed previews load relative assets without the cookie. */
  private rawKey(roomId: string): string {
    return createHmac("sha256", this.token).update(`raw:${roomId}`).digest("hex").slice(0, 32);
  }

  private rawBase(roomId: string): string {
    return `/raw/${encodeURIComponent(roomId)}/${this.rawKey(roomId)}/`;
  }

  private serveRaw(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    const [, , roomPart = "", key = "", ...rest] = path.split("/");
    const roomId = decodeURIComponent(roomPart);
    if (!/^[\w.-]+$/.test(roomId) || !safeEqual(key, this.rawKey(roomId))) throw new HttpError(404, "not found");
    let relPath: string;
    try {
      relPath = rest.map((part) => decodeURIComponent(part)).join("/");
    } catch {
      throw new HttpError(400, "bad path");
    }
    const handle = this.room(roomId);
    if (relPath.startsWith("~block/")) {
      this.serveBlock(req, res, handle, relPath.slice("~block/".length));
      return;
    }
    if (!relPath || relPath.endsWith("/")) relPath += "index.html";
    const full = resolveInside(handle.store.state.workspace, relPath);
    if (!full || inGitDir(handle.store.state.workspace, full)) throw new HttpError(404, "no such file in the workspace");
    if (!existsSync(full) || !statSync(full).isFile()) throw new HttpError(404, "no such file in the workspace");
    const size = statSync(full).size;
    if (size > MAX_RAW) throw new HttpError(413, "file too large to preview");
    const type = MIME[extname(full).toLowerCase()] ?? "text/plain; charset=utf-8";
    const html = type.startsWith("text/html");
    res.writeHead(200, {
      "content-type": type,
      "content-length": size + (html ? FRAME_REPORTER.length : 0),
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": RAW_CSP,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(html ? Buffer.concat([readFileSync(full), FRAME_REPORTER]) : readFileSync(full));
  }

  /** An ```html / ```svg fence from a message (m:<id>) or a proposal body (o:<id>), as its own sandboxed page. */
  private serveBlock(req: IncomingMessage, res: ServerResponse, handle: RoomHandle, spec: string): void {
    const [source = "", hash = ""] = spec.split("/");
    const colon = source.indexOf(":");
    const kind = source.slice(0, colon);
    const id = source.slice(colon + 1);
    const state = handle.store.state;
    const text =
      kind === "m" ? state.messages.find((m) => m.id === id)?.text : kind === "o" ? state.table.options.find((o) => o.id === id)?.body : undefined;
    const block = text ? findLiveBlock(text, hash) : undefined;
    if (!block) throw new HttpError(404, "no such block");
    const body = block.lang === "svg" ? Buffer.from(block.body, "utf8") : Buffer.concat([Buffer.from(block.body, "utf8"), FRAME_REPORTER]);
    res.writeHead(200, {
      "content-type": LIVE_LANGS[block.lang]!,
      "content-length": body.length,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": RAW_CSP,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  private serveStatic(res: ServerResponse, path: string): void {
    if (!this.webDir) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("agoryx daemon is running. The web UI was not found next to this build.\n");
      return;
    }
    const relative = path === "/" || !extname(path) ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const full = resolve(this.webDir, relative);
    if (!full.startsWith(`${this.webDir}${sep}`) || !existsSync(full) || !statSync(full).isFile()) {
      throw new HttpError(404, "not found");
    }
    const body = readFileSync(full);
    const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": relative === "index.html" ? "no-store" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(relative === "index.html"
        ? {
            "content-security-policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          }
        : {}),
    });
    res.end(body);
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const method = req.method ?? "GET";

    if (parts[0] === "info" && method === "GET") {
      sendJson(res, 200, {
        pid: process.pid,
        url: this.url,
        home: agoraHome(this.env),
        rooms: RoomStore.list(roomsDir(this.env)).length,
      });
      return;
    }

    if (parts[0] !== "rooms") throw new HttpError(404, "unknown endpoint");

    if (parts.length === 1) {
      if (method === "GET") {
        const rooms = RoomStore.list(roomsDir(this.env)).map((summary) => {
          const handle = this.rooms.get(summary.id);
          return handle ? { ...handle.store.summary(), driven: Boolean(handle.engine) } : summary;
        });
        sendJson(res, 200, { rooms });
        return;
      }
      if (method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const text = typeof body.text === "string" ? body.text : "";
        // A room started from its first message takes its name from it; rename it later.
        const name = typeof body.name === "string" && body.name.trim() ? body.name : text.trim() ? roomNameFrom(text) : "";
        if (!name.trim()) throw new HttpError(400, "a name or a first message is required");
        if (typeof body.doc === "string" && body.doc.trim() && !normalizeDocPath(body.doc)) {
          throw new HttpError(400, "the canonical file must be a path inside the workspace (not in .git or .agoryx)");
        }
        let store;
        try {
          store = createRoom({
            name,
            ...(typeof body.dir === "string" && body.dir.trim() ? { dir: body.dir.trim() } : {}),
            ...(typeof body.budget === "number" ? { budget: body.budget } : {}),
            ...(typeof body.human === "string" ? { human: body.human } : {}),
            // `agoryx new --doc none` sends null: no canonical file.
            ...(typeof body.doc === "string" ? { doc: body.doc.trim() || null } : body.doc === null ? { doc: null } : {}),
            env: this.env,
          });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        const handle = this.room(store.id);
        if (text.trim()) this.engineFor(handle).postHuman(text);
        sendJson(res, 201, { room: handle.store.summary() });
        return;
      }
      throw new HttpError(405, "method not allowed");
    }

    const handle = this.room(parts[1]!);
    const action = parts[2];

    if (!action && method === "GET") {
      sendJson(res, 200, this.snapshot(handle));
      return;
    }

    if (action === "events" && method === "GET") {
      this.stream(req, res, handle, Number.parseInt(url.searchParams.get("after") ?? "", 10));
      return;
    }

    if (action === "doc" && method === "GET") {
      const rev = url.searchParams.get("rev");
      sendJson(res, 200, rev ? this.docRevision(handle, Number.parseInt(rev, 10)) : this.docNow(handle));
      return;
    }

    if (action === "tree" && method === "GET") {
      sendJson(res, 200, { files: listWorkspaceFiles(handle.store.state.workspace) });
      return;
    }

    if (action === "file" && method === "GET") {
      sendJson(res, 200, this.readWorkspaceFile(handle, url.searchParams.get("path") ?? ""));
      return;
    }

    if (action === "turn-diff" && method === "GET") {
      const turnId = url.searchParams.get("turn") ?? "";
      if (!/^t\d{1,9}$/.test(turnId)) throw new HttpError(400, "bad turn id");
      const turn = handle.store.state.turns.find((entry) => entry.id === turnId);
      const result = turn ? roomTurnPatch(handle.store, turnId) : null;
      if (!turn || !result) throw new HttpError(404, "this turn changed no files");
      sendJson(res, 200, { turnId, agent: turn.agent, changes: turn.changes ?? [], ...result });
      return;
    }

    if (action === "commit" && method === "GET") {
      const sha = url.searchParams.get("sha") ?? "";
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, "bad sha");
      let text: string;
      try {
        text = execFileSync("git", ["show", "--stat", "--patch", "--no-color", "--format=%H%n%s%n%n%b", sha], {
          cwd: handle.store.state.workspace,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 10_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        throw new HttpError(404, "commit not found");
      }
      sendJson(res, 200, { sha, text: text.length > 400_000 ? `${text.slice(0, 400_000)}\n… (truncated)` : text });
      return;
    }

    if (method !== "POST") throw new HttpError(405, "method not allowed");
    const body = (await readBody(req)) as Record<string, unknown>;
    const engine = this.engineFor(handle);

    switch (action) {
      case "messages": {
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) throw new HttpError(400, "text is required");
        const message = engine.postHuman(text);
        sendJson(res, 201, { message });
        return;
      }
      case "table": {
        const seq = engine.state.seq + 1;
        const op = engine.tableOp(body);
        sendJson(res, 201, { op, seq, text: `${op.id ? `${op.id} · ` : ""}${describeTableOp(op, engine.state.table)}` });
        return;
      }
      case "continue": {
        const seq = engine.state.seq + 1;
        engine.continueRun();
        sendJson(res, 200, { ok: true, seq });
        return;
      }
      case "rename": {
        try {
          engine.rename(typeof body.name === "string" ? body.name : "");
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        sendJson(res, 200, { room: handle.store.summary() });
        return;
      }
      case "stop": {
        await engine.stop("human");
        sendJson(res, 200, { ok: true });
        return;
      }
      case "settings": {
        try {
          engine.updateSettings(body as Partial<RoomSettings>);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        sendJson(res, 200, { settings: engine.state.settings });
        return;
      }
      case "doc": {
        if (typeof body.text !== "string" || typeof body.base !== "string") throw new HttpError(400, "text and base are required");
        if (body.text.length > MAX_DOC_TEXT) throw new HttpError(413, "the text is too large");
        try {
          const revision = engine.writeDocument(body.text, body.base);
          sendJson(res, 200, { revision, ...this.docNow(handle) });
        } catch (error) {
          if (error instanceof DocConflictError) {
            sendJson(res, 409, { error: error.message, current: error.current });
            return;
          }
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      default:
        throw new HttpError(404, "unknown room action");
    }
  }

  private snapshot(handle: RoomHandle) {
    const ops = handle.store
      .since(0)
      .flatMap((event) => (event.type === "table.op" ? [{ seq: event.seq, ts: event.ts, op: event.op }] : []));
    return {
      ...roomSnapshot(handle.store.state, handle.streams),
      presence: this.presence(handle),
      ops,
      rawBase: this.rawBase(handle.store.id),
      resume: resumeCommands(handle.store, this.runners),
      driven: Boolean(handle.engine),
      ...(handle.lockedBy ? { lockedBy: handle.lockedBy } : {}),
    };
  }

  /** The canonical file as it is on disk now. */
  private docNow(handle: RoomHandle) {
    const state = handle.store.state;
    const path = state.settings.doc;
    if (!path) throw new HttpError(404, "this room has no canonical file");
    const now = readDoc(state.workspace, path);
    return { path, text: now?.text ?? "", hash: now?.hash ?? docHash(""), exists: Boolean(now) };
  }

  /** One recorded revision, with its diff against the one before it. */
  private docRevision(handle: RoomHandle, seq: number) {
    const state = handle.store.state;
    const index = state.docRevisions.findIndex((revision) => revision.seq === seq);
    if (index < 0) throw new HttpError(404, "no such revision");
    const revision = state.docRevisions[index]!;
    const textAt = (at: number): string | null | undefined => {
      const event = handle.store.events.find((entry) => entry.seq === at);
      return event?.type === "doc.revised" ? event.text : undefined;
    };
    let previous: DocRevision | undefined;
    for (let k = index - 1; k >= 0; k -= 1) {
      if (state.docRevisions[k]!.path === revision.path) {
        previous = state.docRevisions[k];
        break;
      }
    }
    const text = textAt(revision.seq);
    const before = previous && !previous.deleted ? textAt(previous.seq) : "";
    const diff =
      text === undefined || before === undefined ? null : diffHunks(diffLines(before ?? "", text ?? ""), 3);
    return { revision, previous: previous?.seq ?? null, text: text ?? null, truncated: text === undefined, diff };
  }

  /** The event log knows who runs a room turn; only the driving engine knows who is busy in its own session. */
  private presence(handle: RoomHandle): Record<string, AgentPresence> {
    const logged = presenceOf(handle.store.state);
    const live = handle.engine?.presence();
    if (!live) return logged;
    return Object.fromEntries(Object.entries(logged).map(([id, value]) => [id, value === "working" ? value : (live[id] ?? value)]));
  }

  private readWorkspaceFile(handle: RoomHandle, relPath: string) {
    const root = handle.store.state.workspace;
    const full = relPath === ".agoryx/TABLE.md" ? join(root, ".agoryx", "TABLE.md") : resolveInside(root, relPath);
    if (!full || inGitDir(root, full) || !existsSync(full)) throw new HttpError(404, "no such file in the workspace");
    const stats = statSync(full);
    if (!stats.isFile()) throw new HttpError(400, "not a file");
    // Only the preview is read: a multi-gigabyte file must not be loaded to show its first 2 MB.
    const buffer = Buffer.alloc(Math.min(stats.size, MAX_FILE_PREVIEW));
    const fd = openSync(full, "r");
    let length = 0;
    try {
      while (length < buffer.length) {
        const read = readSync(fd, buffer, length, buffer.length - length, length);
        if (read === 0) break;
        length += read;
      }
    } finally {
      closeSync(fd);
    }
    const preview = buffer.subarray(0, length);
    const binary = preview.subarray(0, 8000).includes(0);
    return {
      path: relPath,
      size: stats.size,
      mtime: stats.mtime.toISOString(),
      binary,
      truncated: stats.size > length,
      text: binary ? "" : preview.toString("utf8"),
    };
  }

  private stream(req: IncomingMessage, res: ServerResponse, handle: RoomHandle, after: number): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1500\n\n");
    const send = (event: RoomEvent | EphemeralEvent) => {
      if (event.type === "turn.stream") {
        res.write(`event: stream\ndata: ${JSON.stringify(event)}\n\n`);
        return;
      }
      if (event.type === "presence") {
        res.write(`event: presence\ndata: ${JSON.stringify({ agents: this.presence(handle) })}\n\n`);
        return;
      }
      const state = handle.store.state;
      const patch = { ...eventPatch(state, event), presence: this.presence(handle) };
      res.write(`id: ${event.seq}\nevent: room\ndata: ${JSON.stringify({ event, patch })}\n\n`);
    };
    const start = Number.isFinite(after) ? after : handle.store.state.seq;
    for (const event of handle.store.since(start)) send(event);
    // Text streamed since the client's snapshot is not in the log: resend each live turn's whole buffer as a reset.
    for (const [turnId, buffer] of handle.streams) send({ type: "turn.stream", turnId, agent: buffer.agent, text: buffer.text, reset: true });
    // Who is busy right now, including in their own sessions (not in the log, so not replayed above).
    res.write(`event: presence\ndata: ${JSON.stringify({ agents: this.presence(handle) })}\n\n`);
    handle.listeners.add(send);
    const unsubscribe = () => handle.listeners.delete(send);
    this.sseClients.add(res);
    handle.followers += 1;
    if (!handle.engine && !handle.followTimer) {
      // Another process drives this room: follow its event log.
      handle.followTimer = setInterval(() => {
        try {
          handle.store.refresh();
          if (!runningTurnsPresence(handle.store.state).some(Boolean)) this.tryDrive(handle);
        } catch {
          // keep following
        }
      }, 700);
      handle.followTimer.unref();
    }
    req.on("close", () => {
      unsubscribe();
      this.sseClients.delete(res);
      handle.followers -= 1;
      if (handle.followers <= 0 && handle.followTimer) {
        clearInterval(handle.followTimer);
        delete handle.followTimer;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Finding a running daemon
// ---------------------------------------------------------------------------

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const readDaemonInfo = (env: NodeJS.ProcessEnv = process.env): DaemonInfo | null => {
  const path = daemonInfoPath(env);
  if (!existsSync(path)) return null;
  try {
    const info = JSON.parse(readFileSync(path, "utf8")) as DaemonInfo;
    if (!info.pid || !info.port || !info.token || !pidAlive(info.pid)) return null;
    return info;
  } catch {
    return null;
  }
};

/** A daemon that is alive and answers /api/health, or null. */
export const findDaemon = async (env: NodeJS.ProcessEnv = process.env): Promise<DaemonInfo | null> => {
  const info = readDaemonInfo(env);
  if (!info) return null;
  try {
    const response = await fetch(`${info.url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const health = (await response.json()) as { pid?: number };
    return health.pid === info.pid ? info : null;
  } catch {
    return null;
  }
};
