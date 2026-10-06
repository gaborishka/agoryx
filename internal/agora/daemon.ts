import { conversationMaterials } from "./workflow-handoff.js";
import { workflowIndexEntry } from "./workflow-index.js";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, createReadStream, existsSync, watch, type FSWatcher, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBehind } from "./agentprocs.js";
import { AttentionBoard, parseView } from "./attention.js";
import { BrowserFailure, BrowserRelay, sseHost } from "./browser.js";
import { AGENT_KEY_ENV, actorIn, agentKey, isAgentKey, loadOrCreateToken, originName, originOf, readAgentKey } from "./actor.js";
import { findLiveBlock, LIVE_LANGS } from "./blocks.js";
import { type AgentPatch, DocConflictError, DocTooLargeError, RoomEngine, RoomLockedError, roomTurnPatch, roomWorkspaceDiff } from "./engine.js";
import { planRevert, RevertError, type RevertRequest } from "./revert.js";
import { GhError, GithubUnavailable } from "./github.js";
import { planStepCommit, StepCommitError } from "./step-commit.js";
import { deviceLabel, DeviceRegistry, formatCode, isDeviceToken, PairingError, type DeviceInfo } from "./devices.js";
import { lanInterfaces, normalizeHosts, writeExposure, type Exposure } from "./exposure.js";
import { linkedMedia, markdownTexts } from "./media.js";
import { MAX_UPLOAD, saveUpload, UploadError, uploadsDir } from "./uploads.js";
import { projectOverview } from "./overview.js";
import { agentModels } from "./models.js";
import { roomSkills, resolveSkillInvocation } from "./skills.js";
import { locateNativeSession } from "./native.js";
import { readLimits, recordLimits } from "./limits-store.js";
import { roomUsage } from "./usage.js";
import { cacheControl, pickEncoding, staticBody } from "./static.js";
import { readTranscript } from "./transcript.js";
import { readTurnActivity, turnSession } from "./turn-activity.js";
import { agoraHome, daemonInfoPath, DEFAULT_PORT, roomsDir } from "./paths.js";
import type { DaemonInfo } from "./daemoninfo.js";
import { MAX_PROFILE_CHARS, profilePath, readProfile } from "./profile.js";
import { addLibraryFile, addProjectContext, checkContextFolder, listProjects, MAX_PROJECT_TEXT, PROJECT_FIELDS, ProjectError, projectHash, projectKey, projectKeyOfFolder, readProject, removeLibraryFile, removeProjectContext, setProjectFields, type Project, type ProjectWriter } from "./projects.js";
import { memoryPath, noteMemory, promoteToMemory, removeMemory, reviseMemory, StaleMemoryError } from "./memory.js";
import { parseSubscription, PushNotes, PushSender } from "./push.js";
import { qrSvg } from "./qr.js";
import { defaultRoster, parseAgents, rosterPath, RosterError } from "./roster.js";
import { eventPatch, presenceOf, roomSnapshot, runningTurnsPresence, type StreamBuffer } from "./snapshot.js";
import type { AgentRunner } from "./runners/types.js";
import { folderGit, listFolder, parentFolder, resolveFolder } from "./folders.js";
import { workspaceAt } from "./room-mode.js";
import { changeRoomMode, createRoom, defaultHumanName, defaultRunners, openEngine, resumeCommands, roomNameFrom } from "./service.js";
import { deliverWaitingReports, hasWaitingReports, queueThreadReport, threadReport } from "./threads.js";
import { RoomStore } from "./store.js";
import { isWorkTableEvent } from "./work-table.js";
import { describeTableOp, TableOpError } from "./table.js";
import { TableAssistError } from "./table-assist.js";
import type { Actor, ActorOrigin, AgentKind, AgentPresence, DocRevision, EphemeralEvent, LimitSnapshot, RoomAgent, RoomEvent, RoomSettings, RoomState } from "./types.js";
import { diffHunks, diffLines, docHash, MAX_DOC_TEXT, normalizeDocPath, readDoc } from "./doc.js";
import { TerminalError, TerminalHub } from "./terminal.js";
import { isGitRepo, listWorkspaceFiles, repoRoot, readCheckpoint, resolveInside, workspacePaths, workspaceTracking } from "./workspace.js";
import { WorkflowService } from "./workflows.js";
import { createWorkflowExecutor, workflowIsolationCapability } from "./workflow-executor.js";
import type { WorkflowAction, WorkflowExecutor, WorkflowMode, WorkflowRole, WorkflowStartInput } from "./workflow-types.js";
import { artifactPreviewDocument, parseWorkflowArtifacts, visualArtifact } from "./workflow-artifacts.js";

export interface DaemonOptions {
  env?: NodeJS.ProcessEnv;
  port?: number;
  runners?: Partial<Record<AgentKind, AgentRunner>>;
  /** Isolated workflow runner. Injected in deterministic integration tests; never a room runner. */
  workflowExecutor?: WorkflowExecutor;
  workflowCapability?: () => Promise<{ available: boolean; reason?: string; backend?: string; providers?: Partial<Record<AgentKind, { available: boolean; reason?: string }>> }>;
  log?: (message: string) => void;
  /** Directory with the web UI; defaults to <repo>/web. */
  webDir?: string;
  /** Write daemon.json so the CLI can find us (default true). */
  advertise?: boolean;
  opsPollMs?: number;
  /** Rooms active within this many days are opened at start, so their native sessions are watched (default 14; 0 = lazily only). */
  watchDays?: number;
  /**
   * POST /api/down: what stops the daemon (the process running it exits). Default: the daemon closes.
   * `by` is who asked, recorded in each room whose run it stops.
   */
  onDown?: (by: ActorOrigin | null) => void;
  /**
   * Also listen on this computer's LAN addresses, for a paired phone: true takes the private IPv4
   * addresses of its Wi-Fi and Ethernet (not VPN tunnels or VM bridges; exposure.ts), or name them. Off
   * by default: the daemon binds 127.0.0.1 only.
   */
  lan?: boolean | string[];
  /**
   * Host names an HTTPS proxy in front of the daemon serves it under — Tailscale serve's
   * `<machine>.<tailnet>.ts.net`. Requests naming any other host are refused (DNS rebinding).
   */
  hosts?: string[];
  /** Web Push: how notifications are sent (tests), and whether an http endpoint is taken (tests only). */
  pushFetch?: typeof fetch;
  pushAllowHttp?: boolean;
}

/**
 * Who is calling the API: the human (the daemon's token on this computer, or a paired device's token),
 * or an agent with its key (see actor.ts).
 */
type Caller = { agent: null; device?: DeviceInfo } | { agent: ActorOrigin };

/** How a request reached the daemon: on this computer (loopback), over the LAN, or through an HTTPS proxy. */
interface Reach {
  /** Loopback socket and loopback Host: the only place the daemon's own token works. */
  local: boolean;
  /** Served over HTTPS by a proxy (Tailscale serve): cookies get Secure, and push can work. */
  secure: boolean;
}

export { lanAddresses } from "./exposure.js";

/** The addresses `lan` asks for, with the interface each is on (when known). */
const lanTargets = (lan: boolean | string[] | undefined): Array<{ address: string; iface?: string }> =>
  lan === true ? lanInterfaces() : Array.isArray(lan) ? lan.map((address) => ({ address })) : [];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The response also closes the connection (the request's body was not read to its end). */
    readonly closeConnection = false,
    /** More for the page than the message: what is there now, on a conflict. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
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
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mov": "video/quicktime",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".tsv": "text/plain; charset=utf-8",
  ".mmd": "text/plain; charset=utf-8",
  ".mermaid": "text/plain; charset=utf-8",
};

const MAX_RAW = 25 * 1024 * 1024;
/** A /raw/ capability for a project's own files, not a room's: `~project-<hash>`. */
const PROJECT_RAW = "~project-";
/** How often a thread's report waiting for its busy room is tried again. */
const REPORT_RETRY_MS = 2_000;
/** Video and audio stream in ranges, so they may be larger. */
const MAX_RAW_MEDIA = 512 * 1024 * 1024;

/** "bytes=a-b" → the inclusive range, null without a (usable) header, "bad" when unsatisfiable. */
export const parseRange = (header: string | undefined, size: number): { start: number; end: number } | null | "bad" => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start > end || start >= size ? "bad" : { start, end };
};
/**
 * Workspace files are agent-authored: serve them as sandboxed documents with an
 * opaque origin, so an agent's HTML can run its own scripts but can never talk
 * to the daemon API with the human's cookie.
 */
const RAW_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; frame-ancestors 'self'";

/**
 * Appended to html the page embeds: reports the document's height to the page
 * so a live block is as tall as its content, and takes the room's theme as
 * --agoryx-* custom properties (plus data-theme on <html>): it asks the page
 * for the theme as soon as it runs, and the page sends it again on load and
 * whenever the reader switches light and dark. The URL and its hash stay the
 * page's own. The frame stays sandboxed; this only sends a number and a
 * request up and accepts colour values down.
 */
const FRAME_REPORTER = Buffer.from(
  // The content's own height, not the viewport's: scrollHeight never drops below the frame, so a frame could only grow.
  '\n<script>(()=>{const theme=t=>{if(!t||typeof t!=="object")return;const r=document.documentElement;r.dataset.theme=t.dark?"dark":"light";const v=t.vars&&typeof t.vars==="object"?t.vars:{};for(const k in v)if(/^--agoryx-[a-z0-9-]+$/.test(k))r.style.setProperty(k,String(v[k]).replace(/[;{}<>]/g,""))};addEventListener("message",e=>{if(e.source===parent&&e.data&&e.data.agoryxTheme)theme(e.data.agoryxTheme)});parent.postMessage({agoryxFrame:1,theme:1},"*");let last=0;const size=()=>{const d=document.documentElement,b=document.body;if(!b)return d.scrollHeight;const m=parseFloat(getComputedStyle(b).marginBottom)||0;let h=b.getBoundingClientRect().bottom+m;for(const el of b.children){const r=el.getBoundingClientRect();if(r.bottom>h)h=r.bottom}return h};const post=()=>{const h=Math.ceil(size()+scrollY);if(Math.abs(h-last)>2){last=h;parent.postMessage({agoryxFrame:1,h},"*")}};addEventListener("load",post);try{const o=new ResizeObserver(post);o.observe(document.documentElement);document.body&&o.observe(document.body)}catch{}setTimeout(post,400);setTimeout(post,1500)})()</script>\n',
);

const MAX_BODY = 1024 * 1024;
const MAX_FILE_PREVIEW = 2 * 1024 * 1024;
const hashOf = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

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

/**
 * Where a save lands, by real path: a file that does not exist yet is placed under its nearest existing folder,
 * which must itself be inside the workspace (a symlinked folder must not lead out).
 */
const resolveForWrite = (root: string, relPath: string): string | null => {
  const cleaned = relPath.replace(/^\/+/, "");
  const full = resolve(root, cleaned);
  if (full === root || !full.startsWith(`${root}${sep}`)) return null;
  const rest: string[] = [];
  let at = full;
  while (!existsSync(at)) {
    rest.unshift(basename(at));
    at = dirname(at);
  }
  const real = resolveInside(root, at === root ? "." : at.slice(root.length + 1));
  return real ? join(real, ...rest) : null;
};

const readBody = (req: IncomingMessage, limit = MAX_BODY): Promise<unknown> =>
  new Promise((resolveBody, reject) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Keep nothing more, but let the rest drain instead of resetting the socket, so the client reads the
        // 413; the error response closes the connection.
        over = true;
        chunks.length = 0;
        req.off("data", onData);
        req.resume();
        reject(new HttpError(413, "request body too large", true));
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (over) return;
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

const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
};

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const LEGACY_COOKIE = "agoryx_token";

const loginCookie = (name: string, token: string, maxAge: number, secure: boolean): string =>
  `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

const cookieValue = (req: IncomingMessage, name: string): string | undefined => {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(rest.join("=")); } catch { return ""; }
    }
  }
  return undefined;
};

/**
 * Who claims a pairing code, for its rate limit. Through the HTTPS proxy (Tailscale serve) every request
 * comes from 127.0.0.1, so the client's address is the last X-Forwarded-For entry, the one the proxy
 * added itself (a client can put anything in front of it).
 */
const claimantAddress = (req: IncomingMessage, reach: Reach): string => {
  const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "")).split(",").pop()?.trim();
  const viaProxy = reach.secure && (peer === "::1" || peer.startsWith("127."));
  return viaProxy && last ? `via-proxy:${last}` : peer;
};

/** The built React UI (ui/dist, `npm run build:ui`) wins; the plain page in web/ is the fallback. */
const findWebDir = (): string | null => {
  try {
    const root = repoRoot();
    return [join(root, "ui", "dist"), join(root, "web")].find((dir) => existsSync(join(dir, "index.html"))) ?? null;
  } catch {
    return null;
  }
};

interface RoomHandle {
  changingMode?: boolean;
  stoppingWorkflow?: boolean;
  store: RoomStore;
  engine?: RoomEngine;
  /** Why this process cannot drive the room (another agoryx process holds it). */
  lockedBy?: string;
  streams: Map<string, StreamBuffer>;
  followers: number;
  followTimer?: NodeJS.Timeout;
  /** Whether the folder was a git repository when last asked, and the watch that asks again while someone looks. */
  gitRepo?: boolean;
  gitWatch?: FSWatcher;
  /** SSE senders. They listen to the handle, not to a store, so they survive a takeover (see relay). */
  listeners: Set<(event: RoomEvent | EphemeralEvent) => void>;
  relayOff?: () => void;
}

/** Asks git again; tells the room's pages when the answer changed. */
const lookAtGit = (handle: RoomHandle): void => {
  const now = isGitRepo(handle.store.state.workspace);
  if (now === handle.gitRepo) return;
  handle.gitRepo = now;
  for (const listener of handle.listeners) listener({ type: "git", gitRepo: now });
};

/** Forwards the handle's current store to every SSE listener. */
const relay = (handle: RoomHandle): void => {
  handle.relayOff?.();
  handle.relayOff = handle.store.subscribe((event) => {
    for (const listener of handle.listeners) listener(event);
    // An agent may have made the folder a repository (or a parent of it) during its turn: asked once per turn,
    // and only while someone has the room open.
    if (event.type === "turn.ended" && handle.followers > 0) lookAtGit(handle);
  });
};

/**
 * The Agoryx daemon: owns the room engines, exposes a small local HTTP API
 * (JSON + server-sent events) and serves the web UI. Bound to 127.0.0.1 unless
 * told to listen on the LAN too (`agoryx up --lan`); every /api call needs the
 * token from daemon.json on this computer, or a paired device's token (devices.ts).
 */

/** This install's version, from the package.json above this file (source and dist alike); null if none is found. */
let version: string | null | undefined;
const agoryxVersion = (): string | null => {
  if (version !== undefined) return version;
  version = null;
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (parsed.name === "agoryx") {
        version = parsed.version ?? null;
        break;
      }
    } catch {
      // Not here: one folder up.
    }
  }
  return version;
};

export class AgoraDaemon {
  readonly env: NodeJS.ProcessEnv;
  readonly token: string;
  /** Cookies are host-scoped, not port-scoped. Keep parallel local daemons independent. */
  private readonly cookieName: string;
  private readonly options: DaemonOptions;
  private readonly rooms = new Map<string, RoomHandle>();
  /** Where each agent session's file was found (room, agent, session id → path). */
  private readonly sessionFiles = new Map<string, string>();
  private readonly log: (message: string) => void;
  private readonly runners: Partial<Record<AgentKind, AgentRunner>>;
  private readonly webDir: string | null;
  private server: Server | null = null;
  /** The same handler on the LAN addresses (`lan`), by address. */
  private readonly lanServers = new Map<string, Server>();
  private lanBound: string[] = [];
  private httpsHosts: string[];
  private handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  private sseClients = new Set<ServerResponse>();
  /** Each paired device's open event streams, ended when it is revoked. */
  private readonly deviceStreams = new Map<string, Set<ServerResponse>>();
  /** Paired phones (devices.ts) and the notifications they asked for (push.ts). */
  readonly devices: DeviceRegistry;
  private readonly push: PushSender;
  /** What each push said: the phone fetches it (push.ts), so a push the daemon did not send shows nothing. */
  private readonly pushNotes = new PushNotes();
  private heartbeat?: NodeJS.Timeout;
  /** Rooms with thread reports waiting while another process drives them: tried again until they can take them. */
  private reportsWaiting = new Set<string>();
  private reportRetry?: NodeJS.Timeout;
  /** Which rooms wait for the human (attention.ts). */
  private readonly attention: AttentionBoard;
  /** The room's browser: agents' commands to the app's pane (browser.ts). */
  private readonly browser: BrowserRelay;
  /** The human's terminals in rooms' folders (terminal.ts), reached over a WebSocket. */
  private readonly terminals: TerminalHub;
  private readonly workflows: WorkflowService;
  private closing = false;
  private workflowProbe?: { at: number; value: ReturnType<NonNullable<DaemonOptions["workflowCapability"]>> };
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  port = 0;

  constructor(options: DaemonOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.token = loadOrCreateToken(this.env);
    this.cookieName = `${LEGACY_COOKIE}_${createHash("sha256").update(this.token).digest("hex").slice(0, 24)}`;
    this.log = options.log ?? (() => {});
    this.devices = new DeviceRegistry({ env: this.env });
    this.push = new PushSender({
      env: this.env,
      devices: this.devices,
      notes: this.pushNotes,
      log: this.log,
      ...(options.pushFetch ? { fetch: options.pushFetch } : {}),
    });
    this.httpsHosts = normalizeHosts(options.hosts ?? []);
    this.attention = new AttentionBoard({
      env: this.env,
      log: this.log,
      // A room starts waiting: the phones that asked for it are told.
      onRaise: (item) => {
        if (this.devices.pushTargets().length > 0) void this.push.notify(item);
      },
    });
    this.browser = new BrowserRelay({ log: (line) => this.log(line) });
    this.terminals = new TerminalHub(this.env);
    this.runners = options.runners ?? defaultRunners(this.env);
    this.workflows = new WorkflowService({
      stateDir: join(agoraHome(this.env), "workflows"),
      execute: options.workflowExecutor ?? createWorkflowExecutor({ env: this.env }),
      onChange: (roomId) => this.workflowChanged(roomId),
    });
    this.webDir = options.webDir ?? findWebDir();
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Where a phone reaches the daemon: HTTPS proxy names first (push works there), then the LAN addresses. */
  reachUrls(): Array<{ url: string; kind: "https" | "lan" }> {
    return [
      ...this.httpsHosts.map((host) => ({ url: `https://${host}`, kind: "https" as const })),
      ...this.lanBound.map((address) => ({ url: `http://${address}:${this.port}`, kind: "lan" as const })),
    ];
  }

  /** How the running daemon is reachable besides this computer. */
  exposure(): Exposure & { addresses: string[] } {
    return { lan: this.lanBound.length > 0, hosts: [...this.httpsHosts], addresses: [...this.lanBound] };
  }

  /**
   * Changes how the running daemon is reachable, without a restart: LAN listeners are opened or closed
   * on the same port, and the HTTPS proxy names replaced. `agoryx up --lan` (or --local) on a running
   * daemon, and the phone dialog's button, come here (through /api/exposure, which saves the choice).
   */
  async setExposure(exposure: { lan: boolean | string[]; hosts: string[] }): Promise<Exposure & { addresses: string[] }> {
    if (!this.server || !this.handler) throw new Error("the daemon is not running");
    const targets = lanTargets(exposure.lan);
    const wanted = new Set(targets.map((target) => target.address));
    for (const [address, server] of this.lanServers) {
      if (wanted.has(address)) continue;
      this.lanServers.delete(address);
      server.close();
      server.closeAllConnections?.();
      this.log(`phones: stopped listening on ${address}`);
    }
    for (const { address, iface } of targets) {
      if (this.lanServers.has(address)) continue;
      const server = this.serverFor(this.handler);
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(this.port, address, () => {
          server.off("error", reject);
          resolveListen();
        });
      }).catch((error: unknown) => {
        throw new HttpError(409, `cannot listen on ${address}:${this.port}: ${error instanceof Error ? error.message : String(error)}`);
      });
      this.lanServers.set(address, server);
      this.log(`phones: http://${address}:${this.port}${iface ? ` (${iface})` : ""} — pair one with \`agoryx pair\``);
    }
    this.lanBound = [...this.lanServers.keys()];
    const hosts = normalizeHosts(exposure.hosts);
    for (const host of hosts) if (!this.httpsHosts.includes(host)) this.log(`phones: https://${host} — pair one with \`agoryx pair\``);
    this.httpsHosts = hosts;
    if (exposure.lan && this.lanBound.length === 0) this.log("--lan: no Wi-Fi or Ethernet address on this computer; listening on this computer only");
    return this.exposure();
  }

  /** One listener: the handler, and WebSocket upgrades (the terminals) checked as the API is. */
  private serverFor(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
    const server = createServer(handler);
    server.on("upgrade", (req, socket, head) => {
      this.upgrade(req, socket, head).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : error instanceof TerminalError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) this.log(`error: ${error instanceof Error ? (error.stack ?? message) : message}`);
        if (socket.writable) socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Error"}\r\nconnection: close\r\ncontent-type: text/plain\r\n\r\n${message}`);
        socket.destroy();
      });
    });
    return server;
  }

  /**
   * GET /api/rooms/<room>/terminals/<id>/socket as a WebSocket: the human's page and one terminal. Host,
   * Origin and token are checked as for the API; an agent's key is refused, and so is the human's token
   * from an agent's process.
   */
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on("error", () => {});
    if (req.headers["x-agoryx-pane"] !== undefined) throw new HttpError(403, "the room's browser cannot open Agoryx itself");
    const url = new URL(req.url ?? "/", this.url);
    const reach = this.checkHost(req, url.pathname);
    // A WebSocket always says where it comes from: a page elsewhere must not reach a shell.
    if (!req.headers.origin) throw new HttpError(403, "a terminal needs the Agoryx page");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 6 || parts[0] !== "api" || parts[1] !== "rooms" || parts[3] !== "terminals" || parts[5] !== "socket") throw new HttpError(404, "unknown endpoint");
    const caller = this.checkToken(req, url, reach);
    if (caller.agent) throw new HttpError(403, "terminals are the human's: an agent has its own shell");
    await this.refuseHumanTokenFromAgent(req);
    const handle = this.room(parts[2]!);
    const room = handle.store.state.id;
    const id = decodeURIComponent(parts[4]!);
    // Unknown terminal: refused before the upgrade, so the page can tell it is gone.
    if (!this.terminals.list(room).some((t) => t.id === id)) throw new TerminalError("no such terminal in this room", 404);
    this.sockets.handleUpgrade(req, socket, head, (ws) => {
      let detach: (() => void) | null = null;
      try {
        detach = this.terminals.attach(room, id, (message) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
          if (message.t === "closed") ws.close(1000, "closed");
        });
      } catch {
        ws.close(4404, "no such terminal");
        return;
      }
      ws.on("message", (data, binary) => {
        if (binary) return;
        try {
          this.terminals.receive(room, id, JSON.parse(data.toString()));
        } catch {
          // a closed terminal, or not JSON
        }
      });
      ws.on("close", () => detach?.());
      ws.on("error", () => detach?.());
    });
  }

  async start(): Promise<DaemonInfo> {
    const wanted = this.options.port ?? DEFAULT_PORT;
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      this.handle(req, res).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : error instanceof TableAssistError ? error.status : error instanceof TableOpError ? 400 : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (status >= 500) this.log(`error: ${error instanceof Error ? (error.stack ?? message) : message}`);
        const close: Record<string, string> = error instanceof HttpError && error.closeConnection ? { connection: "close" } : {};
        if (!res.headersSent) sendJson(res, status, { ...(error instanceof HttpError ? error.extra : undefined), error: message }, close);
        else res.end();
      });
    };
    this.handler = handler;
    const server = this.serverFor(handler);
    this.server = server;
    const targets = lanTargets(this.options.lan);
    const lan = targets.map((target) => target.address);
    // Not fatal: a daemon the app restarts while the Mac is off Wi-Fi still serves this computer.
    if (this.options.lan && lan.length === 0) this.log("--lan: no Wi-Fi or Ethernet address on this computer; listening on this computer only");
    const listen = (port: number, target: Server = server, host = "127.0.0.1") =>
      new Promise<number>((resolveListen, reject) => {
        const onError = (error: NodeJS.ErrnoException) => {
          target.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          target.off("error", onError);
          const address = target.address();
          resolveListen(typeof address === "object" && address ? address.port : port);
        };
        target.once("error", onError);
        target.once("listening", onListening);
        target.listen(port, host);
      });
    let port: number | null = null;
    const attempts = wanted === 0 ? [0] : Array.from({ length: 20 }, (_, index) => wanted + index);
    for (const candidate of attempts) {
      try {
        port = await listen(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        continue;
      }
      // The LAN addresses take the same port, or the next candidate is tried for all of them.
      const bound = new Map<string, Server>();
      try {
        for (const address of lan) {
          const extra = this.serverFor(handler);
          await listen(port, extra, address);
          bound.set(address, extra);
        }
        for (const [address, extra] of bound) this.lanServers.set(address, extra);
        this.lanBound = lan;
        break;
      } catch (error) {
        for (const extra of bound.values()) extra.close();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        port = null;
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || wanted === 0) throw error;
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
    const ifaces = new Map(targets.map((target) => [target.address, target.iface]));
    for (const { url } of this.reachUrls()) {
      const iface = ifaces.get(new URL(url).hostname);
      this.log(`phones: ${url}${iface ? ` (${iface})` : ""} — pair one with \`agoryx pair\``);
    }
    this.watchRecentRooms();
    // Reports left waiting for a room busy elsewhere, by this daemon before it stopped or by a terminal without it.
    try {
      for (const id of readdirSync(roomsDir(this.env))) if (hasWaitingReports(join(roomsDir(this.env), id))) this.waitReports(id);
    } catch {
      // no rooms yet
    }
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

  /** `by`: the agent that stopped the daemon, so each room records that its run was stopped by it. */
  async close(by?: ActorOrigin | { human: true }): Promise<void> {
    this.closing = true;
    this.workflows.dispose();
    await this.workflows.waitAll();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reportRetry) clearInterval(this.reportRetry);
    for (const client of this.sseClients) client.end();
    this.sseClients.clear();
    // The app's browser host stream is not in sseClients: end it here, or server.close() waits for it.
    this.browser.close();
    this.terminals.closeAll();
    for (const ws of this.sockets.clients) ws.terminate();
    await Promise.all(
      [...this.rooms.values()].map(async (handle) => {
        if (handle.followTimer) clearInterval(handle.followTimer);
        handle.gitWatch?.close();
        if (!handle.engine) return;
        const state = handle.engine.state;
        const actor: Actor | undefined = !by ? undefined : "human" in by ? { by: state.human } : actorIn(state, by);
        await handle.engine.close(actor);
      }),
    );
    this.attention.close();
    this.devices.close();
    this.rooms.clear();
    const servers = [this.server, ...this.lanServers.values()];
    await Promise.all(servers.map((server) => new Promise<void>((resolveClose) => (server ? server.close(() => resolveClose()) : resolveClose()))));
    for (const server of servers) server?.closeAllConnections?.();
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
      // A room already open, by its id, needs no lookup among all of them.
      const decoded = decodeURIComponent(ref);
      id = this.rooms.has(decoded) ? decoded : RoomStore.resolveId(root, decoded, process.cwd());
    } catch (error) {
      throw new HttpError(404, error instanceof Error ? error.message : String(error));
    }
    const existing = this.rooms.get(id);
    if (existing) {
      if (!existing.engine && !existing.changingMode) this.tryDrive(existing);
      return existing;
    }
    const store = RoomStore.open(root, id);
    const handle: RoomHandle = { store, streams: new Map(), followers: 0, listeners: new Set() };
    relay(handle);
    this.rooms.set(id, handle);
    this.attention.track(id, () => handle.store, handle.listeners);
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
        // Each agent's own key, signed with this daemon's token: what it does through the API is its own.
        agentKey: (agentId) => agentKey(this.token, fresh.id, agentId),
        runners: this.runners,
        log: (message) => this.log(`[${fresh.id}] ${message}`),
        onLimits: (snapshot) => this.onLimits(snapshot),
        // GitHub is asked about a room nobody has open only while a pull request of it is open.
        viewed: () => handle.followers > 0,
        scheduleBlocked: () => this.closing || Boolean(handle.stoppingWorkflow) || this.workflowBlocks(fresh.id),
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
      // Thread reports that waited while another process drove the room.
      deliverWaitingReports(fresh.dir, (report) => engine.postThreadReport(report.text, report.sys));
    } catch (error) {
      if (!(error instanceof RoomLockedError)) throw error;
      handle.lockedBy = error.message;
      handle.store.refresh();
    }
  }

  /** An agent's CLI said where its limits stand: kept, and shown to every open room (limits are the account's). */
  private onLimits(snapshot: LimitSnapshot): void {
    const limits = recordLimits(this.env, snapshot);
    if (!limits) return;
    for (const handle of this.rooms.values()) {
      for (const listener of handle.listeners) listener({ type: "limits", limits });
    }
  }

  private onRoomEvent(handle: RoomHandle, event: RoomEvent | EphemeralEvent): void {
    if (event.type === "turn.stream") {
      const buffer = handle.streams.get(event.turnId) ?? { agent: event.agent, text: "" };
      buffer.text = event.reset ? event.text : buffer.text + event.text;
      handle.streams.set(event.turnId, buffer);
    } else if (event.type === "turn.ended") {
      handle.streams.delete(event.turnId);
      // What the turn left in the room's browser is withdrawn: the pane never runs it after the turn.
      this.browser.endTurn(handle.store.id, event.agent);
    } else if (event.type === "settings.changed" && event.patch.network === false) {
      // The room's network went off, and its browser with it.
      this.browser.closeRoom(handle.store.id);
    } else if (event.type === "run.ended" && handle.store.state.parent) {
      // After the engine is done ending the run: git is asked about the thread's branch.
      setImmediate(() => this.reportThread(handle, event.runId));
    }
  }

  /**
   * A thread's run ended: its report goes into the room it was started from (threads.ts), made now — the diff as the
   * run left it. While another process drives that room (an agent's `agoryx new --from here` in a terminal), the
   * report waits in that room's folder and goes in once the room can be driven here.
   */
  private reportThread(handle: RoomHandle, runId: string): void {
    const parentId = handle.store.state.parent!;
    try {
      const parent = this.room(parentId);
      const report = threadReport(handle.store, runId, parent.store.state, roomWorkspaceDiff(handle.store)?.changes ?? []);
      if (!report) return;
      if (parent.engine) {
        parent.engine.postThreadReport(report.text, report.sys);
        return;
      }
      queueThreadReport(parent.store.dir, report);
      this.log(`[${handle.store.id}] its report waits for ${parentId}: ${parent.lockedBy ?? "the room is busy"}`);
      this.waitReports(parentId);
    } catch (error) {
      this.log(`[${handle.store.id}] cannot report to ${parentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Try `roomId` again for its waiting reports until it can take them. */
  private waitReports(roomId: string): void {
    this.reportsWaiting.add(roomId);
    this.reportRetry ??= setInterval(() => this.retryReports(), REPORT_RETRY_MS);
    this.reportRetry.unref();
  }

  private retryReports(): void {
    for (const roomId of this.reportsWaiting) {
      try {
        // Opening it drives it when it is free; driving it delivers what waits (tryDrive).
        const handle = this.room(roomId);
        if (handle.engine || !hasWaitingReports(handle.store.dir)) this.reportsWaiting.delete(roomId);
      } catch {
        this.reportsWaiting.delete(roomId);
      }
    }
    if (!this.reportsWaiting.size && this.reportRetry) {
      clearInterval(this.reportRetry);
      delete this.reportRetry;
    }
  }

  private engineFor(handle: RoomHandle): RoomEngine {
    if (handle.changingMode) throw new HttpError(409, "The room is switching modes");
    if (!handle.engine) {
      throw new HttpError(409, `${handle.lockedBy ?? "room is not available"} — stop that agoryx process or wait until it finishes`);
    }
    return handle.engine;
  }

  /** Polling the board must not repeatedly probe the OS boundary or read subscription credentials. */
  private workflowCapability(): ReturnType<NonNullable<DaemonOptions["workflowCapability"]>> {
    if (!this.workflowProbe || Date.now() - this.workflowProbe.at > 30_000) {
      const value = this.options.workflowCapability?.() ?? workflowIsolationCapability(this.env);
      this.workflowProbe = { at: Date.now(), value };
      void value.catch(() => { if (this.workflowProbe?.value === value) this.workflowProbe = undefined; });
    }
    return this.workflowProbe.value;
  }

  /** Corrupt private state must block only its own room, never dispatch a native worker over it. */
  private workflowBlocks(roomId: string): boolean {
    try { return this.workflows.isBusy(roomId); }
    catch { return true; }
  }

  private workflowChanged(roomId: string): void {
    const handle = this.rooms.get(roomId);
    if (!this.closing && !handle?.stoppingWorkflow && !this.workflowBlocks(roomId)) handle?.engine?.requestSchedule();
  }

  private assertWorkflowIdle(roomId: string): void {
    if (this.closing || this.rooms.get(roomId)?.stoppingWorkflow) throw new HttpError(409, "The room is stopping; wait until it has finished");
    if (this.workflows.isBusy(roomId)) {
      throw new HttpError(409, "Finish or stop the workflow before changing its room or starting a chat turn");
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /**
   * The Host must name this daemon — loopback, a LAN address it listens on, or an HTTPS proxy name it was
   * given — so a DNS-rebound name is refused; a request that says where it comes from (Origin) must come
   * from one of those too, for the API and for anything that is not a plain read.
   */
  private checkHost(req: IncomingMessage, path: string): Reach {
    const host = (req.headers.host ?? "").toLowerCase();
    const loopback = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    const lan = this.lanBound.map((address) => `${address}:${this.port}`);
    const https = this.httpsHosts.flatMap((name) => [name, `${name}:443`]);
    const isLoopback = loopback.includes(host);
    if (!isLoopback && !lan.includes(host) && !https.includes(host)) throw new HttpError(421, "unexpected Host header");
    const origin = req.headers.origin;
    if (origin && (path.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD"))) {
      const allowed = [...[...loopback, ...lan].map((entry) => `http://${entry}`), ...this.httpsHosts.map((name) => `https://${name}`)];
      if (!allowed.includes(origin.toLowerCase())) throw new HttpError(403, "cross-origin request refused");
    }
    const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
    return { local: isLoopback && (peer === "::1" || peer.startsWith("127.")), secure: https.includes(host) };
  }

  private checkToken(req: IncomingMessage, url: URL, reach: Reach): Caller {
    const header = req.headers["x-agoryx-token"];
    const sent = Array.isArray(header) ? header[0] : header;
    // An agent's key comes in the header only (the agent's CLI sends it); never as a browser login, never from off this computer.
    if (sent && isAgentKey(sent)) {
      if (!reach.local) throw new HttpError(401, "an agent key works on this computer only");
      return { agent: this.agentOrigin(sent) };
    }
    // A device token comes in the cookie (or the header), never in the URL.
    // Old browser/device logins remain valid until they next log in. An explicitly
    // supplied but invalid scoped cookie must not fall back to a legacy credential.
    const given = sent ?? cookieValue(req, this.cookieName) ?? cookieValue(req, LEGACY_COOKIE) ?? (reach.local ? url.searchParams.get("token") : null) ?? "";
    if (isDeviceToken(given)) {
      const device = this.devices.authenticate(given);
      if (!device) throw new HttpError(401, "this device is not paired (revoked, or a wrong token) — pair it again with `agoryx pair` on the computer");
      return { agent: null, device };
    }
    if (!reach.local) throw new HttpError(401, "from another device only a paired one gets in — pair it with `agoryx pair` on the computer");
    if (!given || !safeEqual(given, this.token)) throw new HttpError(401, "missing or wrong agoryx token (see daemon.json)");
    return { agent: null };
  }

  /**
   * The human's token, sent from an agent's process (its CLI or anything under it), is refused: agents
   * can read the token file as the human can, but what they do is signed with their own key, never as
   * the human (see agentprocs.ts).
   */
  private async refuseHumanTokenFromAgent(req: IncomingMessage): Promise<void> {
    const owner = await agentBehind(req.socket);
    if (!owner) return;
    if ("unknown" in owner) {
      throw new HttpError(
        403,
        `agent processes are running and Agoryx cannot tell whether this request comes from one of them (${owner.unknown}); the human's token is refused until it can — the daemon needs lsof and ps`,
      );
    }
    throw new HttpError(
      403,
      `this request comes from ${owner.agent}'s process (room ${owner.room}) with the human's token (or a paired device's): an agent acts under its own key (${AGENT_KEY_ENV}), never as the human`,
    );
  }

  /**
   * The agent a key names — checked, never trusted: signed with this daemon's token, for a room that
   * exists and an agent seated in it now. A key for another room still works anywhere (see actorIn):
   * what it does there is signed as that agent, from that room.
   */
  private agentOrigin(key: string): ActorOrigin {
    const named = readAgentKey(this.token, key);
    if (!named) throw new HttpError(401, "this agent key was not issued by this daemon (a stale key, or a different daemon token)");
    let state: RoomState;
    try {
      state = this.rooms.get(named.room)?.store.state ?? RoomStore.open(roomsDir(this.env), named.room).state;
    } catch {
      throw new HttpError(401, `this agent key is for room ${named.room}, which does not exist`);
    }
    const origin = originOf(state, named.agent);
    if (!origin) throw new HttpError(401, `this agent key is for ${named.agent}, who is no longer in room "${state.name}"`);
    return origin;
  }

  /** Who the caller is in a room: the human, one of its agents, or an agent of another room. */
  private actorFor(caller: Caller, state: RoomState): Actor {
    return caller.agent ? actorIn(state, caller.agent) : { by: state.human };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The room's browser pane marks every request it makes: no page it opens reaches Agoryx.
    if (req.headers["x-agoryx-pane"] !== undefined) throw new HttpError(403, "the room's browser cannot open Agoryx itself");
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    const reach = this.checkHost(req, path);
    if (path === "/api/health") {
      sendJson(res, 200, { ok: true, pid: process.pid, version: 1 });
      return;
    }
    if (path.startsWith("/raw/")) {
      this.serveRaw(req, res, path, reach);
      return;
    }
    if (path === "/api/pair/claim") {
      await this.claimPairing(req, res, reach);
      return;
    }
    if (path.startsWith("/api/")) {
      const caller = this.checkToken(req, url, reach);
      if (!caller.agent) await this.refuseHumanTokenFromAgent(req);
      await this.api(req, res, url, caller);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    const login = url.searchParams.get("t");
    if (login !== null) {
      // `agoryx open` hands the browser the token once; it lives on as a same-site cookie. On this computer only.
      if (!reach.local || !safeEqual(login, this.token)) throw new HttpError(401, "wrong token — run `agoryx open` again");
      res.writeHead(302, {
        location: "/",
        "set-cookie": loginCookie(this.cookieName, this.token, 60 * 60 * 24 * 30, false),
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    this.serveStatic(req, res, path);
  }

  /**
   * POST /api/pair/claim {code}: a phone trades a pairing code for its own token, kept as an HttpOnly
   * cookie (never in the body, never logged). No token needed; wrong codes are rate-limited (devices.ts).
   */
  private async claimPairing(req: IncomingMessage, res: ServerResponse, reach: Reach): Promise<void> {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    // A code shown on the human's screen is the human's: an agent's process cannot trade one.
    if (await agentBehind(req.socket)) throw new HttpError(403, "a pairing code is for the human's phone, not for an agent's process");
    const body = (await readBody(req, 4096)) as Record<string, unknown>;
    let claimed;
    try {
      claimed = this.devices.claim(body.code, {
        address: claimantAddress(req, reach),
        ...(typeof req.headers["user-agent"] === "string" ? { userAgent: req.headers["user-agent"] } : {}),
      });
    } catch (error) {
      // `reason` lets the phone say it in its own language.
      if (error instanceof PairingError) return sendJson(res, error.status, { error: error.message, reason: error.reason });
      throw error;
    }
    this.log(`paired a device: ${deviceLabel(claimed.device)}`);
    sendJson(res, 201, { device: claimed.device }, { "set-cookie": loginCookie(this.cookieName, claimed.token, 60 * 60 * 24 * 365, reach.secure) });
  }

  /**
   * Per-room capability for /raw/: lets sandboxed previews load relative assets without the cookie. On
   * this computer it is the room's; a paired device gets one of its own (`<device id>.<key>`), which
   * dies when the device is revoked. The computer's works only on this computer.
   */
  private rawKey(roomId: string, deviceId?: string): string {
    const mac = createHmac("sha256", this.token)
      .update(deviceId ? `raw:${deviceId}:${roomId}` : `raw:${roomId}`)
      .digest("hex")
      .slice(0, 32);
    return deviceId ? `${deviceId}.${mac}` : mac;
  }

  private rawBase(roomId: string, device?: DeviceInfo): string {
    return `/raw/${encodeURIComponent(roomId)}/${this.rawKey(roomId, device?.id)}/`;
  }

  /** Whether a /raw/ key opens this room from where the request came. */
  private rawKeyOpens(roomId: string, key: string, reach: Reach): boolean {
    const dot = key.indexOf(".");
    if (dot < 0) return reach.local && safeEqual(key, this.rawKey(roomId));
    const deviceId = key.slice(0, dot);
    return /^[0-9a-f]+$/.test(deviceId) && this.devices.has(deviceId) && safeEqual(key, this.rawKey(roomId, deviceId));
  }

  private serveRaw(req: IncomingMessage, res: ServerResponse, path: string, reach: Reach): void {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    const [, , roomPart = "", key = "", ...rest] = path.split("/");
    let roomId = "";
    try {
      roomId = decodeURIComponent(roomPart);
    } catch {
      // Not a room id; falls through to 404.
    }
    // A project's own files (its library) have a capability of their own: no room links a file added to the project.
    const project = roomId.startsWith(PROJECT_RAW) ? roomId.slice(PROJECT_RAW.length) : null;
    if (!(project === null ? /^[\w.-]+$/.test(roomId) : /^[0-9a-f]+$/.test(project)) || !this.rawKeyOpens(roomId, key, reach)) throw new HttpError(404, "not found");
    let relPath: string;
    try {
      relPath = rest.map((part) => decodeURIComponent(part)).join("/");
    } catch {
      throw new HttpError(400, "bad path");
    }
    let full: string | null;
    if (project !== null) {
      // A file in the project's library, served while it is there.
      // The UI links a path as `~abs/` + the path without its leading "/": matched the same way back, so a Windows
      // path (C:\work\a.png, no leading "/") is found as it was written.
      const ref = relPath.startsWith("~abs/") ? relPath.slice("~abs/".length) : null;
      const listed = ref === null ? undefined : listProjects(this.env).find((entry) => entry.hash === project)?.library.find((entry) => entry.path.replace(/^\//, "") === ref);
      if (!listed || !existsSync(listed.path) || !statSync(listed.path).isFile()) throw new HttpError(404, "no such file in the project's library");
      full = listed.path;
    } else {
      const handle = this.room(roomId);
      if (relPath.startsWith("~block/")) {
        this.serveBlock(req, res, handle, relPath.slice("~block/".length));
        return;
      }
      if (relPath.startsWith("~at/")) {
        const [, seqPart, ...fileParts] = relPath.split("/");
        const seq = Number(seqPart);
        if (!Number.isSafeInteger(seq) || seq < 1 || seq > handle.store.state.seq) throw new HttpError(404, "no such conversation file");
        const root = workspaceAt(handle.store.state, seq);
        full = resolveInside(root, fileParts.join("/"));
        if (!full || inGitDir(root, full) || !existsSync(full) || !statSync(full).isFile()) throw new HttpError(404, "no such conversation file");
      } else if (relPath.startsWith("~abs/")) {
        // A media file outside the workspace, served only while a text in the room links it.
        // relPath is decoded already: the path is taken as is, not decoded again.
        const ref = relPath.slice("~abs/".length);
        full = linkedMedia(markdownTexts(handle.store.state), ref.startsWith("~/") ? ref : `/${ref}`);
        if (!full) throw new HttpError(404, "no such file, or nothing in the room links it");
      } else {
        if (!relPath || relPath.endsWith("/")) relPath += "index.html";
        full = resolveInside(handle.store.state.workspace, relPath);
        if (!full || inGitDir(handle.store.state.workspace, full)) throw new HttpError(404, "no such file in the workspace");
        if (!existsSync(full) || !statSync(full).isFile()) throw new HttpError(404, "no such file in the workspace");
      }
    }
    const size = statSync(full).size;
    const type = MIME[extname(full).toLowerCase()] ?? "text/plain; charset=utf-8";
    const html = type.startsWith("text/html");
    const media = /^(video|audio)\//.test(type);
    if (size > (media ? MAX_RAW_MEDIA : MAX_RAW)) throw new HttpError(413, "file too large to preview");
    const headers = {
      "content-type": type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "same-origin",
      "content-security-policy": RAW_CSP,
    };
    if (html) {
      res.writeHead(200, { ...headers, "content-length": size + FRAME_REPORTER.length });
      res.end(req.method === "HEAD" ? undefined : Buffer.concat([readFileSync(full), FRAME_REPORTER]));
      return;
    }
    // Ranges let video and audio seek (Safari will not play them without).
    const range = parseRange(req.headers.range, size);
    if (range === "bad") {
      res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    res.writeHead(range ? 206 : 200, {
      ...headers,
      "accept-ranges": "bytes",
      "content-length": size ? end - start + 1 : 0,
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD" || !size) {
      res.end();
      return;
    }
    const stream = createReadStream(full, { start, end });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  /** An ```html / ```svg fence from a message, proposal or component (m:/o:/w:), as its own sandboxed page. */
  private serveBlock(req: IncomingMessage, res: ServerResponse, handle: RoomHandle, spec: string): void {
    const [source = "", hash = ""] = spec.split("/");
    const colon = source.indexOf(":");
    const kind = source.slice(0, colon);
    const id = source.slice(colon + 1);
    const state = handle.store.state;
    const text =
      kind === "m" ? state.messages.find((m) => m.id === id)?.text : kind === "o" ? state.table.options.find((o) => o.id === id)?.body : kind === "w" ? state.table.components?.find((w) => w.id === id)?.body : undefined;
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

  private serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    if (!this.webDir) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("agoryx daemon is running. The web UI was not found next to this build.\n");
      return;
    }
    const relative = path === "/" || !extname(path) ? "index.html" : decodeURIComponent(path).replace(/^\/+/, "");
    const full = resolve(this.webDir, relative);
    const stat = full.startsWith(`${this.webDir}${sep}`) && existsSync(full) ? statSync(full) : null;
    if (!stat?.isFile()) throw new HttpError(404, "not found");
    const encoding = pickEncoding(full, stat.size, req.headers["accept-encoding"] as string | undefined);
    const body = staticBody(full, encoding);
    const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": body.length,
      "cache-control": cacheControl(relative),
      ...(encoding ? { "content-encoding": encoding } : {}),
      vary: "accept-encoding",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(relative === "index.html"
        ? {
            "content-security-policy":
              "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
          }
        : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  /** Who a new room seats unless told otherwise, for the start screen; a broken roster file is reported, not hidden. */
  private roster(): { agents: RoomAgent[] } | { rosterError: string } {
    try {
      return { agents: defaultRoster(this.env) };
    } catch (error) {
      return { rosterError: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Projects: the folders Work rooms work in, with a name, a goal, instructions and memory that outlive one room.
   * `GET /api/projects`, `GET|PATCH /api/projects/<hash>` (a folder nothing was written for yet is named by
   * `key`, its path), `POST /api/projects/<hash>/memory` (`note` or `promote`), `PATCH|DELETE …/memory/<id>`,
   * `GET /api/projects/<hash>/overview` (its library, threads and usage, read from its rooms),
   * `POST|DELETE …/context` and `…/library` (`path`: a context folder, a file added to the library).
   * Agents write with their own key, and every write says who made it.
   */
  /**
   * New project: the name, goal and context folders written for a folder, by whoever asks. Nothing is written unless
   * all of it can be; a folder that has a name already is not written over (the caller opens it instead).
   */
  private createProject(body: Record<string, unknown>, rooms: ReturnType<typeof RoomStore.list>, caller: Caller): Project | { taken: Project } {
    const field = (name: string): string => {
      const value = body[name] ?? "";
      if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
      return value.trim();
    };
    const dir = field("dir");
    const name = field("name");
    const goal = field("goal");
    if (!dir) throw new HttpError(400, "dir: the project's folder");
    if (!name) throw new HttpError(400, "name: what to call the project");
    if (name.includes("\n")) throw new HttpError(400, "a project's name is one line");
    for (const [label, text] of [["name", name], ["goal", goal]] as const) {
      if (text.length > MAX_PROJECT_TEXT) throw new HttpError(400, `the ${label} is ${text.length} characters; at most ${MAX_PROJECT_TEXT}`);
    }
    if (body.context !== undefined && !(Array.isArray(body.context) && body.context.every((entry) => typeof entry === "string"))) {
      throw new HttpError(400, "context must be a list of folders");
    }
    let key: string;
    try {
      key = projectKeyOfFolder(resolveFolder(dir, this.env), rooms);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    const existing = readProject(key, this.env);
    if (existing.name) return { taken: existing };
    const writer: ProjectWriter = caller.agent ? { by: caller.agent.agent, from: caller.agent } : { by: defaultHumanName(this.env) };
    try {
      const context = [...new Set(((body.context as string[] | undefined) ?? []).map((path) => checkContextFolder(key, path, this.env)))];
      setProjectFields(key, goal ? { name, goal } : { name }, writer, this.env);
      for (const folder of context) addProjectContext(key, folder, writer, this.env);
    } catch (error) {
      if (error instanceof ProjectError) throw new HttpError(400, error.message);
      throw error;
    }
    return readProject(key, this.env);
  }

  private async projectsApi(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], method: string, caller: Caller): Promise<void> {
    const rooms = RoomStore.list(roomsDir(this.env));
    const keys = new Map<string, string>();
    for (const project of listProjects(this.env)) keys.set(project.hash, project.key);
    for (const room of rooms) {
      if (!room.projectHash || keys.has(room.projectHash)) continue;
      const handle = this.rooms.get(room.id);
      const state = handle ? handle.store.state : RoomStore.open(roomsDir(this.env), room.id).state;
      const key = projectKey(state);
      if (key) keys.set(room.projectHash, key);
    }
    const view = (project: Project) => ({
      hash: project.hash,
      key: project.key,
      ...(project.name ? { name: project.name } : {}),
      ...(project.goal ? { goal: project.goal } : {}),
      ...(project.instructions ? { instructions: project.instructions } : {}),
      context: project.context,
      library: project.library,
      ...(project.events.length ? { updatedAt: project.events.at(-1)!.ts } : {}),
      seq: project.seq,
      fieldsSeq: project.fieldsSeq,
      memory: project.memory,
      memoryPath: memoryPath(project.key, this.env),
      rooms: rooms.filter((room) => room.projectHash === project.hash).map((room) => room.id),
    });
    if (parts.length === 0 && method === "POST") {
      const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
      const project = this.createProject(body, rooms, caller);
      if ("taken" in project) {
        sendJson(res, 409, { error: `${project.taken.key} is the project "${project.taken.name}" already: open it`, project: view(project.taken) });
        return;
      }
      sendJson(res, 200, { project: { ...view(project), events: project.events } });
      return;
    }
    if (parts.length === 0) {
      if (method !== "GET") throw new HttpError(405, "GET or POST");
      sendJson(res, 200, { projects: [...keys.values()].map((key) => view(readProject(key, this.env))) });
      return;
    }
    const memory = parts[1] === "memory";
    const overview = parts[1] === "overview" && parts.length === 2;
    const context = parts[1] === "context" && parts.length === 2;
    const library = parts[1] === "library" && parts.length === 2;
    if (parts.length !== 1 && !(memory && parts.length <= 3) && !overview && !context && !library) throw new HttpError(404, "unknown endpoint");
    const hash = parts[0]!;
    const body = method === "GET" || method === "DELETE" ? {} : (((await readBody(req)) ?? {}) as Record<string, unknown>);
    const asked = typeof body.key === "string" ? body.key : url.searchParams.get("key");
    let key = keys.get(hash);
    if (!key && asked) {
      let folder: string;
      try {
        folder = resolveFolder(asked, this.env);
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : String(error));
      }
      if (projectHash(folder) === hash) key = folder;
    }
    if (!key) throw new HttpError(404, "no such project: no Work room works in that folder and nothing was written for it");
    const writer: ProjectWriter = caller.agent ? { by: caller.agent.agent, from: caller.agent } : { by: defaultHumanName(this.env) };
    const fail = (error: unknown): never => {
      if (error instanceof ProjectError) throw new HttpError(400, error.message);
      throw error;
    };
    const text = (value: unknown, field: string): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
      return value;
    };
    if (overview) {
      if (method !== "GET") throw new HttpError(405, "GET");
      const stateOf = (id: string): { state: RoomState; events: readonly RoomEvent[] } | null => {
        const handle = this.rooms.get(id);
        if (handle) return { state: handle.store.state, events: handle.store.since(0) };
        try {
          const store = RoomStore.open(roomsDir(this.env), id);
          return { state: store.state, events: store.since(0) };
        } catch {
          return null;
        }
      };
      const members = rooms.filter((room) => room.projectHash === hash);
      const read = members.flatMap((room) => {
        const got = stateOf(room.id);
        return got ? [{ ...got, updatedAt: room.updatedAt }] : [];
      });
      const all = new Map(read.map(({ state }) => [state.id, state]));
      for (const { state } of read) {
        if (state.parent && !all.has(state.parent)) {
          const parent = stateOf(state.parent);
          if (parent) all.set(parent.state.id, parent.state);
        }
      }
      const device = caller.agent ? undefined : caller.device;
      sendJson(res, 200, {
        ...projectOverview(read, uploadsDir(this.env), all, readProject(key, this.env)),
        // Where each room serves its files from, for this page: a library entry opens through the room that links it.
        // A file added to the project itself (no room links it) opens through the project's own: under "".
        rawBase: { ...Object.fromEntries(read.map(({ state }) => [state.id, this.rawBase(state.id, device)])), "": this.rawBase(`${PROJECT_RAW}${hash}`, device) },
      });
      return;
    }
    if (context) {
      const path = method === "DELETE" ? url.searchParams.get("path") : text(body.path, "path");
      if (!path) throw new HttpError(400, "path: the context folder");
      try {
        if (method === "POST") addProjectContext(key, path, writer, this.env);
        else if (method === "DELETE") removeProjectContext(key, path, writer, this.env);
        else throw new HttpError(405, "POST or DELETE");
      } catch (error) {
        fail(error);
      }
    } else if (library) {
      const path = method === "DELETE" ? url.searchParams.get("path") : text(body.path, "path");
      if (!path) throw new HttpError(400, "path: the file");
      try {
        if (method === "POST") addLibraryFile(key, path, writer, this.env);
        else if (method === "DELETE") removeLibraryFile(key, path, writer, this.env);
        else throw new HttpError(405, "POST or DELETE");
      } catch (error) {
        fail(error);
      }
    } else if (memory && parts.length === 2) {
      if (method !== "POST") throw new HttpError(405, "POST");
      const note = body.note as Record<string, unknown> | undefined;
      const promote = body.promote as Record<string, unknown> | undefined;
      try {
        if (note && typeof note === "object") {
          noteMemory(key, { text: text(note.text, "text") ?? "", kind: text(note.kind, "kind"), why: text(note.why, "why") }, writer, this.env);
        } else if (promote && typeof promote === "object") {
          const roomId = text(promote.room, "room") ?? caller.agent?.room;
          const ref = text(promote.ref, "ref");
          if (!roomId || !ref) throw new HttpError(400, "promote needs a room and a table ref (S3, F2, D1, Q1)");
          const state = this.rooms.get(roomId)?.store.state ?? (() => {
            try {
              return RoomStore.open(roomsDir(this.env), roomId).state;
            } catch {
              throw new HttpError(404, `no room ${roomId}`);
            }
          })();
          if (projectKey(state) !== key) throw new HttpError(400, `"${state.name}" is not a conversation of this project`);
          promoteToMemory(key, { id: state.id, name: state.name, table: state.table }, ref, writer, this.env);
        } else throw new HttpError(400, 'send { note: { text, kind?, why? } } or { promote: { room, ref } }');
      } catch (error) {
        fail(error);
      }
    } else if (memory) {
      const id = parts[2]!;
      const project = readProject(key, this.env);
      const entry = project.memory.find((item) => item.id === id.toUpperCase());
      if (!entry) throw new HttpError(404, `no memory entry ${id}`);
      // A DELETE has no body, so its version comes in the query.
      const seen = typeof body.seq === "number" ? body.seq : url.searchParams.has("seq") ? Number(url.searchParams.get("seq")) : undefined;
      try {
        // The version is checked under the project's lock, with the write: not before it, where another write could slip between.
        if (method === "PATCH") {
          const why = body.why === null ? null : text(body.why, "why");
          reviseMemory(key, entry.id, { text: text(body.text, "text"), why, kind: text(body.kind, "kind") }, writer, this.env, seen);
        } else if (method === "DELETE") removeMemory(key, entry.id, writer, this.env, seen);
        else throw new HttpError(405, "PATCH or DELETE");
      } catch (error) {
        if (error instanceof StaleMemoryError) {
          const now = readProject(key, this.env);
          sendJson(res, 409, { error: error.message, entry: error.entry, project: { ...view(now), events: now.events } });
          return;
        }
        fail(error);
      }
    } else if (method === "PATCH") {
      const project = readProject(key, this.env);
      // Against the fields' own version: a memory entry written meanwhile does not make this edit stale.
      if (typeof body.seq === "number" && body.seq !== project.fieldsSeq) {
        sendJson(res, 409, { error: "the project changed since you opened it", project: { ...view(project), events: project.events } });
        return;
      }
      const fields: Partial<Record<(typeof PROJECT_FIELDS)[number], string>> = {};
      for (const field of PROJECT_FIELDS) {
        const value = body[field];
        if (value === undefined) continue;
        if (typeof value !== "string" && value !== null) throw new HttpError(400, `${field} must be a string`);
        fields[field] = value ?? "";
      }
      try {
        setProjectFields(key, fields, writer, this.env);
      } catch (error) {
        if (error instanceof ProjectError) throw new HttpError(400, error.message);
        throw error;
      }
    } else if (method !== "GET") throw new HttpError(405, "GET or PATCH");
    const project = readProject(key, this.env);
    sendJson(res, 200, { project: { ...view(project), events: project.events }, rooms: rooms.filter((room) => room.projectHash === hash) });
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller = { agent: null }): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const method = req.method ?? "GET";

    const device = caller.agent ? undefined : caller.device;

    if (parts[0] === "info" && method === "GET") {
      sendJson(res, 200, {
        pid: process.pid,
        url: this.url,
        home: agoraHome(this.env),
        rooms: RoomStore.list(roomsDir(this.env)).length,
        version: agoryxVersion(),
        // Which paired device asks (null: this computer, or an agent).
        device: device ? { id: device.id, name: device.name } : null,
        ...this.roster(),
      });
      return;
    }

    // The human's own settings: their profile and the roster new rooms get. Never an agent's to change.
    if ((parts[0] === "profile" || parts[0] === "roster") && parts.length === 1) {
      if (method !== "GET" && caller.agent) throw new HttpError(403, `only the human changes their ${parts[0] === "profile" ? "profile" : "agents"}`);
      if (parts[0] === "profile") {
        const path = profilePath(this.env);
        if (method === "PUT") {
          const body = (await readBody(req)) as Record<string, unknown>;
          if (typeof body.text !== "string") throw new HttpError(400, "text must be a string");
          const text = body.text.replace(/\r\n/g, "\n");
          if (text.trim()) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
          } else rmSync(path, { force: true });
        } else if (method !== "GET") throw new HttpError(405, "GET or PUT");
        let text = "";
        try {
          // The file ends with a newline; the text being edited does not.
          text = readFileSync(path, "utf8").replace(/\n$/, "");
        } catch {
          // No profile yet.
        }
        sendJson(res, 200, { path, text, max: MAX_PROFILE_CHARS, truncated: readProfile(path)?.truncated ?? false });
        return;
      }
      const path = rosterPath(this.env);
      if (method === "PUT") {
        const body = (await readBody(req)) as Record<string, unknown>;
        let agents;
        try {
          agents = parseAgents(body.agents);
        } catch (error) {
          throw new HttpError(400, error instanceof RosterError ? error.message : String(error));
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify({ agents }, null, 2)}\n`);
      } else if (method === "DELETE") rmSync(path, { force: true });
      else if (method !== "GET") throw new HttpError(405, "GET, PUT or DELETE");
      sendJson(res, 200, { path, custom: existsSync(path), ...this.roster() });
      return;
    }

    if (parts[0] === "pair" || parts[0] === "devices" || parts[0] === "exposure") return this.devicesApi(req, res, parts, method, caller);
    if (parts[0] === "push") return this.pushApi(req, res, parts.slice(1), method, caller);

    // A file the human attaches to a message (picked or pasted): kept under the agora home, linked by path.
    if (parts[0] === "uploads" && parts.length === 1 && method === "POST") {
      if (caller.agent) throw new HttpError(403, "attachments are the human's: an agent links its own files");
      const body = (await readBody(req, Math.ceil(MAX_UPLOAD / 3) * 4 + 64 * 1024)) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name : "";
      if (typeof body.data !== "string") throw new HttpError(400, "data (base64) is required");
      try {
        sendJson(res, 201, { path: saveUpload(name, Buffer.from(body.data, "base64"), this.env) });
      } catch (error) {
        if (error instanceof UploadError) throw new HttpError(400, error.message);
        throw error;
      }
      return;
    }

    if (parts[0] === "models" && parts.length === 1 && method === "GET") {
      sendJson(res, 200, await agentModels(this.env));
      return;
    }

    // Picking the folder a room works in: its subfolders, and what git says about it.
    if (parts[0] === "fs" && parts.length === 1 && method === "GET") {
      const asked = url.searchParams.get("path")?.trim();
      let path: string;
      try {
        path = resolveFolder(asked || "~", this.env);
      } catch (error) {
        throw new HttpError(404, error instanceof Error ? error.message : String(error));
      }
      let dirs;
      try {
        dirs = listFolder(path);
      } catch {
        throw new HttpError(403, `cannot read ${path}`);
      }
      sendJson(res, 200, { path, parent: parentFolder(path), home: resolveFolder("~", this.env), git: folderGit(path), dirs });
      return;
    }

    if (parts[0] === "folders" && parts.length === 1 && method === "GET") {
      const seen = new Set<string>();
      const recent = [];
      for (const room of RoomStore.list(roomsDir(this.env))) {
        if (!room.folder || seen.has(room.folder)) continue;
        seen.add(room.folder);
        if (!existsSync(room.folder)) continue;
        recent.push({ path: room.folder, name: basename(room.folder) || room.folder, git: folderGit(room.folder, { branches: false }) !== null });
        if (recent.length >= 8) break;
      }
      sendJson(res, 200, { recent });
      return;
    }

    if (parts[0] === "down" && parts.length === 1 && method === "POST") {
      if (device) throw new HttpError(403, "a paired device cannot stop the daemon; stop it on the computer");
      this.log(`stopping: asked by ${caller.agent ? originName(caller.agent) : "the human"}`);
      sendJson(res, 200, { ok: true });
      const by = caller.agent;
      setImmediate(() => {
        if (this.options.onDown) this.options.onDown(by);
        else void this.close(by ?? { human: true });
      });
      return;
    }

    // What each agent's CLI last said about its subscription's limits.
    if (parts[0] === "limits" && parts.length === 1 && method === "GET") {
      sendJson(res, 200, { limits: readLimits(this.env) });
      return;
    }

    if (parts[0] === "attention") return this.attentionApi(req, res, parts.slice(1), method, caller);
    if (parts[0] === "projects") return this.projectsApi(req, res, url, parts.slice(1), method, caller);
    if (parts[0] === "browser") return this.browserApi(req, res, parts.slice(1), method, caller);

    if (parts[0] === "workflows" && parts.length === 1 && method === "GET") {
      if (caller.agent) throw new HttpError(403, "workflows are controlled and inspected by the human");
      const workflows = [];
      const unavailable: string[] = [];
      for (const room of RoomStore.list(roomsDir(this.env))) {
        try { workflows.push(...this.workflows.history(room.id).map((run) => workflowIndexEntry(run, room))); }
        catch { unavailable.push(room.id); }
      }
      workflows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      sendJson(res, 200, { workflows, unavailable });
      return;
    }

    if (parts[0] !== "rooms") throw new HttpError(404, "unknown endpoint");

    if (parts.length === 1) {
      if (method === "GET") {
        const names = new Map(listProjects(this.env).filter((project) => project.name).map((project) => [project.hash, project.name!]));
        const named = <T extends { projectHash?: string }>(summary: T): T & { projectName?: string } => {
          const name = summary.projectHash ? names.get(summary.projectHash) : undefined;
          return name ? { ...summary, projectName: name } : summary;
        };
        const rooms = RoomStore.list(roomsDir(this.env)).map(named).map((summary) => {
          const handle = this.rooms.get(summary.id);
          // What the human has not seen is the human's: an agent key never learns it.
          if (caller.agent) return handle ? { ...named(handle.store.summary()), driven: Boolean(handle.engine) } : summary;
          const current = handle ? named(handle.store.summary()) : summary;
          let protocol: ReturnType<WorkflowService["summary"]> = null;
          let workflowError: string | undefined;
          try { protocol = this.workflows.summary(summary.id); }
          catch { workflowError = "Private session record needs recovery"; }
          const workflow = protocol ? (() => { const { working: _working, ...rest } = protocol; return rest; })() : undefined;
          const unread = this.attention.unread(summary.id);
          return {
            ...current,
            activityMode: workflow && (workflow.status === "running" || workflow.status === "waiting_user" || !current.nativeActivityAt || workflow.updatedAt >= current.nativeActivityAt) ? workflow.mode : current.mode ?? "work",
            driven: Boolean(handle?.engine),
            waiting: this.attention.item(summary.id),
            ...(workflowError ? { workflowError } : {}),
            ...(unread !== undefined ? { unread } : {}),
            ...(workflow ? {
              workflow,
              updatedAt: workflow.updatedAt > current.updatedAt ? workflow.updatedAt : current.updatedAt,
              running: current.running || workflow.status === "running",
              ...(protocol!.working.length ? { working: protocol!.working } : {}),
            } : {}),
          };
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
            ...(body.projectKey !== undefined ? { projectKey: typeof body.projectKey === "string" ? projectKeyOfFolder(resolveFolder(body.projectKey, this.env), RoomStore.list(roomsDir(this.env))) : body.projectKey as null } : {}),
            ...(body.mode !== undefined ? { mode: body.mode as import("./types.js").RoomMode } : {}),
            ...(typeof body.dir === "string" && body.dir.trim() ? { dir: resolveFolder(body.dir, this.env) } : {}),
            ...(body.worktree === true ? { worktree: true } : {}),
            ...(typeof body.base === "string" && body.base.trim() ? { base: body.base.trim() } : {}),
            ...(typeof body.budget === "number" || body.budget === null ? { budget: body.budget } : {}),
            ...(typeof body.human === "string" ? { human: body.human } : {}),
            // Who sits in the room, as JSON (checked by createRoom); absent: the default roster.
            ...(body.agents !== undefined ? { agents: body.agents } : {}),
            // `agoryx new --doc none` sends null: no canonical file.
            ...(typeof body.doc === "string" ? { doc: body.doc.trim() || null } : body.doc === null ? { doc: null } : {}),
            // Opened from an agent's turn: the room says so; its human is still the human.
            ...(caller.agent ? { createdBy: caller.agent } : {}),
            // A thread: "here" is the calling agent's own room.
            ...(typeof body.from === "string" && body.from.trim() ? { from: body.from.trim() === "here" && caller.agent ? caller.agent.room : body.from.trim() } : {}),
            env: this.env,
          });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        const handle = this.room(store.id);
        if (text.trim()) this.engineFor(handle).post(text, this.actorFor(caller, handle.store.state));
        sendJson(res, 201, { room: handle.store.summary() });
        return;
      }
      throw new HttpError(405, "method not allowed");
    }

    const handle = this.room(parts[1]!);
    const action = parts[2];

    // Workflow submissions never enter the shared room projection, stream, native transcript,
    // or workspace. This human-only endpoint is the sole view of their atomic round reveals.
    if (action === "workflow") {
      if (caller.agent) throw new HttpError(403, "workflows are controlled and inspected by the human");
      const roomId = handle.store.id;
      if (parts[3] === "preview" && parts.length === 4) {
        if (method !== "GET") throw new HttpError(405, "GET");
        const runId = url.searchParams.get("runId"), entryId = url.searchParams.get("entryId");
        if (!runId || !entryId) throw new HttpError(400, "A preview requires runId and entryId");
        const current = this.workflows.get(roomId);
        const run = current?.id === runId ? current : this.workflows.history(roomId).find((item) => item.id === runId);
        const entry = run?.rounds.filter((round) => round.status === "revealed").flatMap((round) => round.entries).find((item) => item.id === entryId && item.status === "complete" && typeof item.text === "string");
        if (!entry?.text) throw new HttpError(404, "No revealed artifact for this run and entry");
        const files = parseWorkflowArtifacts(entry.text), primary = visualArtifact(files);
        if (!primary) throw new HttpError(404, "This entry has no visual artifact");
        const document = artifactPreviewDocument(files, primary);
        // A navigated document gets its own restrictive policy. srcdoc alone would
        // inherit the application's script policy and disable artifact interaction.
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(document),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts",
        });
        res.end(document);
        return;
      }
      if (method === "GET" && parts[3] === "history" && parts.length === 4) {
        sendJson(res, 200, { workflows: this.workflows.history(roomId) });
        return;
      }
      if (method === "GET" && parts.length === 3) {
        const isolation = await this.workflowCapability();
        sendJson(res, 200, { workflow: this.workflows.get(roomId), capabilities: { isolation } });
        return;
      }
      if (method !== "POST" || parts.length !== 4) throw new HttpError(405, "method not allowed");
      const raw = await readBody(req);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "a workflow request must be an object");
      const body = raw as Record<string, unknown>;
      // A slow request can finish after shutdown begins; every mutation, including selection, is gated here.
      if (this.closing) throw new HttpError(503, "The daemon is shutting down; no new workflow action can start");
      try {
        if (parts[3] === "start") {
          const engine = this.engineFor(handle);
          if (!engine.isIdle() || Object.values(engine.presence()).includes("native")) {
            throw new HttpError(409, "Wait for the room agents to finish before starting a workflow");
          }
          const isolation = await this.workflowCapability();
          if (!isolation.available) throw new HttpError(409, isolation.reason ?? "Isolated execution is unavailable on this computer");
          // Recheck the engine identity too: the room can switch folders during the asynchronous probe.
          if (this.closing) throw new HttpError(503, "The daemon is shutting down; no workflow can start");
          if (this.engineFor(handle) !== engine) throw new HttpError(409, "The room changed while private execution was being checked; refresh and try again");
          if (!engine.isIdle() || Object.values(engine.presence()).includes("native")) {
            throw new HttpError(409, "Wait for the room agents to finish before starting a workflow");
          }
          if (!Array.isArray(body.participantIds) || body.participantIds.some((id) => typeof id !== "string")) {
            throw new HttpError(400, "participantIds must be an array of room agent IDs");
          }
          const roles = body.roles;
          if (roles !== undefined && (!roles || typeof roles !== "object" || Array.isArray(roles))) {
            throw new HttpError(400, "roles must map room agent IDs to workflow roles");
          }
          const participants = (body.participantIds as string[]).map((id) => {
            const agent = handle.store.state.agents.find((entry) => entry.id === id);
            if (!agent) throw new HttpError(400, `No room agent named ${id}`);
            const provider = isolation.providers?.[agent.kind];
            if (provider && !provider.available) throw new HttpError(409, provider.reason ?? `${agent.kind} is unavailable for isolated work`);
            const role = (roles as Record<string, unknown> | undefined)?.[id];
            const { kind, label, model, effort } = agent;
            return { id, kind, label, model, effort, ...(role !== undefined ? { role: role as WorkflowRole } : {}) };
          });
          const paths = body.contextPaths;
          if (paths !== undefined && (!Array.isArray(paths) || paths.length > 20 || paths.some((path) => typeof path !== "string") || new Set(paths).size !== paths.length)) {
            throw new HttpError(400, "Select at most 20 distinct text files as shared materials");
          }
          let contextBytes = 0;
          const context = ((paths ?? []) as string[]).map((path) => {
            // Inputs are explicit copies, never a mount or an agent-controlled absolute path.
            if (!normalizeDocPath(path)) throw new HttpError(400, `Invalid material path: ${path}`);
            const file = resolveInside(handle.store.state.workspace, path);
            if (!file || inGitDir(handle.store.state.workspace, file)) throw new HttpError(400, `Material must stay inside the room workspace: ${path}`);
            const privateState = join(agoraHome(this.env), "workflows");
            const privateRoot = existsSync(privateState) ? realpathSync(privateState) : resolve(privateState);
            const relativeFile = file.slice(realpathSync(handle.store.state.workspace).length + 1);
            if (relativeFile.split(sep).some((part) => [".git", ".agoryx", ".codex", ".claude"].includes(part)) || file === privateRoot || file.startsWith(`${privateRoot}${sep}`)) {
              throw new HttpError(400, "Internal agent state cannot be used as workflow materials");
            }
            const stat = statSync(file);
            if (!stat.isFile() || stat.size > 200_000 || contextBytes + stat.size > 200_000) {
              throw new HttpError(400, "Shared materials must be text files totaling at most 200 KB");
            }
            const bytes = readFileSync(file);
            contextBytes += bytes.length;
            const content = bytes.toString("utf8");
            if (contextBytes > 200_000 || bytes.includes(0) || !Buffer.from(content).equals(bytes)) throw new HttpError(400, "Shared materials must be UTF-8 text totaling at most 200 KB");
            return { path, text: content };
          });
          const carried = conversationMaterials(handle.store.state, body.resultIds === undefined ? [] : this.workflows.history(roomId), body.messageIds, body.resultIds);
          if (context.length + carried.length > 20 || contextBytes + carried.reduce((n, m) => n + Buffer.byteLength(m.text), 0) > 200_000) throw new HttpError(400, "Choose at most 20 shared materials totaling 200 KB");
          context.push(...carried);
          const workflow = this.workflows.start(roomId, {
            mode: body.mode as WorkflowMode,
            task: body.task as string,
            criteria: body.criteria as string[],
            participants,
            ...(context.length ? { context } : {}),
            ...(body.budget !== undefined ? { budget: body.budget as WorkflowStartInput["budget"] } : {}),
          });
          sendJson(res, 201, { workflow });
          return;
        }
        if (typeof body.runId !== "string" || !body.runId) throw new HttpError(400, "runId is required");
        if (parts[3] === "action") {
          if (body.type === "retry") {
            const engine = this.engineFor(handle);
            if (!engine.isIdle() || Object.values(engine.presence()).includes("native")) {
              throw new HttpError(409, "Wait for the room agents to finish before retrying a workflow");
            }
            const isolation = await this.workflowCapability();
            if (this.closing) throw new HttpError(503, "The daemon is shutting down; no workflow can restart");
            if (this.engineFor(handle) !== engine) throw new HttpError(409, "The room changed while private execution was being checked; refresh and try again");
            if (!isolation.available) throw new HttpError(409, isolation.reason ?? "Isolated execution is unavailable on this computer");
            const current = this.workflows.get(roomId);
            for (const participant of current?.participants ?? []) {
              const provider = isolation.providers?.[participant.kind];
              if (provider && !provider.available) throw new HttpError(409, provider.reason ?? `${participant.kind} is unavailable for isolated work`);
            }
            if (!engine.isIdle() || Object.values(engine.presence()).includes("native")) {
              throw new HttpError(409, "Wait for the room agents to finish before retrying a workflow");
            }
          }
          sendJson(res, 200, { workflow: this.workflows.act(roomId, body as unknown as WorkflowAction) });
          return;
        }
        if (parts[3] === "stop") {
          sendJson(res, 200, { workflow: this.workflows.cancel(roomId, body.runId) });
          return;
        }
        throw new HttpError(404, "unknown workflow action");
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      }
    }

    const guardWorkflow = () => {
      if (method === "POST" && ["messages", "continue", "table", "table-assist", "mode", "project", "agent", "agents", "agent-remove", "settings"].includes(action ?? "")) {
        this.assertWorkflowIdle(handle.store.id);
      }
    };
    guardWorkflow();

    if (!action && method === "GET") {
      sendJson(res, 200, this.snapshot(handle, device));
      return;
    }

    if (action === "project" && method === "POST") {
      if (caller.agent) throw new HttpError(403, "Only the human changes conversation membership");
      const body = await readBody(req) as Record<string, unknown>;
      guardWorkflow();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "A project change must be an object");
      if (body.projectKey !== null && (typeof body.projectKey !== "string" || !body.projectKey.trim())) throw new HttpError(400, "projectKey must be a project folder or null");
      let key: string | null;
      try { key = body.projectKey === null ? null : projectKeyOfFolder(resolveFolder(body.projectKey as string, this.env), RoomStore.list(roomsDir(this.env))); }
      catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)); }
      const engine = this.engineFor(handle);
      if (!engine.isIdle() || Object.values(engine.presence()).includes("native")) throw new HttpError(409, "Wait for the agents to finish before changing the project");
      if (handle.store.state.parent) throw new HttpError(409, "A thread stays in its parent's project");
      handle.changingMode = true;
      try {
        await engine.close();
        delete handle.engine;
        handle.store.append({ type: "room.project.changed", projectKey: key, by: handle.store.state.human });
        sendJson(res, 200, this.snapshot(handle, device));
      } finally {
        handle.changingMode = false;
        this.tryDrive(handle);
      }
      return;
    }

    if (action === "mode" && method === "POST") {
      if (caller.agent) throw new HttpError(403, "Only the human switches room modes");
      const engine = this.engineFor(handle);
      const body = await readBody(req) as Record<string, unknown>;
      guardWorkflow();
      if (body.mode !== "chat" && body.mode !== "work") throw new HttpError(400, "mode must be chat or work");
      if (engine.state.runs.at(-1)?.status === "active" || engine.state.turns.some((turn) => turn.status === "running") || Object.values(engine.presence()).some((p) => p === "native")) throw new HttpError(409, "Wait for the agents to finish before switching modes");
      this.engineFor(handle);
      if (this.terminals.list(handle.store.id).some((terminal) => terminal.exit === null)) throw new HttpError(409, "Close the room terminals before switching modes");
      handle.changingMode = true;
      try {
        await engine.close();
        delete handle.engine;
        changeRoomMode(handle.store, {
          mode: body.mode,
          ...(typeof body.dir === "string" && body.dir.trim() ? { dir: resolveFolder(body.dir, this.env) } : {}),
          ...(body.worktree === true ? { worktree: true } : {}),
          ...(typeof body.base === "string" ? { base: body.base } : {}),
        }, this.env);
        // A mode switch changes the folder while existing SSE listeners stay connected.
        handle.gitWatch?.close();
        delete handle.gitWatch;
        if (handle.followers > 0) this.watchGit(handle);
        this.browser.closeRoom(handle.store.id);
        this.tryDrive(handle);
        sendJson(res, 200, this.snapshot(handle, device));
      } catch (error) {
        this.tryDrive(handle);
        throw new HttpError(400, error instanceof Error ? error.message : String(error));
      } finally {
        handle.changingMode = false;
      }
      return;
    }

    // What the room's wakes cost, from its recorded turns.
    if (action === "usage" && method === "GET") {
      sendJson(res, 200, roomUsage(handle.store.state, handle.store.since(0)));
      return;
    }

    if (action === "git" && method === "GET") {
      // Live: the agents may switch branches or commit while the room runs.
      sendJson(res, 200, { git: folderGit(handle.store.state.workspace, { branches: false }), worktree: handle.store.state.worktree ?? null });
      return;
    }

    if (action === "events" && method === "GET") {
      this.stream(req, res, handle, Number.parseInt(url.searchParams.get("after") ?? "", 10), device);
      return;
    }

    if (action === "doc" && method === "GET") {
      const rev = url.searchParams.get("rev");
      sendJson(res, 200, rev ? this.docRevision(handle, Number.parseInt(rev, 10)) : this.docNow(handle));
      return;
    }

    if (action === "session" && method === "GET") {
      sendJson(res, 200, this.sessionTranscript(handle, url.searchParams));
      return;
    }

    if (action === "turn-activity" && method === "GET") {
      sendJson(res, 200, this.turnActivity(handle, url.searchParams));
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

    if (action === "file" && method === "POST") {
      // The human's editor saves. An agent writes files with its own tools, not through the page's API.
      if (caller.agent) throw new HttpError(403, "the editor is the human's: an agent writes files with its own tools");
      const body = (await readBody(req, MAX_FILE_PREVIEW + 64 * 1024)) as Record<string, unknown>;
      sendJson(res, 200, this.writeWorkspaceFile(handle, body.path, body.text, body.base));
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

    if (action === "room-diff" && method === "GET") {
      // Asked for, never pushed: the room's whole change against where it began.
      const result = roomWorkspaceDiff(handle.store);
      if (!result) throw new HttpError(404, "nothing to compare with yet: no turn has run in this room");
      sendJson(res, 200, result);
      return;
    }

    if (action === "commit" && method === "GET") {
      const sha = url.searchParams.get("sha") ?? "";
      if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, "bad sha");
      const checkpoint = handle.store.state.commits.find((entry) => entry.sha.startsWith(sha));
      const text = readCheckpoint(checkpoint?.workspace ?? handle.store.state.workspace, sha);
      if (text === null) throw new HttpError(404, "commit or snapshot not found");
      sendJson(res, 200, { sha, text: text.length > 400_000 ? `${text.slice(0, 400_000)}\n… (truncated)` : text });
      return;
    }

    if (action === "revert" && method === "GET") {
      // What returning the folder would change, for the human to confirm. Nothing is touched.
      const undo = url.searchParams.get("undo");
      const sha = url.searchParams.get("sha");
      const busy = handle.engine ? handle.engine.revertBusy() : (handle.lockedBy ?? "the room is not available");
      // Neither: whether the room can have checkpoints at all (only in a git repository).
      if (undo === null && sha === null) {
        sendJson(res, 200, { tracking: workspaceTracking(handle.store.state.workspace), busy });
        return;
      }
      const request: RevertRequest = undo !== null ? { undoOf: Number(undo) } : { sha: sha ?? "" };
      try {
        const plan = planRevert(handle.store.state, request);
        sendJson(res, 200, { ...plan, busy });
      } catch (error) {
        if (!(error instanceof RevertError)) throw error;
        sendJson(res, error.status, { error: error.message, code: error.code });
      }
      return;
    }

    if (action === "pr" && method === "GET") {
      // What "Open PR" would push and open, for the human to confirm. Nothing is pushed.
      try {
        sendJson(res, 200, await this.engineFor(handle).prPlan());
      } catch (error) {
        if (error instanceof GithubUnavailable) throw new HttpError(409, error.message);
        if (error instanceof GhError) throw new HttpError(502, error.message);
        throw error;
      }
      return;
    }

    if (action === "step-commit" && method === "GET") {
      // What committing a step would take, for the human to choose its files. Nothing is touched.
      try {
        sendJson(res, 200, planStepCommit(handle.store.state, handle.store.events, url.searchParams.get("step") ?? ""));
      } catch (error) {
        if (!(error instanceof StepCommitError)) throw error;
        sendJson(res, error.status, { error: error.message });
      }
      return;
    }

    if (action === "terminals") {
      await this.terminalsApi(req, res, handle, parts.slice(3), method, caller);
      return;
    }

    if (action === "skills" && method === "GET") {
      if (caller.agent) throw new HttpError(403, "the skill picker is for the human");
      sendJson(res, 200, await roomSkills(handle.store.state.workspace, handle.store.state.agents, this.env));
      return;
    }

    if (method !== "POST") throw new HttpError(405, "method not allowed");
    const body = (await readBody(req)) as Record<string, unknown>;
    guardWorkflow();
    const engine = this.engineFor(handle);
    const actor = this.actorFor(caller, engine.state);
    // The human acting in a room has seen it.
    if (!caller.agent) this.attention.markSeen(handle.store.id);

    switch (action) {
      case "table-assist": {
        if (caller.agent) throw new HttpError(403, "Only the human requests table preparation.");
        const message = engine.tableAssist(body, actor);
        sendJson(res, 201, { message });
        return;
      }
      case "messages": {
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) throw new HttpError(400, "text is required");
        if (body.skill !== undefined) {
          if (caller.agent) throw new HttpError(403, "only the human chooses a skill invocation");
          const catalog = await roomSkills(engine.state.workspace, engine.state.agents, this.env);
          guardWorkflow();
          try {
            const skill = resolveSkillInvocation(catalog, body.skill);
            const message = engine.postHuman(text, actor.by, skill);
            sendJson(res, 201, { message });
          } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
          }
          return;
        }
        const message = engine.post(text, actor);
        sendJson(res, 201, { message });
        return;
      }
      case "table": {
        const before = engine.state.seq;
        const op = engine.tableOp(body, actor);
        const event = (() => {
          for (let i = handle.store.events.length - 1; i >= 0; i--) {
            const entry = handle.store.events[i]!;
            if (entry.type === "table.op" && (op.nonce
              ? entry.op.nonce === op.nonce && entry.op.by === op.by && entry.op.requestHash === op.requestHash
              : entry.seq === before + 1)) return entry;
          }
          return undefined;
        })();
        sendJson(res, 201, { op, seq: event?.seq ?? engine.state.seq, event, table: engine.state.table, text: `${op.id ? `${op.id} · ` : ""}${describeTableOp(op, engine.state.table)}` });
        return;
      }
      case "continue": {
        const seq = engine.state.seq + 1;
        engine.continueRun(actor);
        sendJson(res, 200, { ok: true, seq });
        return;
      }
      case "rename": {
        try {
          engine.rename(typeof body.name === "string" ? body.name : "", actor);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        sendJson(res, 200, { room: handle.store.summary() });
        return;
      }
      case "resolve": {
        if (caller.agent) throw new HttpError(403, "resolving a thread is the human's");
        try {
          engine.resolveThread(body.resolved !== false, actor);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        sendJson(res, 200, { room: handle.store.summary() });
        return;
      }
      case "stop": {
        const privateWork = this.workflows.isBusy(handle.store.id);
        if (privateWork && caller.agent) throw new HttpError(403, "Only the human stops a workflow");
        // Worker cleanup releases its lease; keep native wakes held until the room stop also finishes.
        handle.stoppingWorkflow = true;
        try {
          if (privateWork) {
            const workflow = this.workflows.get(handle.store.id);
            if (workflow && ["running", "waiting_user"].includes(workflow.status)) this.workflows.cancel(handle.store.id, workflow.id);
            await this.workflows.wait(handle.store.id);
          }
          await engine.stop("human", actor);
          sendJson(res, 200, { ok: true });
        } finally {
          handle.stoppingWorkflow = false;
          // A new native event received during Stop may have queued a later run. Old work was ended above.
          if (!this.closing) engine.requestSchedule();
        }
        return;
      }
      case "agent": {
        const agentId = typeof body.agent === "string" ? body.agent : "";
        const patch: AgentPatch = {};
        for (const key of ["model", "effort", "role"] as const) {
          const value = body[key];
          if (value === null || typeof value === "string") patch[key] = value;
          else if (value !== undefined) throw new HttpError(400, `${key} must be a string or null`);
        }
        if (body.label !== undefined) {
          if (typeof body.label !== "string") throw new HttpError(400, "label must be a string");
          patch.label = body.label;
        }
        if (body.profile !== undefined) {
          if (typeof body.profile !== "boolean") throw new HttpError(400, "profile must be true or false");
          patch.profile = body.profile;
        }
        try {
          const agent = engine.updateAgent(agentId, patch, actor);
          sendJson(res, 200, { agent });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "agents": {
        // Seat another agent: { agent: { kind, id?, label?, model?, effort?, role?, profile? } }. The human's alone.
        if (caller.agent) throw new HttpError(403, "only the human seats agents");
        try {
          const agent = engine.addAgent(body.agent, actor);
          sendJson(res, 201, { agent, agents: engine.state.agents });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "agent-remove": {
        if (caller.agent) throw new HttpError(403, "only the human sends agents out of the room");
        try {
          await engine.removeAgent(typeof body.agent === "string" ? body.agent : "", actor);
          sendJson(res, 200, { agents: engine.state.agents });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "settings": {
        try {
          engine.updateSettings(body as Partial<RoomSettings>, actor);
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
          const revision = engine.writeDocument(body.text, body.base, actor);
          sendJson(res, 200, { revision, ...this.docNow(handle) });
        } catch (error) {
          if (error instanceof DocConflictError) {
            sendJson(res, 409, { error: error.message, current: error.current });
            return;
          }
          if (error instanceof DocTooLargeError) throw new HttpError(413, error.message);
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      case "step-commit": {
        // The human's button: an agent commits a step with git itself, naming it.
        if (caller.agent) throw new HttpError(403, "an agent commits a step with git itself, naming it: git commit -m \"X1 <the step>\"");
        const files = Array.isArray(body.files) ? body.files.filter((file): file is string => typeof file === "string") : [];
        try {
          sendJson(res, 201, engine.commitStep(typeof body.step === "string" ? body.step : "", files, actor));
        } catch (error) {
          if (!(error instanceof StepCommitError)) throw error;
          sendJson(res, error.status, { error: error.message });
        }
        return;
      }
      case "pr": {
        // The human's alone: gh pushes and opens the pull request as them, from the branch and commit they were shown.
        if (caller.agent) throw new HttpError(403, "only the human opens a pull request from the room; an agent runs gh itself");
        try {
          // What the human was shown: the branch and commit, and where it goes.
          const seen = Object.fromEntries(["repo", "remote", "branch", "base", "sha", "pushUrl"].flatMap((key) => (typeof body[key] === "string" ? [[key, body[key]]] : [])));
          const pr = await engine.openPr(actor, seen);
          sendJson(res, 201, { pr });
        } catch (error) {
          if (error instanceof GithubUnavailable) throw new HttpError(409, error.message);
          if (error instanceof GhError) throw new HttpError(502, error.message);
          throw error;
        }
        return;
      }
      case "revert": {
        // The human's alone: an agent never rewinds the folder under the others.
        if (caller.agent) throw new HttpError(403, "only the human returns the folder to a checkpoint");
        const tree = typeof body.tree === "string" ? body.tree : undefined;
        const request: RevertRequest =
          typeof body.undo === "number" ? { undoOf: body.undo } : { sha: typeof body.sha === "string" ? body.sha : "" };
        try {
          const revert = engine.revertWorkspace({ ...request, ...(tree ? { tree } : {}) }, actor);
          sendJson(res, 200, { revert });
        } catch (error) {
          if (!(error instanceof RevertError)) throw error;
          sendJson(res, error.status, { error: error.message, code: error.code });
        }
        return;
      }
      default:
        throw new HttpError(404, "unknown room action");
    }
  }

  private snapshot(handle: RoomHandle, device?: DeviceInfo) {
    // Asked here and told to the room's other pages too, should the answer have changed unseen.
    lookAtGit(handle);
    const ops = handle.store
      .since(0)
      .flatMap((event) => (event.type === "table.op" ? [{ seq: event.seq, ts: event.ts, op: event.op }] : []));
    return {
      ...roomSnapshot(handle.store.state, handle.streams),
      presence: this.presence(handle),
      ops,
      events: handle.store.events.filter(isWorkTableEvent).slice(-100),
      rawBase: this.rawBase(handle.store.id, device),
      resume: resumeCommands(handle.store, this.runners),
      driven: Boolean(handle.engine),
      // Whether the folder is a git repository of its own: only then can a step be committed.
      gitRepo: handle.gitRepo === true,
      ...(handle.lockedBy ? { lockedBy: handle.lockedBy } : {}),
      // Whether there is a profile at all, never what it says: the UI shows who is given it.
      profile: { path: profilePath(this.env), exists: readProfile(profilePath(this.env)) !== null },
      limits: readLimits(this.env),
    };
  }

  /**
   * An agent's own session as its CLI wrote it: `end` reads what came before an earlier page; `size`
   * (the file size the caller already has) answers `unchanged` without reading anything.
   */
  private sessionTranscript(handle: RoomHandle, params: URLSearchParams) {
    const state = handle.store.state;
    const agent = state.agents.find((entry) => entry.id === params.get("agent"));
    if (!agent) throw new HttpError(404, "no such agent in this room");
    const session = state.sessions[agent.id];
    if (!session) return { agent: agent.id, sessionId: null, file: null, entries: [], start: 0, end: 0, size: 0 };
    const key = `${state.id}\0${agent.id}\0${session.sessionId}`;
    let file = this.sessionFiles.get(key) ?? null;
    if (!file || !existsSync(file)) {
      file = locateNativeSession(agent.kind, session.sessionId, state.workspace, this.env);
      if (file) this.sessionFiles.set(key, file);
    }
    if (!file) return { agent: agent.id, sessionId: session.sessionId, file: null, entries: [], start: 0, end: 0, size: 0 };
    const endParam = params.get("end");
    const end = endParam !== null && /^\d{1,15}$/.test(endParam) ? Number(endParam) : undefined;
    const known = Number(params.get("size") ?? "");
    if (end === undefined && Number.isFinite(known) && known > 0) {
      const size = statSync(file).size;
      if (size === known) return { agent: agent.id, sessionId: session.sessionId, file, unchanged: true, size };
    }
    return { agent: agent.id, sessionId: session.sessionId, file, ...readTranscript(agent.kind, file, end === undefined ? {} : { end }) };
  }

  /** Native tool details for exactly this room turn; older pages never return the surrounding conversation. */
  private turnActivity(handle: RoomHandle, params: URLSearchParams) {
    const state = handle.store.state;
    const turnId = params.get("turn") ?? "";
    if (!/^t\d{1,9}$/.test(turnId)) throw new HttpError(400, "turn is required");
    const turn = state.turns.find((t) => t.id === turnId);
    if (!turn) throw new HttpError(404, "no such turn in this room");
    const agent = [...state.agents, ...state.former].find((a) => a.id === turn.agent);
    const sessionId = turnSession(state, turn);
    const empty = { turn: turn.id, sessionId, entries: [], start: 0, size: 0 };
    if (!agent || !sessionId) return empty;
    const key = `${state.id}\0${agent.id}\0${sessionId}`;
    let file = this.sessionFiles.get(key) ?? null;
    if (!file || !existsSync(file)) {
      file = locateNativeSession(agent.kind, sessionId, workspaceAt(state, turn.seq), this.env);
      if (file) this.sessionFiles.set(key, file);
    }
    if (!file) return empty;
    const endParam = params.get("end");
    if (endParam !== null && !/^\d{1,15}$/.test(endParam)) throw new HttpError(400, "invalid session page");
    return { turn: turn.id, sessionId, ...readTurnActivity(agent.kind, file, turn, endParam === null ? {} : { end: Number(endParam) }) };
  }

  /** The canonical file as it is on disk now. */
  private docNow(handle: RoomHandle) {
    const state = handle.store.state;
    const path = state.settings.doc;
    if (!path) throw new HttpError(404, "this room has no canonical file");
    const now = readDoc(state.workspace, path);
    return { path, text: now?.text ?? "", hash: now?.hash ?? docHash(""), exists: Boolean(now), truncated: Boolean(now?.truncated) };
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
    // The room's own table, wherever it lives in .agoryx/ (rooms sharing the workspace have one each).
    const full = relPath === ".agoryx/TABLE.md" ? workspacePaths(root, handle.store.state.id).tableFile : resolveInside(root, relPath);
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
      // What a save names as the version it edited; only a whole text file can be edited.
      hash: binary || stats.size > length ? null : hashOf(preview),
    };
  }

  /**
   * The human's save from the editor. `base` is the hash of the version the editor opened (null: a new file); if the
   * file changed on disk since, nothing is written and 409 says what is there now, so an agent's edit is never lost.
   */
  private writeWorkspaceFile(handle: RoomHandle, relPath: unknown, text: unknown, base: unknown) {
    if (typeof relPath !== "string" || !relPath.trim()) throw new HttpError(400, "path is required");
    if (typeof text !== "string") throw new HttpError(400, "text is required");
    if (base !== null && typeof base !== "string") throw new HttpError(400, "base is required: the hash the editor opened, or null for a new file");
    const root = handle.store.state.workspace;
    const full = resolveForWrite(root, relPath);
    const agoryxDir = full ? join(realpathSync(root), ".agoryx") : "";
    const inAgoryx = full ? full === agoryxDir || full.startsWith(agoryxDir + sep) : false;
    const gitNamed = relPath.split(/[\\/]/).includes(".git");
    if (!full || gitNamed || inGitDir(root, full) || inAgoryx) throw new HttpError(403, "this path is not the human's to edit here");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_FILE_PREVIEW) throw new HttpError(413, "too large for the editor");
    if (existsSync(full)) {
      const stats = statSync(full);
      if (!stats.isFile()) throw new HttpError(400, "not a file");
      const now = stats.size > MAX_FILE_PREVIEW ? null : hashOf(readFileSync(full));
      if (now !== base) {
        const current = now === null ? null : this.readWorkspaceFile(handle, relPath);
        throw new HttpError(409, "the file changed on disk since it was opened", false, { hash: now, text: current?.text ?? null });
      }
    } else if (base !== null) {
      throw new HttpError(409, "the file was removed since it was opened", false, { hash: null, text: null });
    } else {
      mkdirSync(dirname(full), { recursive: true });
    }
    writeFileSync(full, bytes);
    const stats = statSync(full);
    return { path: relPath, size: stats.size, mtime: stats.mtime.toISOString(), hash: hashOf(bytes) };
  }

  private stream(req: IncomingMessage, res: ServerResponse, handle: RoomHandle, after: number, device?: DeviceInfo): void {
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
      if (event.type === "limits") {
        res.write(`event: limits\ndata: ${JSON.stringify({ limits: event.limits })}\n\n`);
        return;
      }
      if (event.type === "git") {
        res.write(`event: git\ndata: ${JSON.stringify({ gitRepo: event.gitRepo })}\n\n`);
        return;
      }
      const state = handle.store.state;
      const patch = {
        ...eventPatch(state, event),
        presence: this.presence(handle),
        // The command to open a session names its model: it changes with either.
        ...(event.type === "agent.changed" || event.type === "agent.added" || event.type === "agent.removed" || event.type === "session.bound" ? { resume: resumeCommands(handle.store, this.runners) } : {}),
      };
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
    // A revoked device's streams end with it.
    const mine = device ? (this.deviceStreams.get(device.id) ?? new Set<ServerResponse>()) : null;
    if (device && mine) {
      mine.add(res);
      this.deviceStreams.set(device.id, mine);
    }
    handle.followers += 1;
    handle.engine?.lookAtGithub();
    this.watchGit(handle);
    // A .git that came between the page's snapshot and this stream, before anything watched the folder.
    lookAtGit(handle);
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
      mine?.delete(res);
      handle.followers -= 1;
      if (handle.followers <= 0 && handle.followTimer) {
        clearInterval(handle.followTimer);
        delete handle.followTimer;
      }
      if (handle.followers <= 0) {
        handle.gitWatch?.close();
        delete handle.gitWatch;
      }
    });
  }

  /**
   * While someone has the room open, a .git appearing in (or leaving) its folder — `git init` in the human's
   * terminal or by an agent — is told to the page at once: whether a step can be committed depends on it.
   */
  private watchGit(handle: RoomHandle): void {
    if (handle.gitWatch) return;
    try {
      handle.gitWatch = watch(handle.store.state.workspace, { persistent: false }, (_kind, name) => {
        if (name === null || name === ".git") lookAtGit(handle);
      });
      handle.gitWatch.on("error", () => {
        handle.gitWatch?.close();
        delete handle.gitWatch;
      });
    } catch {
      // A folder that is gone or unreadable: the snapshot says what it can.
    }
  }

  /**
   * /api/rooms/<room>/terminals: the human's shells in the room's folder. GET lists them; POST {cols, rows}
   * opens one; POST <id>/input {text} types into it; POST <id>/rename {title}; POST <id>/close ends it. What
   * a shell prints and what is typed live go over its WebSocket (upgrade()).
   */
  private async terminalsApi(req: IncomingMessage, res: ServerResponse, handle: RoomHandle, rest: string[], method: string, caller: Caller): Promise<void> {
    if (caller.agent) throw new HttpError(403, "terminals are the human's: an agent has its own shell");
    const room = handle.store.state.id;
    try {
      if (rest.length === 0 && method === "GET") {
        sendJson(res, 200, { terminals: this.terminals.list(room) });
        return;
      }
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = (await readBody(req, 64 * 1024)) as Record<string, unknown>;
      if (rest.length === 0) {
        const terminal = this.terminals.open(room, handle.store.state.workspace, body);
        if (typeof body.text === "string" && body.text) this.terminals.write(room, terminal.id, body.text);
        sendJson(res, 201, { terminal });
        return;
      }
      const [id, what] = rest;
      if (rest.length !== 2 || !id) throw new HttpError(404, "unknown endpoint");
      if (what === "input") {
        if (typeof body.text !== "string") throw new HttpError(400, "text is required");
        this.terminals.write(room, id, body.text);
        sendJson(res, 200, { ok: true });
      } else if (what === "rename") {
        sendJson(res, 200, { terminal: this.terminals.rename(room, id, String(body.title ?? "")) });
      } else if (what === "close") {
        this.terminals.close(room, id);
        sendJson(res, 200, { ok: true });
      } else throw new HttpError(404, "unknown endpoint");
    } catch (error) {
      if (error instanceof TerminalError) throw new HttpError(error.status, error.message);
      throw error;
    }
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

  /**
   * /api/pair and /api/devices: pairing codes and the paired devices. The human's on this computer only:
   * neither an agent nor a paired device can pair another device or revoke one.
   */
  private async devicesApi(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, caller: Caller): Promise<void> {
    if (caller.agent) throw new HttpError(403, "pairing devices is the human's");
    if (caller.device) throw new HttpError(403, "a paired device cannot pair or revoke devices; do it on the computer");
    const reach = this.reachUrls();
    if (parts[0] === "pair" && parts.length === 1) {
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      if (reach.length === 0) {
        throw new HttpError(
          409,
          "the daemon listens on this computer only: `agoryx up --lan` opens it to the same Wi-Fi (or `agoryx up --tailscale`, behind Tailscale serve); it applies to the running daemon and is remembered",
        );
      }
      const { code, secret, expiresAt } = this.devices.createCode();
      this.log(`made a pairing code (valid until ${expiresAt.slice(11, 19)} UTC)`);
      // The link carries the long secret: a scanned QR code is never locked out by someone guessing typed codes.
      const links = reach.map(({ url, kind }) => {
        const link = `${url}/?pair=${secret}`;
        return { url: link, base: url, kind, qr: `data:image/svg+xml;base64,${Buffer.from(qrSvg(link)).toString("base64")}` };
      });
      sendJson(res, 201, { code: formatCode(code), expiresAt, links });
      return;
    }
    if (parts[0] === "devices" && parts.length === 1) {
      if (method !== "GET") throw new HttpError(405, "method not allowed");
      sendJson(res, 200, { devices: this.devices.list(), reach });
      return;
    }
    if (parts[0] === "devices" && parts.length === 2) {
      if (method !== "DELETE") throw new HttpError(405, "method not allowed");
      const revoked = this.devices.revoke(decodeURIComponent(parts[1]!));
      if (!revoked) throw new HttpError(404, "no such device");
      for (const stream of this.deviceStreams.get(revoked.id) ?? []) stream.end();
      this.deviceStreams.delete(revoked.id);
      this.log(`revoked a device: ${deviceLabel(revoked)}`);
      sendJson(res, 200, { revoked });
      return;
    }
    if (parts[0] === "exposure" && parts.length === 1) {
      // GET: how the daemon is reachable; POST {lan, hosts}: change it now, and keep the choice.
      if (method === "GET") {
        sendJson(res, 200, this.exposure());
        return;
      }
      if (method !== "POST") throw new HttpError(405, "method not allowed");
      const body = (await readBody(req, 4096)) as Record<string, unknown>;
      if (typeof body.lan !== "boolean") throw new HttpError(400, "lan must be true or false");
      if (body.hosts !== undefined && (!Array.isArray(body.hosts) || body.hosts.some((host) => typeof host !== "string"))) {
        throw new HttpError(400, "hosts must be a list of host names");
      }
      const hosts = (body.hosts as string[] | undefined) ?? this.httpsHosts;
      if (hosts.some((host) => !/^[a-z0-9.-]+$/i.test(host.trim().replace(/\.$/, "")))) throw new HttpError(400, "a host is a plain DNS name");
      const applied = await this.setExposure({ lan: body.lan, hosts });
      // The human's choice holds for the next start too (the app's, or after a crash).
      writeExposure({ lan: body.lan, hosts: applied.hosts }, this.env);
      sendJson(res, 200, applied);
      return;
    }
    throw new HttpError(404, "unknown endpoint");
  }

  /**
   * /api/push: a paired device's Web Push subscription. GET: the key to subscribe with and whether this
   * device is subscribed; POST {subscription} (null clears it); POST /api/push/test sends one to it.
   */
  private async pushApi(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, caller: Caller): Promise<void> {
    if (caller.agent) throw new HttpError(403, "notifications are the human's");
    const device = caller.device;
    if (parts.length === 0 && method === "GET") {
      sendJson(res, 200, {
        publicKey: device ? this.push.publicKey : null,
        subscribed: device ? this.devices.pushTargets().some((target) => target.device.id === device.id) : false,
      });
      return;
    }
    if (!device) throw new HttpError(403, "notifications go to a paired device; this computer has the app's own");
    if (parts.length === 0 && method === "POST") {
      const body = (await readBody(req, 16 * 1024)) as Record<string, unknown>;
      if (body.subscription === null) {
        this.devices.setPush(device.id, null);
        sendJson(res, 200, { subscribed: false });
        return;
      }
      const subscription = parseSubscription(body.subscription, { allowHttp: this.options.pushAllowHttp === true });
      if (typeof subscription === "string") throw new HttpError(400, subscription);
      this.devices.setPush(device.id, subscription);
      this.log(`push: ${deviceLabel(device)} takes notifications`);
      sendJson(res, 200, { subscribed: true });
      return;
    }
    if (parts[0] === "test" && parts.length === 1 && method === "POST") {
      sendJson(res, 200, await this.push.send({ title: "Agoryx", body: "Notifications work.", tag: "agoryx-test", room: null }, device.id));
      return;
    }
    if (parts[0] === "note" && parts.length === 2 && method === "GET") {
      // The service worker asks what a push said; one the daemon did not send to this device is not found.
      const note = this.pushNotes.get(decodeURIComponent(parts[1]!), device.id);
      if (!note) throw new HttpError(404, "no such notification");
      sendJson(res, 200, note);
      return;
    }
    throw new HttpError(404, "unknown endpoint");
  }

  /** /api/browser: agents' commands to the room's browser, and the app that hosts it. */
  private async browserApi(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, caller: Caller): Promise<void> {
    try {
      if (parts.length === 0) {
        if (method !== "POST") throw new HttpError(405, "method not allowed");
        const origin = caller.agent;
        if (!origin) throw new HttpError(403, "browser commands come from agents, under their own key; the human uses the pane itself");
        const turnAndNetwork = () => {
          const engine = this.rooms.get(origin.room)?.engine;
          if (!engine || engine.presence()[origin.agent] !== "working") throw new HttpError(409, "The room's browser works only while your turn runs.");
          if (!engine.state.settings.network) {
            throw new HttpError(403, "This room's network is off, so its browser is off too. The human can turn the network on in the room settings.");
          }
        };
        turnAndNetwork();
        // Any agent can compute any key from daemon.token: the command must come from this agent's own turn.
        const owner = await agentBehind(req.socket);
        if (!owner || "unknown" in owner || owner.room !== origin.room || owner.agent !== origin.agent) {
          throw new HttpError(403, "Browser commands must come from your own turn: your CLI, or a process it started.");
        }
        const body = await readBody(req);
        // The turn may have ended, or the network gone off, during the two awaits. Check again in the tick that
        // registers the command, so a later turn end or closeRoom finds it in flight.
        turnAndNetwork();
        // The agent gave up (its call was cancelled or timed out, or its process ended): the command is withdrawn.
        const gone = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) gone.abort();
        });
        const result = await this.browser.command(origin, body, gone.signal);
        sendJson(res, 200, { ok: true, result });
        return;
      }
      if (caller.agent || caller.device) throw new HttpError(403, "only the Agoryx app hosts the room's browser");
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

// ---------------------------------------------------------------------------
// Finding a running daemon (in daemoninfo.ts, which the desktop app can load without the daemon)
// ---------------------------------------------------------------------------

export { findDaemon, readDaemonInfo, type DaemonInfo } from "./daemoninfo.js";
