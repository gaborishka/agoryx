/**
 * Context Builder
 *
 * Builds the message array to send to an agent.
 * Implements the context building algorithm from ARCHITECTURE.md:
 *
 * 1. Start with system prompt (agent role/persona)
 * 2. Add all pinned context blocks for this room
 * 3. If message count > threshold:
 *    a. Find latest checkpoint summary
 *    b. Include summary + messages after that checkpoint
 * 4. Else: include full message history
 * 5. Trim oldest messages to fit adapter's context budget
 */

import type { Message, Checkpoint, PinnedContext } from "../events/types.js";
import type { SQLiteStore } from "../storage/sqlite.js";

export interface ContextBuildOptions {
  roomId: string;
  systemPrompt?: string;
  maxHistoryMessages: number;
  checkpointThreshold: number;
  maxContextTokens: number;
}

export interface BuiltContext {
  messages: Message[];
  systemPrompt: string | null;
  truncated: boolean;
  totalEstimatedTokens: number;
}

/**
 * Rough token estimate: ~4 chars per token.
 * Intentionally conservative; a proper tokenizer can replace this later.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildContext(
  store: SQLiteStore,
  opts: ContextBuildOptions,
): BuiltContext {
  const {
    roomId,
    systemPrompt,
    maxHistoryMessages,
    checkpointThreshold,
    maxContextTokens,
  } = opts;

  const pinnedContexts = store.listPinnedContext(roomId);
  // Use max of both limits for threshold check (INV-5: avoid false negatives
  // when checkpointThreshold > maxHistoryMessages)
  const countLimit = Math.max(maxHistoryMessages, checkpointThreshold + 1);
  const allMessages = store.listMessages(roomId, countLimit);
  const messageCount = allMessages.length;

  let messages: Message[];
  let checkpointSummary: string | null = null;

  if (messageCount > checkpointThreshold) {
    const checkpoint = store.getLatestCheckpoint(roomId);
    if (checkpoint) {
      checkpointSummary = checkpoint.summaryText;
      // Use targeted query: only messages after checkpoint (no window dependency)
      const afterCheckpoint = store.listMessagesAfter(roomId, checkpoint.toMessageId);
      if (afterCheckpoint.length > 0) {
        messages = afterCheckpoint;
      } else {
        // Checkpoint covers all messages or anchor is stale — load recent history.
        messages = store.listRecentMessages(roomId, maxHistoryMessages);
      }
    } else {
      // No checkpoint despite threshold exceeded — load recent history.
      messages = store.listRecentMessages(roomId, maxHistoryMessages);
    }
  } else {
    messages = allMessages;
  }

  // Build output, tracking token budget
  const result: Message[] = [];
  let tokenBudget = maxContextTokens;
  let truncated = false;

  // Add system prompt as the first message
  if (systemPrompt) {
    const promptTokens = estimateTokens(systemPrompt);
    tokenBudget -= promptTokens;
    result.push({
      id: "system-prompt",
      roomId,
      author: "system",
      role: "system",
      text: systemPrompt,
      format: "plain",
      metadata: {},
      createdAt: new Date().toISOString(),
    });
  }

  // Add pinned context as synthetic system messages
  for (const pin of pinnedContexts) {
    const pinText = `[Pinned: ${pin.label}] ${pin.content}`;
    const tokens = estimateTokens(pinText);
    if (tokens > tokenBudget) {
      truncated = true;
      break;
    }
    tokenBudget -= tokens;
    result.push({
      id: pin.id,
      roomId,
      author: "system",
      role: "system",
      text: pinText,
      format: "plain",
      metadata: {},
      createdAt: pin.createdAt,
    });
  }

  // Add checkpoint summary
  if (checkpointSummary) {
    const summaryText = `[Conversation summary]\n${checkpointSummary}`;
    const tokens = estimateTokens(summaryText);
    if (tokens <= tokenBudget) {
      tokenBudget -= tokens;
      result.push({
        id: "checkpoint-summary",
        roomId,
        author: "system",
        role: "system",
        text: summaryText,
        format: "plain",
        metadata: {},
        createdAt: new Date().toISOString(),
      });
    }
  }

  // Add conversation messages, trimming oldest if over budget
  let totalMessageTokens = 0;
  for (const msg of messages) {
    totalMessageTokens += estimateTokens(msg.text);
  }

  if (totalMessageTokens > tokenBudget) {
    truncated = true;
    let remaining = tokenBudget;
    const kept: Message[] = [];
    // Keep from newest, walking backwards
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = estimateTokens(messages[i].text);
      if (remaining >= tokens) {
        kept.unshift(messages[i]);
        remaining -= tokens;
      } else {
        break;
      }
    }
    result.push(...kept);
  } else {
    result.push(...messages);
  }

  // Calculate total tokens from result messages only (system prompt already in result)
  let totalEstimatedTokens = 0;
  for (const msg of result) {
    totalEstimatedTokens += estimateTokens(msg.text);
  }

  return {
    messages: result,
    systemPrompt: systemPrompt ?? null,
    truncated,
    totalEstimatedTokens,
  };
}
