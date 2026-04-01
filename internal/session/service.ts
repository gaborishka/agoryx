import type {
  Message,
  PinnedContext,
  Room,
  RoomConfig,
  TeamCheck,
  TeamRun,
  TeamRunStage,
  TeamStep,
} from "../events/types.js";
import { createId, nowIso } from "./ids.js";
import { SQLiteStore } from "../storage/sqlite.js";

const DELTA_PROMPT_MAX_CHARS = 20_000;
import type {
  AgentSession,
  CreateTeamCheckInput,
  CreateTeamRunInput,
  CreateTeamStepInput,
} from "../storage/sqlite.js";
import { buildContext, type BuiltContext } from "./context.js";
import { ContextCache } from "./context-cache.js";
import { isFeatureEnabled } from "../config/features.js";
import {
  WorkspaceCollector,
  DEFAULT_WORKSPACE_CONFIG,
  type WorkspaceConfig,
} from "../workspace/collector.js";

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

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Zа-яА-ЯіІїЇєЄґҐ']+/)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

export function extractTopics(messages: Message[]): string[] {
  const unigramFreq = new Map<string, number>();
  const bigramFreq = new Map<string, number>();

  for (const message of messages) {
    const words = tokenizeWords(message.text);
    for (const word of words) {
      unigramFreq.set(word, (unigramFreq.get(word) ?? 0) + 1);
    }

    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      bigramFreq.set(phrase, (bigramFreq.get(phrase) ?? 0) + 1);
    }
  }

  const ranked = [
    ...[...bigramFreq.entries()]
      .filter(([, count]) => count >= 2)
      .map(([term, count]) => ({ term, count })),
    ...[...unigramFreq.entries()].map(([term, count]) => ({ term, count })),
  ].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    if (right.term.length !== left.term.length) {
      return right.term.length - left.term.length;
    }
    return left.term.localeCompare(right.term);
  });

  return ranked
    .slice(0, 5)
    .map(({ term }) => term);
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

function trimFromEndAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const slice = text.slice(-maxChars);
  const firstBoundary = slice.search(/\s/);
  if (firstBoundary <= 0 || firstBoundary >= slice.length - 1) {
    return slice;
  }

  return slice.slice(firstBoundary + 1).trimStart();
}

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
    const trimmed = trimFromEndAtWordBoundary(stripped, PRIOR_SUMMARY_TRIM);
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

export interface SessionServiceOptions {
  workspace?: {
    config?: Partial<WorkspaceConfig>;
    collector?: WorkspaceCollector;
    rootCwd?: string;
    resolveAgentCwd?: (agentName: string) => string | undefined;
    pinnedDocPaths?: string[];
  };
}

export class SessionService {
  private readonly turnLocks = new Map<string, Promise<void>>();
  private readonly contextCache = new ContextCache();
  private readonly workspaceConfig: WorkspaceConfig;
  private readonly workspaceCollector: WorkspaceCollector;
  private readonly workspaceRootCwd: string;
  private readonly resolveAgentWorkspaceCwd?: (agentName: string) => string | undefined;
  private readonly workspacePinnedDocPaths: string[];

  public constructor(
    private readonly store: SQLiteStore,
    options: SessionServiceOptions = {},
  ) {
    const workspaceEnabled = options.workspace?.config
      ? options.workspace.config.enabled ?? DEFAULT_WORKSPACE_CONFIG.enabled
      : false;
    this.workspaceConfig = {
      ...DEFAULT_WORKSPACE_CONFIG,
      ...options.workspace?.config,
      enabled: workspaceEnabled,
    };
    this.workspaceCollector =
      options.workspace?.collector ?? new WorkspaceCollector(this.workspaceConfig);
    this.workspaceRootCwd = options.workspace?.rootCwd ?? process.cwd();
    this.resolveAgentWorkspaceCwd = options.workspace?.resolveAgentCwd;
    this.workspacePinnedDocPaths = options.workspace?.pinnedDocPaths ?? [];
  }

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

  public listRecentMessages(roomId: string, limit = 250): Message[] {
    return this.store.listRecentMessages(roomId, limit);
  }

  public addPinnedContext(
    roomId: string,
    label: string,
    content: string,
    pinnedBy = "user",
  ): string {
    const pin = this.store.addPinnedContext(roomId, label, content, pinnedBy);
    this.contextCache.invalidateRoom(roomId);
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
    const result = this.store.removePinnedContext(roomId, pinId);
    if (result) this.contextCache.invalidateRoom(roomId);
    return result;
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
  public buildContextMessages(room: Room, systemPrompt?: string, agentName?: string): Message[] {
    const ctx = this.buildFullContext(room, systemPrompt, agentName);
    return ctx.messages;
  }

  /**
   * Rich context build — returns full BuiltContext including token stats and truncation info.
   * Useful for diagnostics and adapters that want to inspect context metadata.
   *
   * When the CONTEXT_CACHE feature flag is enabled, the static portions of
   * context (system prompt, workspace block, pinned messages) are cached so
   * that only the dynamic conversation history needs to be rebuilt on
   * subsequent calls with the same static inputs.
   */
  public buildFullContext(room: Room, systemPrompt?: string, agentName?: string): BuiltContext {
    const workspaceBlock = this.buildWorkspaceBlock(agentName);

    // Try cache for static context (system prompt + pins + workspace)
    if (isFeatureEnabled("CONTEXT_CACHE")) {
      const pinIds = this.store.listPinnedContext(room.id).map(p => p.id);
      const cacheKey = ContextCache.buildKey(room.id, systemPrompt, pinIds, workspaceBlock);
      const cached = this.contextCache.get(cacheKey);

      if (cached) {
        // We have cached static messages — only rebuild dynamic messages
        const dynamicResult = buildContext(this.store, {
          roomId: room.id,
          // Skip static sections (already cached)
          systemPrompt: undefined,
          workspaceBlock: undefined,
          skipPins: true,
          maxHistoryMessages: room.config.maxHistoryMessages,
          checkpointThreshold: room.config.checkpointThreshold,
          // Reduce token budget by cached static tokens
          maxContextTokens: room.config.maxContextTokens - cached.tokenCount,
        });

        return {
          messages: [...cached.messages, ...dynamicResult.messages],
          systemPrompt: systemPrompt ?? null,
          truncated: dynamicResult.truncated,
          totalEstimatedTokens: cached.tokenCount + dynamicResult.totalEstimatedTokens,
        };
      }
    }

    // Full context build (no cache or cache miss)
    const result = buildContext(this.store, {
      roomId: room.id,
      systemPrompt,
      workspaceBlock,
      maxHistoryMessages: room.config.maxHistoryMessages,
      checkpointThreshold: room.config.checkpointThreshold,
      maxContextTokens: room.config.maxContextTokens,
    });

    // Populate cache for next time
    if (isFeatureEnabled("CONTEXT_CACHE")) {
      const pinIds = this.store.listPinnedContext(room.id).map(p => p.id);
      const cacheKey = ContextCache.buildKey(room.id, systemPrompt, pinIds, workspaceBlock);
      // Extract static messages: system prompt, workspace context, and pinned context blocks
      const trueStaticMessages = result.messages.filter(m =>
        m.id === "system-prompt" ||
        m.id === "workspace-context" ||
        (m.role === "system" && m.text.startsWith("[Pinned:"))
      );
      if (trueStaticMessages.length > 0) {
        let tokenCount = 0;
        for (const m of trueStaticMessages) {
          tokenCount += Math.ceil(m.text.length / 4);
        }
        this.contextCache.set(cacheKey, {
          messages: trueStaticMessages,
          tokenCount,
          hash: cacheKey,
          cachedAt: Date.now(),
        });
      }
    }

    return result;
  }

  public buildDeltaPrompt(
    room: Room,
    agentName: string,
    lastSeenSeq: number | null,
    systemPrompt?: string,
  ): { prompt: string; cutoffSeq: number | null } {
    const cutoffSeq = this.store.getMaxMessageSeq(room.id);

    if (lastSeenSeq === null) {
      const messages = this.buildContextMessages(room, systemPrompt, agentName);
      const prompt = messages
        .map((message) => `[${message.author}] ${message.text}`)
        .join("\n\n")
        .slice(-DELTA_PROMPT_MAX_CHARS);
      return { prompt, cutoffSeq };
    }

    if (cutoffSeq === null) {
      return { prompt: "", cutoffSeq: null };
    }

    const delta = this.store.listMessagesDelta(
      room.id,
      lastSeenSeq,
      cutoffSeq,
      `agent.${agentName}`,
    );
    if (delta.length === 0) {
      return { prompt: "", cutoffSeq };
    }

    const workspaceBlock = this.buildWorkspaceBlock(agentName);
    const promptParts = [
      ...(workspaceBlock ? [workspaceBlock, ""] : []),
      "[Team context since your last response]",
      ...delta.map((message) => `- [${message.author}][${message.id}] ${message.text}`),
    ];
    const prompt = promptParts.join("\n");

    return { prompt, cutoffSeq };
  }

  public async acquireTurnLock<T>(
    roomId: string,
    agentName: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${roomId}:${agentName}`;
    const previous = this.turnLocks.get(key) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.turnLocks.set(key, settled);

    try {
      return await current;
    } finally {
      if (this.turnLocks.get(key) === settled) {
        this.turnLocks.delete(key);
      }
    }
  }

  public getOrCreateAgentSession(roomId: string, agentName: string): AgentSession {
    return (
      this.store.getActiveAgentSession(roomId, agentName) ??
      this.store.createAgentSession(roomId, agentName)
    );
  }

  public listActiveAgentSessions(roomId: string): AgentSession[] {
    return this.store.listActiveAgentSessions(roomId);
  }

  public updateAgentSessionNativeId(id: string, nativeId: string): void {
    this.store.updateAgentSessionNativeId(id, nativeId);
  }

  public updateAgentSessionCursor(id: string, seq: number): void {
    this.store.updateAgentSessionCursor(id, seq);
  }

  public updateAgentSessionStatus(id: string, status: AgentSession["status"]): void {
    this.store.updateAgentSessionStatus(id, status);
  }

  public incrementAgentSessionFailCount(id: string): number {
    return this.store.incrementAgentSessionFailCount(id);
  }

  public createTeamRun(input: Omit<CreateTeamRunInput, "stage"> & { stage?: TeamRunStage }): TeamRun {
    return this.store.createTeamRun({
      ...input,
      stage: input.stage ?? "debate",
    });
  }

  public getTeamRun(runId: string): TeamRun | null {
    return this.store.getTeamRun(runId);
  }

  public getActiveTeamRun(roomId: string): TeamRun | null {
    return this.store.getActiveTeamRun(roomId);
  }

  public getLatestTeamRun(roomId: string): TeamRun | null {
    return this.store.getLatestTeamRun(roomId);
  }

  public getLatestResumableTeamRun(roomId: string): TeamRun | null {
    return this.store.getLatestResumableTeamRun(roomId);
  }

  public updateTeamRunStatus(
    runId: string,
    status: TeamRun["status"],
    options?: { stage?: TeamRunStage; finalSummary?: string | null; completedAt?: string | null },
  ): void {
    this.store.updateTeamRunStatus(runId, status, options);
  }

  public updateTeamRunProgress(
    runId: string,
    updates: {
      stage?: TeamRunStage;
      stepCount?: number;
      noProgressCount?: number;
      finalSummary?: string | null;
    },
  ): void {
    this.store.updateTeamRunProgress(runId, updates);
  }

  public addTeamStep(input: CreateTeamStepInput): TeamStep {
    return this.store.addTeamStep(input);
  }

  public listTeamSteps(runId: string, limit = 50): TeamStep[] {
    return this.store.listTeamSteps(runId, limit);
  }

  public enqueueTeamFeedback(runId: string, messageId: string, feedbackText: string): void {
    this.store.enqueueTeamFeedback(runId, messageId, feedbackText);
  }

  public listPendingTeamFeedback(runId: string, limit = 20) {
    return this.store.listPendingTeamFeedback(runId, limit);
  }

  public countPendingTeamFeedback(runId: string): number {
    return this.store.countPendingTeamFeedback(runId);
  }

  public consumeTeamFeedback(ids: string[]): void {
    this.store.consumeTeamFeedback(ids);
  }

  public addTeamCheck(input: CreateTeamCheckInput): TeamCheck {
    return this.store.addTeamCheck(input);
  }

  public listTeamChecks(runId: string, limit = 20): TeamCheck[] {
    return this.store.listTeamChecks(runId, limit);
  }

  public buildTeamPrompt(
    room: Room,
    run: TeamRun,
    stage: TeamRunStage,
    actor: string,
    opts: {
      instructions: string;
      latestStepsLimit?: number;
      pendingFeedbackLimit?: number;
      tailMessagesLimit?: number;
    },
  ): string {
    const latestSteps = this.listTeamSteps(run.id, opts.latestStepsLimit ?? 6);
    const pendingFeedback = this.listPendingTeamFeedback(run.id, opts.pendingFeedbackLimit ?? 6);
    const tailMessages = this.listRecentMessages(room.id, opts.tailMessagesLimit ?? 20)
      .filter((message) => message.author === "user")
      .slice(-6);
    const workspaceBlock = this.buildWorkspaceBlock(actor);

    const parts: string[] = [
      ...(workspaceBlock ? [workspaceBlock, ""] : []),
      `[Team run ${run.id}]`,
      `Stage: ${stage}`,
      `Actor: ${actor}`,
      `Goal: ${run.goal}`,
      "",
      "[Instructions]",
      opts.instructions,
    ];

    if (latestSteps.length > 0) {
      parts.push("", "[Recent team steps]");
      for (const step of latestSteps) {
        const preview = step.outputText.replace(/\s+/g, " ").slice(0, 320);
        parts.push(
          `- #${step.seq} ${step.stage} ${step.actor} result=${step.result}` +
            (step.errorClass ? ` error=${step.errorClass}` : ""),
        );
        if (preview) {
          parts.push(`  ${preview}`);
        }
      }
    }

    if (pendingFeedback.length > 0) {
      parts.push("", "[Pending human feedback]");
      for (const feedback of pendingFeedback) {
        parts.push(`- (${feedback.messageId}) ${feedback.feedbackText}`);
      }
    }

    if (tailMessages.length > 0) {
      parts.push("", "[Recent user context]");
      for (const message of tailMessages) {
        parts.push(`- [${message.author}] ${message.text}`);
      }
    }

    return parts.join("\n");
  }

  private buildWorkspaceBlock(agentName?: string): string | undefined {
    if (!this.workspaceConfig.enabled) {
      return undefined;
    }

    const agentCwd = agentName ? this.resolveAgentWorkspaceCwd?.(agentName) : undefined;
    const cwd = agentCwd ?? this.workspaceRootCwd;
    if (!cwd) {
      return undefined;
    }

    try {
      const context = this.workspaceCollector.collectAlwaysOn(cwd, this.workspacePinnedDocPaths);
      return this.workspaceCollector.format(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `[Workspace unavailable: ${message}]`;
    }
  }

  public consumeTeamFeedbackForRun(runId: string, limit = 20): string[] {
    const items = this.listPendingTeamFeedback(runId, limit);
    const ids = items.map((item) => item.id);
    this.consumeTeamFeedback(ids);
    return ids;
  }

  public maybeCreateCheckpoint(room: Room, force?: boolean): string | null {
    // Determine uncovered messages (INV-5: no window dependency for dedup)
    const coverage = this.store.getCheckpointCoverage(room.id);
    let uncoveredMessages: Message[];
    let allConversationMessages: Message[] | null = null;
    const minRequired = force ? 2 : room.config.checkpointThreshold;

    if (coverage) {
      // Targeted query: messages after last checkpoint's endpoint (no window limit)
      const afterCheckpoint = this.store.listMessagesAfter(room.id, coverage.toMessageId);
      uncoveredMessages = afterCheckpoint.filter(
        (m) => m.role === "assistant" || m.role === "user",
      );
      // Dedup: nothing new since last checkpoint
      if (uncoveredMessages.length === 0) return null;
      // Threshold check (INV-2)
      if (uncoveredMessages.length < minRequired) return null;
    } else {
      // No previous checkpoint: count conversation turns and load only those roles
      // from the tail without a fixed ceiling.
      const conversationCount = this.store.countMessages(room.id, ["user", "assistant"]);
      if (conversationCount === 0 || conversationCount < minRequired) return null;

      allConversationMessages = this.store.listRecentMessagesByRoles(
        room.id,
        ["user", "assistant"],
        conversationCount,
      );
      if (allConversationMessages.length === 0) return null;
      uncoveredMessages = allConversationMessages;
    }

    // Get previous summary for cumulative checkpoint
    const prevCheckpoint = this.store.getLatestCheckpoint(room.id);
    const previousSummary = prevCheckpoint?.summaryText;

    // Build structured summary
    const summaryText = buildStructuredSummary(uncoveredMessages, previousSummary);

    // Range (INV-1): preserve fromMessageId from previous coverage
    const firstMsgId = allConversationMessages?.[0]?.id ?? uncoveredMessages[0]?.id;
    const fromMessageId = coverage?.fromMessageId ?? firstMsgId;
    // toMessageId = last conversation message (including uncovered)
    const lastMessages = allConversationMessages ?? uncoveredMessages;
    const toMessageId = lastMessages[lastMessages.length - 1]?.id;
    if (!fromMessageId || !toMessageId) {
      return null;
    }

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
