import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ActorOrigin } from "./types.js";

/**
 * The room's browser: agents' commands relayed to the app's pane (docs/archive/plans/2026-09-29-desktop-browser-pane.md, A1).
 * It only relays. The daemon checks who may send a command (a running turn, the room's network, the agent's own
 * processes); the pane runs them, one at a time per room. The relay forwards each command at once, never keeps one
 * for a host that might come later, and never rewrites, merges, reorders or retries. Nothing is stored. A command
 * whose agent gave up on it, or whose turn ended, is withdrawn: the host is told, so the pane does not run it later.
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
  /** A command sent earlier is withdrawn: the pane drops it unless it has started. */
  cancel(id: string): void;
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

const OPS: readonly BrowserOp[] = ["navigate", "snapshot", "click", "type", "press", "screenshot", "eval"];
const MAX_STRING = 10_000;
const MAX_EXPRESSION = 100_000;
const MAX_TEXT = 200_000;
const MAX_ERROR = 10_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Agent-facing texts, in English like the agent CLI (the spec's A1 table).
const NO_HOST =
  "The room's browser needs the Agoryx desktop app, and it is not running (or not connected to this daemon). Nothing was opened.";
const NETWORK_OFF =
  "This room's network is off, so its browser is off too. The human can turn the network on in the room settings.";
const HOST_GONE = "The Agoryx app disconnected while running this command. It may or may not have happened in the page.";
const TURN_ENDED = "Your turn ended while this command was in the room's browser. It may or may not have happened in the page.";
const GAVE_UP = "The call was cancelled while this command was in the room's browser. It may or may not have happened in the page.";
const STOPPING = "The Agoryx daemon is stopping. It may or may not have happened in the page.";
const tooMany = (limit: number) => `Too many browser commands are in flight in this room (${limit}). Wait for the current ones.`;
const timedOut = (ms: number) =>
  `The room's browser did not finish this command within ${Math.round(ms / 1000)} s. Commands in a room run one at a time, so a slow page or other agents' commands can cause this. It may or may not have happened in the page.`;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A command's op and args, or the text of the 400. */
const parseCommand = (body: unknown): { op: BrowserOp; args: Record<string, unknown> } | string => {
  if (!isPlainObject(body)) return "send { op, args }";
  const op = body.op;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) return `op must be one of ${OPS.join(", ")}`;
  const args = body.args === undefined ? {} : body.args;
  if (!isPlainObject(args)) return "args must be an object";
  for (const [name, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const limit = name === "expression" ? MAX_EXPRESSION : MAX_STRING;
      if (value.length > limit) return `args.${name} is longer than ${limit} characters`;
    } else if (value !== null && typeof value !== "number" && typeof value !== "boolean") {
      return `args.${name} must be a string, a number or a boolean`;
    }
  }
  return { op: op as BrowserOp, args };
};

/** An answer from the host: a checked result, a failure, or the text of the 400. */
const parseAnswer = (body: unknown): { ok: true; result: BrowserResult } | { ok: false; error: string } | string => {
  if (!isPlainObject(body) || typeof body.ok !== "boolean") return "send { ok: true, result } or { ok: false, error }";
  if (!body.ok) {
    if (typeof body.error !== "string" || !body.error.trim()) return "error must be a non-empty string";
    if (body.error.length > MAX_ERROR) return `error is longer than ${MAX_ERROR} characters`;
    return { ok: false, error: body.error };
  }
  const result = body.result;
  if (!isPlainObject(result)) return "result must be an object";
  if (typeof result.url !== "string" || typeof result.title !== "string") return "result.url and result.title must be strings";
  const viewport = result.viewport;
  if (!isPlainObject(viewport) || !isNumber(viewport.width) || !isNumber(viewport.height)) {
    return "result.viewport must have a numeric width and height";
  }
  const checked: BrowserResult = { url: result.url, title: result.title, viewport: { width: viewport.width, height: viewport.height } };
  if (result.text !== undefined) {
    if (typeof result.text !== "string") return "result.text must be a string";
    if (result.text.length > MAX_TEXT) return `result.text is longer than ${MAX_TEXT} characters`;
    checked.text = result.text;
  }
  if (result.image !== undefined) {
    const image = result.image;
    if (!isPlainObject(image) || image.mimeType !== "image/png" || typeof image.data !== "string") {
      return 'result.image must be { data, mimeType: "image/png" }';
    }
    if (!image.data || image.data.length % 4 !== 0 || !BASE64.test(image.data)) return "result.image.data must be base64";
    checked.image = { data: image.data, mimeType: "image/png" };
  }
  if (result.notes !== undefined) {
    if (!Array.isArray(result.notes) || !result.notes.every((note) => typeof note === "string")) {
      return "result.notes must be an array of strings";
    }
    checked.notes = [...result.notes];
  }
  return { ok: true, result: checked };
};

interface InFlight {
  command: BrowserCommand;
  host: BrowserHost;
  started: number;
  timer: NodeJS.Timeout;
  /** Stops listening to the caller's signal. */
  unlisten: () => void;
  resolve: (result: BrowserResult) => void;
  reject: (failure: BrowserFailure) => void;
}

export class BrowserRelay {
  private readonly timeoutMs: number;
  private readonly maxPerRoom: number;
  private readonly log: (line: string) => void;
  private host: BrowserHost | null = null;
  private closed = false;
  private readonly inFlight = new Map<string, InFlight>();

  constructor(options: { timeoutMs?: number; maxPerRoom?: number; log?: (line: string) => void } = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxPerRoom = options.maxPerRoom ?? 20;
    this.log = options.log ?? (() => {});
  }

  /** Returns the detach: idempotent, and a no-op unless this host is still the current one. */
  attach(host: BrowserHost): () => void {
    if (this.closed) {
      host.close("stopping");
      return () => {};
    }
    const previous = this.host;
    this.host = host;
    if (previous) {
      // Another app took over: the old stream ends, and what it was running fails.
      this.failWhere((entry) => entry.host === previous, 503, HOST_GONE);
      previous.close("replaced");
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      // The old stream's close fires after a newer host attached: it must not take the newer one down.
      if (this.host !== host) return;
      this.host = null;
      this.failWhere((entry) => entry.host === host, 503, HOST_GONE);
    };
  }

  /** `signal`: the agent gave up on the command (its request closed); it is withdrawn like at the end of its turn. */
  command(origin: ActorOrigin, body: unknown, signal?: AbortSignal): Promise<BrowserResult> {
    const parsed = parseCommand(body);
    if (typeof parsed === "string") return Promise.reject(new BrowserFailure(400, parsed));
    const started = Date.now();
    if (signal?.aborted) {
      this.logLine(origin, parsed.op, 499, started);
      return Promise.reject(new BrowserFailure(499, GAVE_UP));
    }
    const host = this.host;
    if (!host) {
      this.logLine(origin, parsed.op, 503, started);
      return Promise.reject(new BrowserFailure(503, NO_HOST));
    }
    let running = 0;
    for (const entry of this.inFlight.values()) if (entry.command.room === origin.room) running += 1;
    if (running >= this.maxPerRoom) {
      this.logLine(origin, parsed.op, 429, started);
      return Promise.reject(new BrowserFailure(429, tooMany(this.maxPerRoom)));
    }
    const command: BrowserCommand = {
      id: randomBytes(16).toString("hex"),
      room: origin.room,
      roomName: origin.roomName,
      agent: origin.agent,
      label: origin.label,
      op: parsed.op,
      args: parsed.args,
      deadline: started + this.timeoutMs,
    };
    return new Promise<BrowserResult>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(command.id, new BrowserFailure(504, timedOut(this.timeoutMs))), this.timeoutMs);
      timer.unref();
      const withdraw = () => this.withdraw(command.id, 499, GAVE_UP);
      signal?.addEventListener("abort", withdraw, { once: true });
      const unlisten = () => signal?.removeEventListener("abort", withdraw);
      this.inFlight.set(command.id, { command, host, started, timer, unlisten, resolve, reject });
      try {
        host.send(command);
      } catch {
        this.settle(command.id, new BrowserFailure(503, HOST_GONE));
      }
    });
  }

  /** Throws BrowserFailure(404) for an unknown or expired id. */
  answer(id: string, body: unknown): void {
    const entry = this.inFlight.get(id);
    if (!entry || entry.host !== this.host) throw new BrowserFailure(404, "no such browser command (unknown, expired or answered)");
    const answer = parseAnswer(body);
    if (typeof answer === "string") throw new BrowserFailure(400, answer);
    this.settle(id, answer.ok ? answer.result : new BrowserFailure(422, answer.error));
  }

  /** The agent's turn in the room ended: its commands still in flight are withdrawn. */
  endTurn(room: string, agent: string): void {
    for (const [id, entry] of [...this.inFlight]) {
      if (entry.command.room === room && entry.command.agent === agent) this.withdraw(id, 409, TURN_ENDED);
    }
  }

  /** The room's network went off. */
  closeRoom(room: string): void {
    this.failWhere((entry) => entry.command.room === room, 403, NETWORK_OFF);
    this.host?.closeRoom(room);
  }

  hasHost(): boolean {
    return this.host !== null;
  }

  close(): void {
    this.closed = true;
    const host = this.host;
    this.host = null;
    this.failWhere(() => true, 503, STOPPING);
    host?.close("stopping");
  }

  private failWhere(match: (entry: InFlight) => boolean, status: number, message: string): void {
    for (const [id, entry] of [...this.inFlight]) if (match(entry)) this.settle(id, new BrowserFailure(status, message));
  }

  /** Fails a command in flight and tells its host, so the pane drops it if it has not started. */
  private withdraw(id: string, status: number, message: string): void {
    const entry = this.inFlight.get(id);
    if (!entry) return;
    this.settle(id, new BrowserFailure(status, message));
    if (entry.host !== this.host) return;
    try {
      entry.host.cancel(id);
    } catch {
      // the stream is gone: its detach fails the rest
    }
  }

  private settle(id: string, outcome: BrowserResult | BrowserFailure): void {
    const entry = this.inFlight.get(id);
    if (!entry) return;
    this.inFlight.delete(id);
    clearTimeout(entry.timer);
    entry.unlisten();
    const { command } = entry;
    const origin = { agent: command.agent, roomName: command.roomName };
    if (outcome instanceof BrowserFailure) {
      this.logLine(origin, command.op, outcome.status, entry.started);
      entry.reject(outcome);
    } else {
      this.logLine(origin, command.op, "ok", entry.started);
      entry.resolve(outcome);
    }
  }

  /** One line per command: who, where, which op, the outcome and the time. Never arguments, URLs or results. */
  private logLine(origin: { agent: string; roomName: string }, op: BrowserOp, outcome: number | "ok", started: number): void {
    this.log(`browser: ${origin.agent}@${origin.roomName} ${op} ${outcome} (${Date.now() - started} ms)`);
  }
}

/** The app's host stream over SSE: the headers of the room streams, `hello`, then `command`, `cancel` and `close` events. */
export const sseHost = (res: ServerResponse): BrowserHost => {
  const write = (text: string): void => {
    if (!res.writableEnded && !res.destroyed) res.write(text);
  };
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  write("retry: 1500\n\n");
  write(`event: hello\ndata: ${JSON.stringify({ version: 1 })}\n\n`);
  // Its own ping: the daemon's heartbeat covers only sseClients, which this stream is not in.
  const ping = setInterval(() => write(": ping\n\n"), 15_000);
  ping.unref();
  res.on("close", () => clearInterval(ping));
  return {
    send: (command) => write(`event: command\ndata: ${JSON.stringify(command)}\n\n`),
    cancel: (id) => write(`event: cancel\ndata: ${JSON.stringify({ id })}\n\n`),
    closeRoom: (room) => write(`event: close\ndata: ${JSON.stringify({ room })}\n\n`),
    close: (reason) => {
      clearInterval(ping);
      if (reason === "replaced") write("event: replaced\ndata: {}\n\n");
      if (!res.writableEnded) res.end();
    },
  };
};
