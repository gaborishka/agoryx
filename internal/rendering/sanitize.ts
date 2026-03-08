import type { OrchestrationMode } from "../events/types.js";
import { isPassResponse } from "../events/pass-token.js";

export interface SystemReminderState {
  insideSystemReminder: boolean;
}

export interface SanitizedDelta {
  text: string;
  statusText: string | null;
}

export const TEAM_PROCESS_CHATTER_PATTERNS = [
  /\b(i(?:'|’)m|i am|i(?:'|’)ll|i will)\b.*\b(read|scan|check|review|verify|grep|bootstrap|cross-check|inspect|prepare|gather|collect|re-?run|search|analy[sz]e|walk through)\b/i,
  /\b(i hit|quick bootstrap|first pass|next i(?:'|’)m|now i(?:'|’)m)\b/i,
  /(зараз|спершу|далі|потім|наступним кроком).*(перевір|звір|прочита|скан|подив|переглян|підгот|запущ|зроблю|аналіз)/iu,
  /я.*(перевірю|перевіряю|прочитаю|перегляну|переглядаю|запущу|зроблю швидкий|аналізую)/iu,
  /(опис|огляд).*(підготую|готую)/iu,
];

export const isTeamProcessChatterLine = (line: string): boolean =>
  TEAM_PROCESS_CHATTER_PATTERNS.some((pattern) => pattern.test(line));

export const stripSystemReminder = <T extends SystemReminderState>(
  text: string,
  state: T,
): string => {
  let remaining = text;
  let outputText = "";

  while (remaining.length > 0) {
    if (state.insideSystemReminder) {
      const closeIndex = remaining.toLowerCase().indexOf("</system-reminder>");
      if (closeIndex === -1) {
        return outputText;
      }
      remaining = remaining.slice(closeIndex + "</system-reminder>".length);
      state.insideSystemReminder = false;
      continue;
    }

    const openIndex = remaining.toLowerCase().indexOf("<system-reminder>");
    if (openIndex === -1) {
      outputText += remaining;
      break;
    }

    outputText += remaining.slice(0, openIndex);
    const afterOpen = remaining.slice(openIndex + "<system-reminder>".length);
    const closeIndex = afterOpen.toLowerCase().indexOf("</system-reminder>");
    if (closeIndex === -1) {
      state.insideSystemReminder = true;
      break;
    }

    remaining = afterOpen.slice(closeIndex + "</system-reminder>".length);
  }

  return outputText;
};

export const sanitizeRenderedDelta = <T extends SystemReminderState>(
  text: string,
  state: T,
  mode: OrchestrationMode,
): SanitizedDelta => {
  if (!text) {
    return { text: "", statusText: null };
  }

  const withoutReminders = stripSystemReminder(text, state);
  if (!withoutReminders) {
    return { text: "", statusText: null };
  }

  const keptLines: string[] = [];
  let statusText: string | null = null;
  for (const line of withoutReminders.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (mode === "team" && trimmed && /^\d+→/.test(trimmed)) {
      continue;
    }

    if (mode === "team" && trimmed && isTeamProcessChatterLine(trimmed)) {
      statusText = trimmed;
      continue;
    }

    if (isPassResponse(trimmed)) {
      continue;
    }

    keptLines.push(line);
  }

  return {
    text: keptLines.join("\n"),
    statusText,
  };
};

export const sanitizeTeamOutput = (text: string): string => {
  if (!text) {
    return text;
  }

  const state: SystemReminderState = { insideSystemReminder: false };
  const filtered = sanitizeRenderedDelta(text, state, "team").text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      if (/^now appending to the bridge log:?$/i.test(trimmed)) {
        return false;
      }
      return true;
    });

  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};
