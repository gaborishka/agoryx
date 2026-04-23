/**
 * Message snipping — compresses old messages to save context tokens.
 *
 * Strategy:
 * 1. Messages within the "recent window" (last N) are kept intact.
 * 2. Messages outside the window are "snipped" — replaced with a
 *    one-line summary: "[snipped] author: first 80 chars..."
 * 3. Consecutive snipped messages from the same author are collapsed
 *    into a single "[N messages snipped from author]" marker.
 *
 * This preserves the conversation flow while dramatically reducing tokens.
 */

import type { Message } from "../events/types.js";

export interface SnipOptions {
  /** Number of recent messages to keep intact. Default: 20 */
  recentWindow?: number;
  /** Max chars for snipped message preview. Default: 80 */
  previewChars?: number;
  /** Collapse consecutive same-author snips. Default: true */
  collapseConsecutive?: boolean;
}

export interface SnipResult {
  messages: Message[];
  snippedCount: number;
  estimatedTokensSaved: number;
}

/** Rough token estimate (~4 chars per token). Same as context.ts */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Create a snipped placeholder message.
 */
function createSnippedMessage(
  original: Message,
  previewChars: number,
): Message {
  const preview = original.text.length > previewChars
    ? original.text.slice(0, previewChars) + "..."
    : original.text;
  return {
    ...original,
    text: `[snipped] ${preview}`,
    metadata: { ...original.metadata },
  };
}

/**
 * Collapse consecutive snipped messages from the same author.
 */
function collapseSnippedMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // Check if this is a snipped message
    if (!msg.text.startsWith("[snipped] ")) {
      result.push(msg);
      i++;
      continue;
    }

    // Count consecutive snipped messages from the same author
    const author = msg.author;
    let count = 1;
    while (
      i + count < messages.length &&
      messages[i + count].text.startsWith("[snipped] ") &&
      messages[i + count].author === author
    ) {
      count++;
    }

    if (count === 1) {
      // Single snipped message, keep as-is
      result.push(msg);
    } else {
      // Collapse into a single marker
      result.push({
        ...msg,
        text: `[${count} messages snipped from ${author}]`,
        metadata: { ...msg.metadata },
      });
    }

    i += count;
  }

  return result;
}

/**
 * Snip old messages outside the recent window.
 * Returns a new array — does not mutate the input.
 */
export function snipMessages(
  messages: Message[],
  options?: SnipOptions,
): SnipResult {
  if (messages.length === 0) {
    return { messages: [], snippedCount: 0, estimatedTokensSaved: 0 };
  }

  const recentWindow = options?.recentWindow ?? 20;
  const previewChars = options?.previewChars ?? 80;
  const collapseConsecutive = options?.collapseConsecutive ?? true;

  // If all messages fit within the recent window, no snipping needed
  if (messages.length <= recentWindow) {
    // Return a shallow copy so we never return the same array reference
    return {
      messages: [...messages],
      snippedCount: 0,
      estimatedTokensSaved: 0,
    };
  }

  const cutoff = messages.length - recentWindow;
  let snippedCount = 0;
  let originalTokens = 0;
  let newTokens = 0;

  const processed: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i < cutoff && msg.role !== "system") {
      // Outside recent window and not a system message — snip it
      const snipped = createSnippedMessage(msg, previewChars);
      originalTokens += estimateTokens(msg.text);
      newTokens += estimateTokens(snipped.text);
      snippedCount++;
      processed.push(snipped);
    } else {
      // Within recent window or system message — keep intact
      processed.push(msg);
    }
  }

  const result = collapseConsecutive
    ? collapseSnippedMessages(processed)
    : processed;

  // Recalculate newTokens after collapsing (collapsing changes the text)
  if (collapseConsecutive) {
    newTokens = 0;
    for (const msg of result) {
      if (
        msg.text.startsWith("[snipped] ") ||
        /^\[\d+ messages snipped from .+\]$/.test(msg.text)
      ) {
        newTokens += estimateTokens(msg.text);
      }
    }
  }

  return {
    messages: result,
    snippedCount,
    estimatedTokensSaved: originalTokens - newTokens,
  };
}
