import { Agent, request, type ClientRequest, type IncomingMessage } from "node:http";
import type { BrowserCommand, BrowserResult } from "../agora/browser.js";

/**
 * The app's end of the room's browser (docs/plans/2026-09-29-desktop-browser-pane.md, B1): it holds the daemon's
 * host stream, `GET /api/browser/host`, hands each command to the pane as it arrives, and posts the pane's answer
 * back. It keeps nothing and retries no command: only the stream is opened again, with a backoff, when it drops.
 * The token goes in a header, never in a URL. The stream and the answers share one keep-alive agent, so an answer
 * reuses a socket the daemon has already checked.
 */

/** The canonical wire type; desktop/src keeps its own copy (its rootDir is src). */
export type BrowserCommandWire = BrowserCommand;
export type BrowserAnswer = { ok: true; result: BrowserResult } | { ok: false; error: string };

export interface BrowserLinkOptions {
  /** The daemon's url, e.g. http://127.0.0.1:7717. */
  url: string;
  token: string;
  /** Runs one command in the pane. Commands come in as they arrive; the pane orders them. */
  handle: (command: BrowserCommandWire) => Promise<BrowserAnswer>;
  /** The room's network went off: its pane closes. */
  closeRoom: (room: string) => void;
  /**
   * The daemon withdrew a command (the agent's turn ended, or its call was cancelled or timed out): a pane that has
   * not started it yet skips it. A command already running runs to its end; its late answer gets 404.
   */
  cancel?: (id: string) => void;
  log?: (line: string) => void;
}

/** Delays before the stream is opened again (the last one repeats); a `hello` starts them over. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000];

/** Posted instead when the daemon refuses the pane's answer: the command did run in the page. */
const UNDELIVERED = "The room's browser finished this command, but its result could not be delivered (too large or not valid).";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class BrowserLink {
  private readonly log: (line: string) => void;
  private agent: Agent | null = null;
  private stream: ClientRequest | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private live = false;
  private open = false;
  private wasReplaced = false;

  constructor(private readonly options: BrowserLinkOptions) {
    this.log = options.log ?? (() => {});
  }

  /** The daemon said hello on the current stream. */
  get connected(): boolean {
    return this.open;
  }

  /** Started, and neither stopped nor replaced by another app. */
  get running(): boolean {
    return this.live;
  }

  /** Stopped because another app took the host: its owner should not start it again for the same daemon. */
  get replaced(): boolean {
    return this.wasReplaced;
  }

  start(): void {
    if (this.live) return;
    this.live = true;
    this.wasReplaced = false;
    this.attempt = 0;
    this.agent = new Agent({ keepAlive: true });
    this.connect();
  }

  stop(): void {
    this.live = false;
    this.open = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const stream = this.stream;
    this.stream = null;
    stream?.destroy();
    this.agent?.destroy();
    this.agent = null;
  }

  private connect(): void {
    this.timer = null;
    if (!this.live || !this.agent) return;
    const stream = request(new URL("/api/browser/host", this.options.url), {
      method: "GET",
      agent: this.agent,
      headers: { "x-agoryx-token": this.options.token, accept: "text/event-stream" },
    });
    this.stream = stream;
    stream.on("response", (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        this.dropped(stream, `the daemon answered ${res.statusCode ?? "?"}`);
        return;
      }
      this.read(stream, res);
    });
    stream.on("error", (error) => this.dropped(stream, messageOf(error)));
    stream.end();
  }

  /** Server-sent events: `event:` and `data:` lines, dispatched on a blank line; `:` lines are comments. */
  private read(stream: ClientRequest, res: IncomingMessage): void {
    res.setEncoding("utf8");
    let buffer = "";
    let event = "";
    let data: string[] = [];
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line === "") {
          if (data.length > 0 || event) this.dispatch(stream, event || "message", data.join("\n"));
          event = "";
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
    });
    res.on("end", () => this.dropped(stream, "the stream ended"));
    res.on("error", (error) => this.dropped(stream, messageOf(error)));
    res.on("close", () => this.dropped(stream, "the stream closed"));
  }

  private dispatch(stream: ClientRequest, event: string, data: string): void {
    if (stream !== this.stream || !this.live) return;
    switch (event) {
      case "hello":
        this.open = true;
        this.attempt = 0;
        this.log("browser: hosting the room's browser for the daemon");
        return;
      case "command": {
        let command: BrowserCommandWire;
        try {
          command = JSON.parse(data) as BrowserCommandWire;
        } catch {
          this.log("browser: a command that is not JSON was ignored");
          return;
        }
        if (!command || typeof command.id !== "string") return;
        void this.run(command);
        return;
      }
      case "close": {
        try {
          const { room } = JSON.parse(data) as { room?: unknown };
          if (typeof room === "string") this.options.closeRoom(room);
        } catch {
          // not JSON: nothing to close
        }
        return;
      }
      case "cancel": {
        try {
          const { id } = JSON.parse(data) as { id?: unknown };
          if (typeof id === "string") this.options.cancel?.(id);
        } catch {
          // not JSON: nothing to drop
        }
        return;
      }
      case "replaced":
        this.log("browser: another Agoryx app hosts the room's browser now");
        this.stop();
        this.wasReplaced = true;
        return;
    }
  }

  private async run(command: BrowserCommandWire): Promise<void> {
    let answer: BrowserAnswer;
    try {
      answer = await this.options.handle(command);
    } catch (error) {
      answer = { ok: false, error: messageOf(error) || "the room's browser failed" };
    }
    const outcome = await this.deliver(command, JSON.stringify(answer));
    // The daemon refused the answer itself (400 not valid, 413 too large): the agent hears that now, not in a 504.
    if (outcome === 400 || outcome === 413) await this.deliver(command, JSON.stringify({ ok: false, error: UNDELIVERED }));
  }

  /** Posts one answer, once more after a network error or a 403. Resolves with the last outcome. */
  private async deliver(command: BrowserCommandWire, body: string): Promise<"ok" | "network" | "stopped" | number> {
    let outcome: "ok" | "network" | "stopped" | number = "stopped";
    for (let tries = 1; tries <= 2; tries += 1) {
      if (!this.live || !this.agent) return "stopped";
      outcome = await this.post(command.id, body, this.agent);
      if (outcome === "ok") return outcome;
      // A network error, or a 403 when the daemon could not tell this app's process apart: once more.
      const again = tries === 1 && (outcome === "network" || outcome === 403);
      if (!again) {
        this.log(`browser: the answer to a ${command.op} command was not taken (${outcome === "network" ? "network error" : outcome})`);
        return outcome;
      }
    }
    return outcome;
  }

  private post(id: string, body: string, agent: Agent): Promise<"ok" | "network" | number> {
    return new Promise((resolve) => {
      const req = request(new URL(`/api/browser/answer/${encodeURIComponent(id)}`, this.options.url), {
        method: "POST",
        agent,
        headers: {
          "x-agoryx-token": this.options.token,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      });
      req.on("response", (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300 ? "ok" : status);
      });
      req.on("error", () => resolve("network"));
      req.end(body);
    });
  }

  private dropped(stream: ClientRequest, reason: string): void {
    if (stream !== this.stream) return;
    this.stream = null;
    stream.destroy();
    const wasOpen = this.open;
    this.open = false;
    if (!this.live) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    if (wasOpen || this.attempt === 1) this.log(`browser: the host stream dropped (${reason}); opening it again`);
    this.timer = setTimeout(() => this.connect(), delay);
    this.timer.unref();
  }
}
