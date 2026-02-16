import type { Message, Room, RoomConfig } from "../events/types.js";
import { createId, nowIso } from "./ids.js";
import { SQLiteStore } from "../storage/sqlite.js";

export interface SessionOptions {
  roomName: string;
  participants: string[];
  roomConfig: RoomConfig;
}

export class SessionService {
  public constructor(private readonly store: SQLiteStore) {}

  public createSession(options: SessionOptions): { room: Room; sessionId: string } {
    const room = this.store.createRoom(
      options.roomName,
      options.participants,
      options.roomConfig,
    );
    const sessionId = this.store.createSessionRun(room.id);
    return { room, sessionId };
  }

  public resumeSession(roomId: string): { room: Room; sessionId: string } | null {
    const room = this.store.getRoom(roomId);
    if (!room) {
      return null;
    }
    const sessionId = this.store.createSessionRun(room.id);
    return { room, sessionId };
  }

  public saveUserMessage(roomId: string, text: string): Message {
    const message: Message = {
      id: createId("msg"),
      roomId,
      author: "user",
      role: "user",
      text,
      format: "plain",
      metadata: {},
      createdAt: nowIso(),
    };
    this.store.saveMessage(message);
    return message;
  }

  public saveAssistantMessage(
    roomId: string,
    author: string,
    text: string,
    requestId: string,
    dispatchId: string,
    provider: string,
    model: string,
  ): Message {
    const message: Message = {
      id: createId("msg"),
      roomId,
      author,
      role: "assistant",
      text,
      format: "markdown",
      metadata: {
        provider,
        model,
        requestId,
        dispatchId,
      },
      createdAt: nowIso(),
    };
    this.store.saveMessage(message);
    return message;
  }

  public listMessages(roomId: string, limit = 250): Message[] {
    return this.store.listMessages(roomId, limit);
  }

  public addPinnedContext(
    roomId: string,
    label: string,
    content: string,
    pinnedBy = "user",
  ): string {
    const pin = this.store.addPinnedContext(roomId, label, content, pinnedBy);
    return pin.id;
  }

  public updateRoomMode(room: Room, mode: RoomConfig["mode"]): Room {
    this.store.updateRoomMode(room.id, mode);
    return {
      ...room,
      config: {
        ...room.config,
        mode,
      },
    };
  }

  public removePinnedContext(roomId: string, pinId: string): boolean {
    return this.store.removePinnedContext(roomId, pinId);
  }

  public buildContextMessages(room: Room): Message[] {
    const pinned = this.store.listPinnedContext(room.id);
    const messages = this.store.listMessages(room.id, room.config.maxHistoryMessages);
    const checkpoint = this.store.getLatestCheckpoint(room.id);

    const contextMessages: Message[] = [];
    if (checkpoint) {
      contextMessages.push({
        id: createId("msg"),
        roomId: room.id,
        author: "system.checkpoint",
        role: "system",
        text: `Conversation summary: ${checkpoint.summaryText}`,
        format: "plain",
        metadata: {},
        createdAt: nowIso(),
      });
    }

    for (const pin of pinned) {
      contextMessages.push({
        id: createId("msg"),
        roomId: room.id,
        author: "system.pinned",
        role: "system",
        text: `[Pinned:${pin.label}] ${pin.content}`,
        format: "plain",
        metadata: {},
        createdAt: nowIso(),
      });
    }

    return [...contextMessages, ...messages];
  }

  public maybeCreateCheckpoint(room: Room): string | null {
    const messages = this.store.listMessages(room.id, room.config.maxHistoryMessages);
    const assistantAndUserMessages = messages.filter(
      (message) => message.role === "assistant" || message.role === "user",
    );
    if (assistantAndUserMessages.length < room.config.checkpointThreshold) {
      return null;
    }

    const first = assistantAndUserMessages[0];
    const last = assistantAndUserMessages[assistantAndUserMessages.length - 1];
    if (!first || !last) {
      return null;
    }

    const clipped = assistantAndUserMessages.slice(-12).map((message) => ({
      author: message.author,
      text: message.text.length > 180 ? `${message.text.slice(0, 180)}...` : message.text,
    }));
    const summaryText = clipped.map((item) => `${item.author}: ${item.text}`).join("\n");
    this.store.saveCheckpoint(room.id, summaryText, first.id, last.id);
    return summaryText;
  }

  public appendEvent(event: Parameters<SQLiteStore["appendEvent"]>[0]): void {
    this.store.appendEvent(event);
  }

  public getLastFailedRequest(roomId: string, adapterName: string): string | null {
    return this.store.getLastFailedRequest(roomId, adapterName);
  }
}
