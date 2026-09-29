import type { Activity, AgentKind, RoomSettings, TurnError, TurnUsage } from "../types.js";

export interface TurnRequest {
  prompt: string;
  cwd: string;
  /** Native session to resume; null starts a fresh session. */
  sessionId: string | null;
  roomName: string;
  model?: string;
  settings: RoomSettings;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

export interface TurnCallbacks {
  /** Native session id became known (fresh session or confirmation on resume). */
  onSession: (sessionId: string) => void;
  /** Live text of the agent's current message. reset=true starts a new message buffer. */
  onText: (text: string, reset?: boolean) => void;
  onActivity: (activity: Activity) => void;
}

export interface TurnResult {
  status: "ok" | "error" | "interrupted";
  text: string;
  sessionId: string | null;
  usage?: TurnUsage;
  error?: TurnError;
  /** Images the agent generated this turn, as absolute paths outside the workspace (Codex image_gen). */
  images?: string[];
}

export interface AgentRunner {
  kind: AgentKind;
  run(request: TurnRequest, callbacks: TurnCallbacks): Promise<TurnResult>;
  /**
   * Shell command a human can use to open this agent's native session. With the agent's model:
   * two agents of one kind can differ only by it, and a resumed session would otherwise talk to the CLI's default.
   */
  resumeCommand(sessionId: string, cwd: string, model?: string): string;
}

export const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export const truncate = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
