import util from "node:util";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { AdapterEvent } from "../../internal/adapters/adapter.js";
import type { ChatRuntimeConfig } from "../../internal/config/default.js";
import type { OrchestrationMode } from "../../internal/events/types.js";
import { sanitizeRenderedDelta } from "../../internal/rendering/sanitize.js";
import {
  describeSessionBinding,
  extractPayloadText,
  formatSessionId,
  normalizeStatusText,
} from "./render-helpers.js";

export interface SlashCommandHint {
  command: string;
  description: string;
}

type LineKind = "info" | "error" | "status" | "agent";
type ConsoleSink = ((kind: "info" | "error", line: string) => void) | null;
type PickerMode = "slash" | "command";

interface InkLine {
  id: number;
  kind: LineKind;
  text: string;
}

interface InkChatOptions {
  version: string;
  roomId: string;
  sessionId: string;
  mode: OrchestrationMode;
  richUi: boolean;
  hideSystem: boolean;
  agents: string[];
  adapterConfig: ChatRuntimeConfig["adapterConfig"];
  slashCommands: SlashCommandHint[];
  getMode: () => OrchestrationMode;
  submitLine: (line: string) => Promise<boolean>;
  interruptActiveRun: () => Promise<string | null>;
  attachAdapterEventSink: (
    sink: ((adapterName: string, event: AdapterEvent) => void) | null,
  ) => void;
}

interface InkChatAppProps extends InkChatOptions {
  bindConsoleSink: (sink: ConsoleSink) => void;
}

interface AdapterErrorPayload {
  class?: string;
  message?: string;
}

interface AdapterLiveState {
  statusText: string;
  startedAtMs: number;
  lastActivityMs: number;
  lastSessionId: string | null;
  sessionStatusText: string | null;
  insideSystemReminder: boolean;
}

const MAX_RENDERED_LINES = 220;
const MAX_PROMPT_HISTORY = 50;
const ACTIVE_PREVIEW_MAX_LINES = 6;
const ACTIVE_PREVIEW_MAX_TOTAL_CHARS = 500;
const ACTIVE_PREVIEW_MAX_LINE_CHARS = 160;
const ACTIVE_PREVIEW_WRAP_CHARS = 88;
const FINAL_MESSAGE_WRAP_CHARS = 100;
const SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;
const CLAUDE_LIKE_RULE_WIDTH = 96;

const wrapLine = (line: string, width: number): string[] => {
  if (line.length <= width) {
    return [line];
  }

  const wrapped: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const slice = remaining.slice(0, width + 1);
    const breakAt = slice.lastIndexOf(" ");
    const splitAt = breakAt > Math.floor(width * 0.45) ? breakAt : width;
    wrapped.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    wrapped.push(remaining);
  }
  return wrapped.length > 0 ? wrapped : [line];
};

const wrapTextLines = (text: string, width: number): string[] =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => (line.length === 0 ? [""] : wrapLine(line, width)));

const formatActivePreviewLines = (text: string): string[] => {
  if (!text.trim()) {
    return [];
  }

  const normalized = text.replace(/\r\n/g, "\n");
  const tailText =
    normalized.length <= ACTIVE_PREVIEW_MAX_TOTAL_CHARS
      ? normalized
      : `...${normalized.slice(-(ACTIVE_PREVIEW_MAX_TOTAL_CHARS - 3))}`;

  const lines = tailText
    .split("\n")
    .map((line) => line.replace(/\t/g, "  "))
    .filter((line, index, array) => !(line.trim().length === 0 && (index === 0 || index === array.length - 1)));

  const wrapped = lines.flatMap((line) => wrapLine(line, ACTIVE_PREVIEW_WRAP_CHARS));
  return wrapped
    .slice(-ACTIVE_PREVIEW_MAX_LINES)
    .map((line) =>
      line.length <= ACTIVE_PREVIEW_MAX_LINE_CHARS
        ? line
        : `${line.slice(0, ACTIVE_PREVIEW_MAX_LINE_CHARS - 3)}...`
    );
};

const formatElapsed = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
};

const formatTokenEstimate = (tokenCount: number): string => {
  if (tokenCount >= 1_000) {
    return `${(tokenCount / 1_000).toFixed(1)}k tokens`;
  }
  return `${tokenCount} tokens`;
};

const makeRule = (width = CLAUDE_LIKE_RULE_WIDTH): string =>
  "─".repeat(Math.max(24, width));

const trimPreview = (value: string, max = 88): string =>
  value.length <= max ? value : `${value.slice(0, max - 3)}...`;

const getStaticTip = (mode: OrchestrationMode): string =>
  mode === "team"
    ? "Press Esc to interrupt an active run. Press Ctrl+P for command palette."
    : "Press Ctrl+P for command palette, or / on an empty prompt for slash picker.";

const isExpectedCancellationError = (payload: AdapterErrorPayload): boolean => {
  const label = payload.class ?? "";
  const message = payload.message ?? "";
  if (label !== "PROCESS_CRASH") {
    return false;
  }
  return /cancelled/i.test(message);
};

const normalizeHeadlineStatus = (statusText: string): string => {
  const compact = statusText.trim();
  if (!compact || compact === "generating...") {
    return "Combobulating...";
  }
  if (compact.endsWith("...")) {
    return compact;
  }
  return `${compact}...`;
};

const getSlashSuggestions = (
  hints: SlashCommandHint[],
  query: string,
  limit = 8,
): SlashCommandHint[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized === "/") {
    return hints.slice(0, limit);
  }

  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const prefixMatches = hints.filter((entry) => entry.command.startsWith(prefixed));
  if (prefixMatches.length > 0) {
    return prefixMatches.slice(0, limit);
  }

  const needle = prefixed.slice(1);
  return hints
    .filter((entry) => entry.command.includes(needle))
    .slice(0, limit);
};

const getCommandSuggestions = (
  hints: SlashCommandHint[],
  query: string,
  limit = 8,
): SlashCommandHint[] => {
  const normalized = query.trim().toLowerCase().replace(/^\//, "");
  if (!normalized) {
    return hints.slice(0, limit);
  }

  return hints
    .map((entry) => {
      const command = entry.command.toLowerCase();
      const bareCommand = command.startsWith("/") ? command.slice(1) : command;
      const description = entry.description.toLowerCase();

      let rank = 99;
      if (bareCommand === normalized) {
        rank = 0;
      } else if (bareCommand.startsWith(normalized)) {
        rank = 1;
      } else if (bareCommand.includes(normalized)) {
        rank = 2;
      } else if (description.includes(normalized)) {
        rank = 3;
      }

      return {
        entry,
        rank,
      };
    })
    .filter((item) => item.rank < 99)
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      return left.entry.command.localeCompare(right.entry.command);
    })
    .slice(0, limit)
    .map((item) => item.entry);
};

const insertIntoDraft = (
  draft: string,
  cursorIndex: number,
  insertedText: string,
): { draft: string; cursorIndex: number } => {
  const before = draft.slice(0, cursorIndex);
  const after = draft.slice(cursorIndex);
  const nextDraft = `${before}${insertedText}${after}`;
  return {
    draft: nextDraft,
    cursorIndex: cursorIndex + insertedText.length,
  };
};

const removePreviousChar = (
  draft: string,
  cursorIndex: number,
): { draft: string; cursorIndex: number } => {
  if (cursorIndex <= 0) {
    return { draft, cursorIndex };
  }
  return {
    draft: `${draft.slice(0, cursorIndex - 1)}${draft.slice(cursorIndex)}`,
    cursorIndex: cursorIndex - 1,
  };
};

const removeNextChar = (
  draft: string,
  cursorIndex: number,
): { draft: string; cursorIndex: number } => {
  if (cursorIndex >= draft.length) {
    return { draft, cursorIndex };
  }
  return {
    draft: `${draft.slice(0, cursorIndex)}${draft.slice(cursorIndex + 1)}`,
    cursorIndex,
  };
};

const appendLines = (
  previous: InkLine[],
  idRef: React.MutableRefObject<number>,
  kind: LineKind,
  text: string,
): InkLine[] => {
  const normalized = text.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n");
  const added: InkLine[] = [];
  for (const chunk of chunks) {
    added.push({
      id: idRef.current,
      kind,
      text: chunk,
    });
    idRef.current += 1;
  }

  const merged = [...previous, ...added];
  if (merged.length <= MAX_RENDERED_LINES) {
    return merged;
  }
  return merged.slice(merged.length - MAX_RENDERED_LINES);
};

const isPrintableChar = (value: string): boolean =>
  value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

const isBackspaceKey = (
  value: string,
  key: { backspace?: boolean; ctrl?: boolean; delete?: boolean },
): boolean =>
  key.backspace === true ||
  (key.delete === true && value.length === 0) || // some terminals map Backspace as key.delete
  value === "\u007f" || // DEL (common Backspace in many terminals)
  value === "\u0008" || // Ctrl+H
  (key.ctrl === true && value.toLowerCase() === "h");

const lineColor = (kind: LineKind): "red" | "cyan" | "green" | "white" => {
  switch (kind) {
    case "error":
      return "red";
    case "status":
      return "cyan";
    case "agent":
      return "green";
    default:
      return "white";
  }
};

const InkChatApp = ({
  version,
  roomId,
  sessionId,
  mode,
  richUi,
  hideSystem,
  agents,
  adapterConfig,
  slashCommands,
  getMode,
  submitLine,
  interruptActiveRun,
  attachAdapterEventSink,
  bindConsoleSink,
}: InkChatAppProps): React.JSX.Element => {
  const { exit } = useApp();
  const [currentMode, setCurrentMode] = useState<OrchestrationMode>(mode);
  const [lines, setLines] = useState<InkLine[]>([]);
  const [draft, setDraft] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<PickerMode>("slash");
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerIndex, setPickerIndex] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [frameTick, setFrameTick] = useState(0);
  const [lastSubmittedLine, setLastSubmittedLine] = useState<string>("");
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const nextLineId = useRef(1);
  const pendingTextByAdapter = useRef(new Map<string, string>());
  const liveStateByAdapter = useRef(new Map<string, AdapterLiveState>());
  const lastInterruptAtMs = useRef(0);
  const historyDraftSnapshot = useRef<string>("");

  const pushLine = useCallback((kind: LineKind, text: string): void => {
    if (!text) {
      return;
    }
    setLines((previous) => appendLines(previous, nextLineId, kind, text));
  }, []);

  const bumpFrame = useCallback(() => {
    setFrameTick((previous) => previous + 1);
  }, []);

  const ensureLiveState = useCallback((adapterName: string): AdapterLiveState => {
    const existing = liveStateByAdapter.current.get(adapterName);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const created: AdapterLiveState = {
      statusText: "generating...",
      startedAtMs: now,
      lastActivityMs: now,
      lastSessionId: null,
      sessionStatusText: null,
      insideSystemReminder: false,
    };
    liveStateByAdapter.current.set(adapterName, created);
    return created;
  }, []);

  useEffect(() => {
    if (!richUi || hideSystem || activeCount === 0) {
      return;
    }
    const timer = setInterval(() => {
      setFrameTick((previous) => previous + 1);
    }, 120);
    return () => {
      clearInterval(timer);
    };
  }, [activeCount, hideSystem, richUi]);

  const suggestions = useMemo(() => {
    if (pickerMode === "command") {
      return getCommandSuggestions(slashCommands, pickerQuery, 8);
    }
    return getSlashSuggestions(slashCommands, pickerQuery ? `/${pickerQuery}` : "/", 8);
  }, [pickerMode, pickerQuery, slashCommands]);

  useEffect(() => {
    bindConsoleSink((kind, line) => {
      pushLine(kind === "error" ? "error" : "info", line);
    });
    return () => {
      bindConsoleSink(null);
    };
  }, [bindConsoleSink, pushLine]);

  useEffect(() => {
    const sink = (adapterName: string, event: AdapterEvent): void => {
      switch (event.type) {
        case "message.started": {
          const now = Date.now();
          const previous = liveStateByAdapter.current.get(adapterName);
          liveStateByAdapter.current.set(adapterName, {
            statusText: "generating...",
            startedAtMs: now,
            lastActivityMs: now,
            lastSessionId: previous?.lastSessionId ?? null,
            sessionStatusText: previous?.sessionStatusText ?? null,
            insideSystemReminder: false,
          });
          pendingTextByAdapter.current.set(adapterName, "");
          setActiveCount(liveStateByAdapter.current.size);
          if (!hideSystem && !richUi) {
            pushLine("status", `[${adapterName}] generating...`);
          }
          bumpFrame();
          return;
        }
        case "message.delta": {
          const deltaRaw = extractPayloadText(event.payload);
          if (!deltaRaw) {
            return;
          }
          const state = ensureLiveState(adapterName);
          const { text, statusText } = sanitizeRenderedDelta(
            deltaRaw,
            state,
            getMode(),
          );
          const now = Date.now();
          if (statusText) {
            const normalizedStatus = normalizeStatusText(statusText);
            if (normalizedStatus) {
              state.statusText = normalizedStatus;
            }
            state.lastActivityMs = now;
          }
          if (text) {
            const current = pendingTextByAdapter.current.get(adapterName) ?? "";
            pendingTextByAdapter.current.set(adapterName, `${current}${text}`);
            state.lastActivityMs = now;
          }
          return;
        }
        case "session.bound": {
          const state = ensureLiveState(adapterName);
          const payload = event.payload as { nativeSessionId?: string };
          const nativeSessionId = payload.nativeSessionId;
          if (!nativeSessionId) {
            return;
          }
          if (state.lastSessionId === nativeSessionId) {
            return;
          }
          const label = describeSessionBinding(state.lastSessionId, nativeSessionId);
          state.lastSessionId = nativeSessionId;
          state.sessionStatusText = `${label} (${formatSessionId(nativeSessionId)})`;
          state.lastActivityMs = Date.now();
          if (!hideSystem && !richUi) {
            pushLine(
              "status",
              `[${adapterName}] ${label} (${formatSessionId(nativeSessionId)})`,
            );
          }
          bumpFrame();
          return;
        }
        case "message.completed": {
          const state = ensureLiveState(adapterName);
          const accumulated = pendingTextByAdapter.current.get(adapterName) ?? "";
          const completedRaw = extractPayloadText(event.payload);
          const completedSanitized = completedRaw
            ? sanitizeRenderedDelta(completedRaw, state, getMode()).text
            : "";
          const rendered = completedSanitized.trim().length > 0 ? completedSanitized : accumulated;
          const normalizedFinalText = rendered.replace(/^\n+/, "").trimEnd();
          const finalText = normalizedFinalText.length > 0 ? normalizedFinalText : "(empty response)";
          const wrappedFinal = wrapTextLines(finalText, FINAL_MESSAGE_WRAP_CHARS).join("\n");
          pushLine("agent", `${adapterName}:`);
          pushLine("agent", wrappedFinal);
          pendingTextByAdapter.current.delete(adapterName);
          liveStateByAdapter.current.delete(adapterName);
          setActiveCount(liveStateByAdapter.current.size);
          if (!hideSystem) {
            pushLine("status", `[${adapterName}] done`);
          }
          bumpFrame();
          return;
        }
        case "message.error": {
          pendingTextByAdapter.current.delete(adapterName);
          liveStateByAdapter.current.delete(adapterName);
          setActiveCount(liveStateByAdapter.current.size);
          const payload = event.payload as AdapterErrorPayload;
          const label = payload.class ?? "UNKNOWN";
          const message = payload.message ?? "unknown error";
          if (isExpectedCancellationError(payload)) {
            if (!hideSystem) {
              pushLine("status", `[${adapterName}] cancelled`);
            }
          } else {
            pushLine("error", `[${adapterName}] error (${label}): ${message}`);
          }
          bumpFrame();
          return;
        }
        default:
          return;
      }
    };
    attachAdapterEventSink(sink);
    return () => {
      attachAdapterEventSink(null);
    };
  }, [attachAdapterEventSink, bumpFrame, ensureLiveState, getMode, hideSystem, pushLine, richUi]);

  const resetHistoryNavigation = useCallback((): void => {
    setHistoryIndex(-1);
    historyDraftSnapshot.current = "";
  }, []);

  const setDraftWithCursor = useCallback((nextDraft: string, nextCursor: number): void => {
    setDraft(nextDraft);
    setCursorIndex(Math.max(0, Math.min(nextCursor, nextDraft.length)));
  }, []);

  const openSlashPicker = useCallback((): void => {
    setPickerOpen(true);
    setPickerMode("slash");
    setPickerQuery("");
    setPickerIndex(0);
  }, []);

  const openCommandPicker = useCallback((): void => {
    setPickerOpen(true);
    setPickerMode("command");
    setPickerQuery("");
    setPickerIndex(0);
  }, []);

  const applyPickerSelection = useCallback((): void => {
    if (suggestions.length === 0) {
      setPickerOpen(false);
      setPickerMode("slash");
      setPickerQuery("");
      setPickerIndex(0);
      return;
    }
    const selected = suggestions[pickerIndex] ?? suggestions[0];
    if (selected) {
      setDraftWithCursor(selected.command, selected.command.length);
      resetHistoryNavigation();
    }
    setPickerOpen(false);
    setPickerMode("slash");
    setPickerQuery("");
    setPickerIndex(0);
  }, [pickerIndex, resetHistoryNavigation, setDraftWithCursor, suggestions]);

  const submitDraft = useCallback(async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }

    const rawLine = draft;
    setDraftWithCursor("", 0);
    resetHistoryNavigation();
    if (!rawLine.trim()) {
      return;
    }
    const normalized = rawLine.trim();
    setLastSubmittedLine(normalized);
    setPromptHistory((previous) => {
      const deduplicated = previous.filter((entry) => entry !== normalized);
      const next = [...deduplicated, normalized];
      if (next.length <= MAX_PROMPT_HISTORY) {
        return next;
      }
      return next.slice(next.length - MAX_PROMPT_HISTORY);
    });
    pushLine("info", `> ${rawLine}`);

    setIsSubmitting(true);
    try {
      const shouldContinue = await submitLine(rawLine);
      setCurrentMode(getMode());
      if (!shouldContinue) {
        exit();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLine("error", `submit failed: ${message}`);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    draft,
    exit,
    getMode,
    isSubmitting,
    pushLine,
    resetHistoryNavigation,
    setDraftWithCursor,
    submitLine,
  ]);

  const triggerInterrupt = useCallback(async (): Promise<void> => {
    if (isInterrupting || currentMode !== "team") {
      return;
    }
    const now = Date.now();
    if (now - lastInterruptAtMs.current < 450) {
      return;
    }
    lastInterruptAtMs.current = now;
    setIsInterrupting(true);
    try {
      const message = await interruptActiveRun();
      if (message) {
        pushLine("status", message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushLine("error", `interrupt failed: ${message}`);
    } finally {
      setIsInterrupting(false);
    }
  }, [currentMode, interruptActiveRun, isInterrupting, pushLine]);

  useInput((value, key) => {
    const normalizedValue = value.toLowerCase();
    if (key.ctrl && normalizedValue === "c") {
      exit();
      return;
    }

    if (key.ctrl && normalizedValue === "p" && !pickerOpen) {
      openCommandPicker();
      return;
    }

    if (pickerOpen) {
      if (key.escape) {
        setPickerOpen(false);
        setPickerMode("slash");
        setPickerQuery("");
        setPickerIndex(0);
        return;
      }
      if (key.return || key.tab) {
        applyPickerSelection();
        return;
      }
      if (key.upArrow) {
        if (suggestions.length > 0) {
          setPickerIndex((previous) =>
            (previous - 1 + suggestions.length) % suggestions.length
          );
        }
        return;
      }
      if (key.downArrow) {
        if (suggestions.length > 0) {
          setPickerIndex((previous) => (previous + 1) % suggestions.length);
        }
        return;
      }
      if (isBackspaceKey(value, key)) {
        if (pickerQuery.length === 0) {
          setPickerOpen(false);
          setPickerMode("slash");
          return;
        }
        setPickerQuery((previous) => previous.slice(0, -1));
        setPickerIndex(0);
        return;
      }
      if (isPrintableChar(value) && /^[a-zA-Z0-9._/-]+$/.test(value)) {
        setPickerQuery((previous) => `${previous}${value}`);
        setPickerIndex(0);
      }
      return;
    }

    if (key.return) {
      void submitDraft();
      return;
    }
    if (key.escape && !key.meta && !key.ctrl) {
      void triggerInterrupt();
      return;
    }

    if (key.upArrow || key.downArrow) {
      if (promptHistory.length === 0) {
        return;
      }

      if (key.upArrow) {
        if (historyIndex === -1) {
          historyDraftSnapshot.current = draft;
          const nextIndex = promptHistory.length - 1;
          const nextDraft = promptHistory[nextIndex] ?? "";
          setHistoryIndex(nextIndex);
          setDraftWithCursor(nextDraft, nextDraft.length);
          return;
        }

        const nextIndex = Math.max(0, historyIndex - 1);
        const nextDraft = promptHistory[nextIndex] ?? "";
        setHistoryIndex(nextIndex);
        setDraftWithCursor(nextDraft, nextDraft.length);
        return;
      }

      if (historyIndex === -1) {
        return;
      }

      if (historyIndex < promptHistory.length - 1) {
        const nextIndex = historyIndex + 1;
        const nextDraft = promptHistory[nextIndex] ?? "";
        setHistoryIndex(nextIndex);
        setDraftWithCursor(nextDraft, nextDraft.length);
        return;
      }

      const restored = historyDraftSnapshot.current;
      resetHistoryNavigation();
      setDraftWithCursor(restored, restored.length);
      return;
    }

    if (key.leftArrow) {
      setCursorIndex((previous) => Math.max(0, previous - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorIndex((previous) => Math.min(draft.length, previous + 1));
      return;
    }

    if (key.ctrl && normalizedValue === "a") {
      setCursorIndex(0);
      return;
    }
    if (key.ctrl && normalizedValue === "e") {
      setCursorIndex(draft.length);
      return;
    }
    if (key.ctrl && normalizedValue === "u") {
      const nextDraft = draft.slice(cursorIndex);
      resetHistoryNavigation();
      setDraftWithCursor(nextDraft, 0);
      return;
    }
    if (key.ctrl && normalizedValue === "k") {
      const nextDraft = draft.slice(0, cursorIndex);
      resetHistoryNavigation();
      setDraftWithCursor(nextDraft, nextDraft.length);
      return;
    }
    if (key.ctrl && normalizedValue === "d") {
      const next = removeNextChar(draft, cursorIndex);
      if (next.draft !== draft || next.cursorIndex !== cursorIndex) {
        resetHistoryNavigation();
        setDraftWithCursor(next.draft, next.cursorIndex);
      }
      return;
    }

    if (isBackspaceKey(value, key)) {
      const next = removePreviousChar(draft, cursorIndex);
      if (next.draft !== draft || next.cursorIndex !== cursorIndex) {
        resetHistoryNavigation();
        setDraftWithCursor(next.draft, next.cursorIndex);
      }
      return;
    }

    if (key.tab) {
      const lookup = draft.trim().length > 0 ? draft : "/";
      const next = getSlashSuggestions(slashCommands, lookup, 1)[0];
      if (next) {
        resetHistoryNavigation();
        setDraftWithCursor(next.command, next.command.length);
      }
      return;
    }

    if (value === "/" && draft.trim() === "" && cursorIndex === 0) {
      openSlashPicker();
      return;
    }

    if (isPrintableChar(value)) {
      const next = insertIntoDraft(draft, cursorIndex, value);
      resetHistoryNavigation();
      setDraftWithCursor(next.draft, next.cursorIndex);
    }
  });

  const activeEntries = richUi && !hideSystem
    ? [...liveStateByAdapter.current.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )
    : [];

  const headerRule = useMemo(() => makeRule(), []);
  const hasActiveWork = activeEntries.length > 0;
  const activePreviewRaw = useMemo(
    () =>
      activeEntries
        .map(([adapterName]) => pendingTextByAdapter.current.get(adapterName) ?? "")
        .join("\n"),
    [activeEntries, frameTick],
  );
  const estimatedTokens = Math.max(
    1,
    Math.round(Math.max(0, activePreviewRaw.length) / 4),
  );
  const elapsedSeconds = hasActiveWork
    ? Math.max(
      0,
      Math.floor(
        (Date.now() - Math.min(...activeEntries.map(([, state]) => state.startedAtMs))) / 1000,
      ),
    )
    : 0;
  const activeAgentNames = hasActiveWork
    ? activeEntries.map(([adapterName]) => adapterName).join(", ")
    : "";
  const primaryStatus = hasActiveWork
    ? normalizeHeadlineStatus(activeEntries[0]?.[1].statusText ?? "generating...")
    : "Ready";
  const primaryAgent = activeEntries[0]?.[0] ?? "";
  const headerTitle = hasActiveWork
    ? `${primaryAgent}: ${primaryStatus} (${formatElapsed(elapsedSeconds)} · ↓ ${formatTokenEstimate(estimatedTokens)})`
    : "Ready";
  const tipText = getStaticTip(currentMode);
  const activeAgentLines = hasActiveWork
    ? activeEntries.map(([adapterName, state]) => {
      const sessionSuffix = state.sessionStatusText ? ` · ${state.sessionStatusText}` : "";
      return `${adapterName}: ${state.statusText}${sessionSuffix}`;
    })
    : [];
  const shouldShowRunningLine = hasActiveWork || isSubmitting || isInterrupting;
  const commandPreview = trimPreview(lastSubmittedLine || "waiting for input");

  return (
    <Box flexDirection="column">
      <Text color={hasActiveWork ? "yellow" : "gray"}>{headerTitle}</Text>
      <Text dimColor>└ Tip: {tipText}</Text>
      <Text dimColor>{headerRule}</Text>
      {activeAgentLines.length > 0 ? (
        <Box flexDirection="column">
          {activeAgentLines.map((line, index) => (
            <Text key={`${line}-${index}`} color="cyan">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box flexDirection="column">
        {lines.length === 0 ? <Text dimColor>Type /help for commands.</Text> : null}
        {lines.map((line) => (
          <Text key={line.id} color={lineColor(line.kind)}>
            {line.text}
          </Text>
        ))}
      </Box>

      {pickerOpen ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">
            {pickerMode === "command" ? "commands> " : "/ "}
            {pickerQuery}
          </Text>
          <Text dimColor>
            {pickerMode === "command"
              ? "Enter to insert command. Esc to close."
              : "Enter to insert slash command. Esc to close."}
          </Text>
          {suggestions.length === 0 ? (
            <Text dimColor>  (no matches)</Text>
          ) : (
            suggestions.map((item, index) => (
              <Text key={item.command} color={index === pickerIndex ? "green" : "white"}>
                {index === pickerIndex ? "›" : " "} {item.command}  {item.description}
              </Text>
            ))
          )}
        </Box>
      ) : null}

      <Text dimColor>{headerRule}</Text>
      <Box>
        <Text color="white">› </Text>
        <Text>{draft.slice(0, cursorIndex)}</Text>
        <Text inverse>{draft[cursorIndex] ?? " "}</Text>
        <Text>{draft.slice(cursorIndex + 1)}</Text>
        {isSubmitting ? <Text dimColor> (running)</Text> : null}
      </Box>

      {shouldShowRunningLine ? (
        <Text color="cyan">
          {commandPreview}{" "}
          <Text dimColor>
            ({isInterrupting ? "interrupting" : "running"})
            {hasActiveWork ? ` · active: ${activeAgentNames}` : ""}
            {currentMode === "team" ? " · esc to interrupt" : ""}
          </Text>
        </Text>
      ) : null}
      {!shouldShowRunningLine ? (
        <Text dimColor>
          ctrl+p commands · / slash · tab complete · ↑/↓ history · Agoryx v{version} · mode {currentMode} · agents {agents.join(", ")}
        </Text>
      ) : null}
    </Box>
  );
};

export const runInkChat = async (options: InkChatOptions): Promise<void> => {
  const originalLog = console.log.bind(console) as (...args: unknown[]) => void;
  const originalError = console.error.bind(console) as (...args: unknown[]) => void;
  let sink: ConsoleSink = null;

  console.log = ((...args: unknown[]) => {
    const line = util.format(...args);
    if (sink) {
      try {
        sink("info", line);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        originalError(`[agoryx] console sink failed for log: ${message}`);
      }
    }
    originalLog(...args);
  }) as typeof console.log;

  console.error = ((...args: unknown[]) => {
    const line = util.format(...args);
    if (sink) {
      try {
        sink("error", line);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        originalError(`[agoryx] console sink failed for error: ${message}`);
      }
    }
    originalError(...args);
  }) as typeof console.error;

  try {
    const instance = render(
      <InkChatApp
        {...options}
        bindConsoleSink={(nextSink) => {
          sink = nextSink;
        }}
      />,
      {
        exitOnCtrlC: false,
      },
    );
    await instance.waitUntilExit();
  } finally {
    sink = null;
    options.attachAdapterEventSink(null);
    console.log = originalLog as typeof console.log;
    console.error = originalError as typeof console.error;
  }
};
