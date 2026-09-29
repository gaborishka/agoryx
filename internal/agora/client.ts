import type { RoomSummary } from "./store.js";
import type { AgentPresence, EphemeralEvent, MessageEntry, RoomAgent, RoomEvent, RoomSettings, RoomState, TableOp } from "./types.js";

export interface RoomSnapshot {
  state: RoomState;
  presence: Record<string, AgentPresence>;
  streams: Record<string, { agent: string; text: string }>;
  resume: Record<string, string>;
  driven: boolean;
  lockedBy?: string;
  /** Every table op with its seq, for attribution in transcripts. */
  ops: Array<{ seq: number; ts: string; op: TableOp }>;
  /** URL prefix for sandboxed workspace file previews. */
  rawBase: string;
}

export type DaemonStreamItem =
  | { kind: "room"; event: RoomEvent; patch: Record<string, unknown> }
  | { kind: "stream"; event: Extract<EphemeralEvent, { type: "turn.stream" }> }
  | { kind: "presence"; agents: Record<string, AgentPresence> };

export class DaemonRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thin client for the local daemon API. */
export class DaemonClient {
  constructor(readonly info: { url: string; token: string }) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.info.url}${path}`, {
      method,
      headers: {
        "x-agoryx-token": this.info.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text };
    }
    if (!response.ok) {
      throw new DaemonRequestError(response.status, (parsed as { error?: string }).error ?? `HTTP ${response.status}`);
    }
    return parsed as T;
  }

  rooms(): Promise<{ rooms: RoomSummary[] }> {
    return this.request("GET", "/api/rooms");
  }

  createRoom(input: {
    name: string;
    dir?: string;
    worktree?: boolean;
    base?: string;
    budget?: number | null;
    doc?: string | null;
    text?: string;
    agents?: RoomAgent[];
  }): Promise<{ room: RoomSummary }> {
    return this.request("POST", "/api/rooms", input);
  }

  snapshot(room: string): Promise<RoomSnapshot> {
    return this.request("GET", `/api/rooms/${encodeURIComponent(room)}`);
  }

  say(room: string, text: string): Promise<{ message: MessageEntry }> {
    return this.request("POST", `/api/rooms/${encodeURIComponent(room)}/messages`, { text });
  }

  table(room: string, op: Record<string, unknown>): Promise<{ op: TableOp; text: string; seq: number }> {
    return this.request("POST", `/api/rooms/${encodeURIComponent(room)}/table`, op);
  }

  continueRun(room: string): Promise<{ ok: true; seq: number }> {
    return this.request("POST", `/api/rooms/${encodeURIComponent(room)}/continue`, {});
  }

  stop(room: string): Promise<{ ok: true }> {
    return this.request("POST", `/api/rooms/${encodeURIComponent(room)}/stop`, {});
  }

  /** Stop the daemon (it records who asked in the rooms whose runs it stops). */
  down(): Promise<{ ok: true }> {
    return this.request("POST", "/api/down", {});
  }

  settings(room: string, patch: Partial<RoomSettings>): Promise<{ settings: RoomSettings }> {
    return this.request("POST", `/api/rooms/${encodeURIComponent(room)}/settings`, patch);
  }

  /** Follow a room's events (server-sent events) until the signal aborts. */
  async *events(room: string, after: number, signal: AbortSignal): AsyncGenerator<DaemonStreamItem> {
    const response = await fetch(`${this.info.url}/api/rooms/${encodeURIComponent(room)}/events?after=${after}`, {
      headers: { "x-agoryx-token": this.info.token, accept: "text/event-stream" },
      signal,
    });
    if (!response.ok || !response.body) throw new DaemonRequestError(response.status, `cannot follow room (HTTP ${response.status})`);
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          let name = "message";
          const data: string[] = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }
          if (data.length === 0) continue;
          const payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
          if (name === "room") yield { kind: "room", event: payload.event as RoomEvent, patch: payload.patch as Record<string, unknown> };
          else if (name === "stream") yield { kind: "stream", event: payload as Extract<EphemeralEvent, { type: "turn.stream" }> };
          else if (name === "presence") yield { kind: "presence", agents: payload.agents as Record<string, AgentPresence> };
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}
