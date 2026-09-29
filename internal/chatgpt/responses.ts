import { RESOURCE } from "./auth.js";

/**
 * Requests on the human's ChatGPT plan: the public Responses API with the OAuth access token, always
 * store:false and stream:true, the history sent in each request. Only response.completed is success.
 */

export interface PlanModel {
  slug: string;
  displayName: string;
}

export class PlanError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null,
    message: string,
    readonly param: string | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

const USER_AGENT = "agoryx";

/** What to tell the human, for the codes OpenAI documents a recovery for. */
export const explainPlanError = (error: PlanError): string => {
  switch (error.code) {
    case "subscription_sharing_user_not_eligible":
      return "ChatGPT plan use is not available for this account, workspace or policy (it needs Plus or Pro).";
    case "subscription_sharing_usage_limit_exceeded":
      return "Usage limit reached: your plan's, or the one you set for Agoryx. See ChatGPT → Settings → Usage.";
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return "ChatGPT could not check your usage just now; try again later.";
    case "subscription_sharing_unsupported_capability":
      return `Not supported on a ChatGPT plan: ${error.param ?? "part of the request"}.`;
    case "subscription_sharing_route_not_supported":
      return "This endpoint is not open to ChatGPT plan usage.";
    case "subscription_sharing_invalid_user":
      return "ChatGPT could not validate the account: run `agoryx login chatgpt` again.";
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return "The sign-in's permission does not cover this request.";
  }
  if (error.code === null && error.status === 401) return `Not accepted: check the account and its granted scopes (${error.message}).`;
  if (error.code === null && error.status === 403) return `Refused by policy, for example the serving region (${error.message}).`;
  if (error.code === null && error.status === 503) return `Direct routing is unavailable or not enabled (${error.message}).`;
  return error.message;
};

/** A failure before any stream: a Responses error object, or the admission layer's {"detail": "…"}. */
const failure = async (response: Response): Promise<PlanError> => {
  const requestId = response.headers.get("x-request-id");
  const text = await response.text().catch(() => "");
  let body: { error?: { code?: unknown; message?: unknown; param?: unknown }; detail?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // not JSON: the text is the message
  }
  const code = typeof body.error?.code === "string" ? body.error.code : null;
  const message =
    typeof body.error?.message === "string" ? body.error.message : typeof body.detail === "string" ? body.detail : text.slice(0, 300) || `HTTP ${response.status}`;
  return new PlanError(response.status, code, message, typeof body.error?.param === "string" ? body.error.param : null, requestId);
};

const headers = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  "User-Agent": USER_AGENT,
});

/** The account's models for a picker, in the server's order: those meant to be listed. */
export const listModels = async (accessToken: string, fetchImpl: typeof fetch = fetch): Promise<PlanModel[]> => {
  const response = await fetchImpl(`${RESOURCE}/models`, { headers: headers(accessToken), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { models?: unknown[]; data?: unknown[] };
  const entries = (body.models ?? body.data ?? []) as Array<{ slug?: unknown; id?: unknown; display_name?: unknown; visibility?: unknown }>;
  return entries.flatMap((entry) => {
    const slug = typeof entry.slug === "string" ? entry.slug : typeof entry.id === "string" ? entry.id : null;
    if (!slug || (entry.visibility !== undefined && entry.visibility !== "list")) return [];
    return [{ slug, displayName: typeof entry.display_name === "string" ? entry.display_name : slug }];
  });
};

export interface SseEvent {
  event: string | null;
  data: string;
}

/** Splits server-sent events out of a buffer; what follows the last blank line is left for the next chunk. */
export const takeSseEvents = (buffer: string): { events: SseEvent[]; rest: string } => {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.flatMap((block): SseEvent[] => {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    return data.length ? [{ event, data: data.join("\n") }] : [];
  });
  return { events, rest };
};

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface Completed {
  text: string;
  model: string;
  usage: Usage | null;
  requestId: string | null;
  ms: number;
}

export interface ResponseRequest {
  model: string;
  input: string;
  instructions?: string;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

/** One request on the plan, streamed through to response.completed; anything else ends in a PlanError. */
export const streamResponse = async (accessToken: string, request: ResponseRequest, fetchImpl: typeof fetch = fetch): Promise<Completed> => {
  const sentAt = Date.now();
  const response = await fetchImpl(`${RESOURCE}/responses`, {
    method: "POST",
    headers: { ...headers(accessToken), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: request.model,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      input: [{ role: "user", content: request.input }],
      store: false,
      stream: true,
    }),
    signal: request.signal ?? AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) throw await failure(response);
  const requestId = response.headers.get("x-request-id");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const taken = takeSseEvents(buffer);
    buffer = taken.rest;
    for (const { data } of taken.events) {
      if (data === "[DONE]") continue;
      const event = JSON.parse(data) as {
        type?: string;
        delta?: string;
        code?: string;
        message?: string;
        response?: { usage?: Usage; error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } };
      };
      switch (event.type) {
        case "response.output_text.delta":
          if (typeof event.delta === "string") {
            text += event.delta;
            request.onDelta?.(event.delta);
          }
          break;
        case "response.completed":
          return { text, model: request.model, usage: event.response?.usage ?? null, requestId, ms: Date.now() - sentAt };
        case "response.failed": {
          const error = event.response?.error;
          throw new PlanError(null, error?.code ?? null, error?.message ?? "the response failed", null, requestId);
        }
        case "response.incomplete":
          throw new PlanError(null, "incomplete", `the response stopped early: ${event.response?.incomplete_details?.reason ?? "unknown reason"}`, null, requestId);
        case "error":
          throw new PlanError(null, event.code ?? null, event.message ?? "the stream reported an error", null, requestId);
      }
    }
  }
  throw new PlanError(null, "stream_ended", "the stream ended without response.completed", null, requestId);
};
