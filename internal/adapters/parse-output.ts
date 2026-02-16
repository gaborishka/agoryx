export const extractTextFromJsonLine = (line: string): string | null => {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return extractTextFromObject(parsed);
  } catch {
    return trimmed;
  }
};

const extractTextFromObject = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const obj = value as Record<string, unknown>;
  const candidates = [
    obj.delta,
    obj.text,
    obj.output_text,
    obj.result,
    obj.content,
    obj.completion,
    obj.response,
    obj.item,
    obj.message,
  ];

  for (const candidate of candidates) {
    const text = extractStringCandidate(candidate);
    if (text) {
      return text;
    }
  }

  return null;
};

const extractStringCandidate = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractStringCandidate(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("") : null;
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (isReasoningPayload(obj)) {
      return null;
    }

    if (typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.value === "string") {
      return obj.value;
    }

    // Provider streams often nest text under message/content, item/content, or result.
    const nestedCandidates = [
      obj.delta,
      obj.output_text,
      obj.result,
      obj.content,
      obj.completion,
      obj.response,
      obj.item,
      obj.message,
    ];

    for (const nested of nestedCandidates) {
      const text = extractStringCandidate(nested);
      if (text) {
        return text;
      }
    }
  }

  return null;
};

const isReasoningPayload = (value: Record<string, unknown>): boolean => {
  const type = value.type;
  if (typeof type !== "string") {
    return false;
  }

  const normalized = type.toLowerCase();
  return /(^|[._-])reasoning($|[._-])/.test(normalized);
};
