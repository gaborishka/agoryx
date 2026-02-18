import type { AdapterEvent } from "./adapter.js";
import type {
  ErrorClass,
  MessageEventPayload,
  MessageErrorPayload,
  SessionBoundPayload,
} from "../events/types.js";
import { createId, nowIso } from "../session/ids.js";

interface BaseArgs {
  roomId: string;
  sessionId: string;
  requestId: string;
  source: string;
}

export const messageStarted = (
  args: BaseArgs,
  payload: MessageEventPayload,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "message.started",
  requestId: args.requestId,
  payload,
});

export const messageDelta = (
  args: BaseArgs,
  payload: MessageEventPayload,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "message.delta",
  requestId: args.requestId,
  payload,
});

export const messageCompleted = (
  args: BaseArgs,
  payload: MessageEventPayload,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "message.completed",
  requestId: args.requestId,
  payload,
});

export const messageError = (
  args: BaseArgs,
  errorClass: ErrorClass,
  message: string,
  raw?: string,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "message.error",
  requestId: args.requestId,
  payload: {
    class: errorClass,
    message,
    raw,
  } satisfies MessageErrorPayload,
});

export const sessionBound = (
  args: BaseArgs,
  nativeSessionId: string,
): AdapterEvent => ({
  eventId: createId("evt"),
  roomId: args.roomId,
  sessionId: args.sessionId,
  timestamp: nowIso(),
  source: args.source,
  type: "session.bound",
  requestId: args.requestId,
  payload: { nativeSessionId } satisfies SessionBoundPayload,
});
