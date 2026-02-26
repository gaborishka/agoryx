export const describeSessionBinding = (
  previousSessionId: string | null,
  currentSessionId: string,
): string => {
  if (!previousSessionId) {
    return "session ready";
  }
  if (previousSessionId === currentSessionId) {
    return "session resumed";
  }
  return "session switched";
};

export const formatSessionId = (sessionId: string): string => {
  if (sessionId.length <= 16) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`;
};

export const extractPayloadText = (payload: unknown): string => {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const text = (payload as { text?: string }).text;
  return typeof text === "string" ? text : "";
};

export const normalizeStatusText = (text: string): string => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }
  if (compact.length <= 110) {
    return compact;
  }
  return `${compact.slice(0, 107)}...`;
};
