import type { Message, PinnedContext, Room, RoomConfig } from "../events/types.js";
import { createId, nowIso } from "./ids.js";
import { SQLiteStore } from "../storage/sqlite.js";
import { buildContext, type BuiltContext } from "./context.js";

// --- Stop words for topic extraction ---
const STOP_WORDS = new Set([
  // EN
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some", "them",
  "than", "its", "over", "such", "that", "this", "with", "will", "each",
  "make", "like", "from", "just", "into", "also", "more", "other", "would",
  "about", "which", "their", "there", "should", "what", "when", "where",
  "could", "does", "here", "much", "being", "those", "then", "these",
  "very", "after", "before", "your", "only",
  // UA
  "що", "який", "яка", "яке", "які", "для", "при", "або", "але", "так",
  "ще", "вже", "як", "цей", "ця", "це", "ці", "той", "та", "те", "ті",
  "він", "вона", "воно", "вони", "мій", "моя", "моє", "мої", "наш",
  "ваш", "його", "її", "їх", "нас", "вас", "них", "нам", "вам", "ним",
  "тут", "там", "коли", "тоді", "потім", "після", "перед", "між",
]);

export function extractTopics(messages: Message[]): string[] {
  const freq = new Map<string, number>();
  for (const m of messages) {
    const words = m.text
      .toLowerCase()
      .split(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ'']+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
    for (const w of words) {
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

const DECISION_PATTERNS = [
  // EN
  /(?:agreed|decision|let's use|we'll use|chosen|picked|going with)\s+(.+)/i,
  // UA
  /(?:використовуємо|вирішили|обрали|приймаємо|зупинились на)\s+(.+)/i,
];

export function extractDecisions(messages: Message[]): string[] {
  const decisions: string[] = [];
  for (const m of messages) {
    for (const pattern of DECISION_PATTERNS) {
      const match = m.text.match(pattern);
      if (match?.[1]) {
        // Take first sentence or up to 80 chars
        const text = match[1].split(/[.!?\n]/)[0].trim().slice(0, 80);
        if (text) decisions.push(text);
      }
    }
  }
  return decisions;
}

export function buildBudgetTail(messages: Message[], charBudget = 2000): string[] {
  const lines: string[] = [];
  let remaining = charBudget;

  for (let i = messages.length - 1; i >= 0; i--) {
    const line = `${messages[i].author}: ${messages[i].text}`;
    // Account for \n joiner when this isn't the first line added
    const cost = lines.length > 0 ? line.length + 1 : line.length;
    if (cost > remaining) break;
    lines.unshift(line);
    remaining -= cost;
  }
  return lines;
}

const PRIOR_SUMMARY_TRIM = 1000;

export function buildStructuredSummary(
  messages: Message[],
  previousSummary?: string,
): string {
  // Header: count per author
  const authorCounts = new Map<string, number>();
  for (const m of messages) {
    authorCounts.set(m.author, (authorCounts.get(m.author) ?? 0) + 1);
  }
  const authorBreakdown = [...authorCounts.entries()]
    .map(([a, c]) => `${a}: ${c}`)
    .join(", ");
  const total = messages.length;

  // Topics
  const topics = extractTopics(messages);
  const topicsLine = topics.length > 0 ? topics.join(", ") : "general discussion";

  // Decisions
  const decisions = extractDecisions(messages);
  const decisionsLine = decisions.length > 0
    ? decisions.join("; ")
    : "none detected";

  // Tail (budget-based)
  const tail = buildBudgetTail(messages);

  // Build output
  const parts: string[] = [];

  // Prior summary (cumulative, flat — strip existing marker to prevent nesting per INV-3)
  if (previousSummary) {
    // Strip existing [Prior summary] prefix to prevent nested wrappers
    const stripped = previousSummary.replace(/^\[Prior summary\]\n/, "");
    // Trim from END to keep freshest context (not oldest)
    const trimmed = stripped.length > PRIOR_SUMMARY_TRIM
      ? stripped.slice(-PRIOR_SUMMARY_TRIM)
      : stripped;
    parts.push(`[Prior summary]\n${trimmed}\n---`);
  }

  parts.push(`[Checkpoint] ${total} messages (${authorBreakdown})`);
  parts.push(`Topics: ${topicsLine}`);
  parts.push(`Decisions: ${decisionsLine}`);
  parts.push("---");
  parts.push(...tail);

  return parts.join("\n");
}

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

  public listPinnedContext(roomId: string): PinnedContext[] {
    return this.store.listPinnedContext(roomId);
  }

  /**
   * Build the context message array for an agent dispatch.
   *
   * Delegates to the context builder algorithm which handles:
   * - Pinned context injection
   * - Checkpoint-aware message selection
   * - Token budget trimming (keeps newest messages)
   *
   * @param room - The room to build context for
   * @param systemPrompt - Optional system prompt (from adapter config) to account for in token budget
   */
  public buildContextMessages(room: Room, systemPrompt?: string): Message[] {
    const ctx = this.buildFullContext(room, systemPrompt);
    return ctx.messages;
  }

  /**
   * Rich context build — returns full BuiltContext including token stats and truncation info.
   * Useful for diagnostics and adapters that want to inspect context metadata.
   */
  public buildFullContext(room: Room, systemPrompt?: string): BuiltContext {
    return buildContext(this.store, {
      roomId: room.id,
      systemPrompt,
      maxHistoryMessages: room.config.maxHistoryMessages,
      checkpointThreshold: room.config.checkpointThreshold,
      maxContextTokens: room.config.maxContextTokens,
    });
  }

  public maybeCreateCheckpoint(room: Room, force?: boolean): string | null {
    // Determine uncovered messages (INV-5: no window dependency for dedup)
    const coverage = this.store.getCheckpointCoverage(room.id);
    let uncoveredMessages: Message[];
    let allConversationMessages: Message[] | null = null;

    if (coverage) {
      // Targeted query: messages after last checkpoint's endpoint (no window limit)
      const afterCheckpoint = this.store.listMessagesAfter(room.id, coverage.toMessageId);
      uncoveredMessages = afterCheckpoint.filter(
        (m) => m.role === "assistant" || m.role === "user",
      );
      // Dedup: nothing new since last checkpoint
      if (uncoveredMessages.length === 0) return null;
    } else {
      // No previous checkpoint: load conversation messages with a high ceiling
      // so that toMessageId is the real last message.
      // NOTE: listMessages is ORDER BY ASC LIMIT, so this returns the oldest 10k.
      // For rooms >10k messages, toMessageId will be stale. Acceptable for v0.1
      // where rooms stay well under 10k; post-v0.1 should use a DESC+reverse query.
      const messages = this.store.listMessages(room.id, 10_000);
      allConversationMessages = messages.filter(
        (m) => m.role === "assistant" || m.role === "user",
      );
      uncoveredMessages = allConversationMessages;
      if (uncoveredMessages.length === 0) return null;
    }

    // Threshold check (INV-2)
    const minRequired = force ? 2 : room.config.checkpointThreshold;
    if (uncoveredMessages.length < minRequired) return null;

    // Get previous summary for cumulative checkpoint
    const prevCheckpoint = this.store.getLatestCheckpoint(room.id);
    const previousSummary = prevCheckpoint?.summaryText;

    // Build structured summary
    const summaryText = buildStructuredSummary(uncoveredMessages, previousSummary);

    // Range (INV-1): preserve fromMessageId from previous coverage
    const firstMsgId = allConversationMessages
      ? allConversationMessages[0].id
      : uncoveredMessages[0].id;
    const fromMessageId = coverage?.fromMessageId ?? firstMsgId;
    // toMessageId = last conversation message (including uncovered)
    const lastMessages = allConversationMessages ?? uncoveredMessages;
    const toMessageId = lastMessages[lastMessages.length - 1].id;

    this.store.saveCheckpoint(room.id, summaryText, fromMessageId, toMessageId);
    return summaryText;
  }

  public appendEvent(event: Parameters<SQLiteStore["appendEvent"]>[0]): void {
    this.store.appendEvent(event);
  }

  public getLastFailedRequest(roomId: string, adapterName: string): string | null {
    return this.store.getLastFailedRequest(roomId, adapterName);
  }
}
