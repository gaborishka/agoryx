import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explainPlanError, listModels, PlanError, streamResponse, takeSseEvents } from "../../internal/chatgpt/responses.js";
import { json } from "./helpers.js";

const sse = (chunks: string[], headers: Record<string, string> = {}): Response => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream", ...headers } });
};

const event = (type: string, fields: Record<string, unknown> = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

describe("takeSseEvents", () => {
  it("splits complete events and keeps the partial one", () => {
    const { events, rest } = takeSseEvents('event: a\ndata: {"x":1}\n\ndata: line1\ndata: line2\n\n: comment\n\nevent: b\ndata: {"y"');
    assert.deepEqual(events, [
      { event: "a", data: '{"x":1}' },
      { event: null, data: "line1\nline2" },
    ]);
    assert.equal(rest, 'event: b\ndata: {"y"');
  });

  it("reads CRLF line ends", () => {
    assert.deepEqual(takeSseEvents("data: 1\r\n\r\n").events, [{ event: null, data: "1" }]);
  });
});

describe("streamResponse", () => {
  const capture = (response: Response) => {
    const sent: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.url = String(url);
      sent.init = init;
      return response;
    }) as typeof fetch;
    return { sent, fetchImpl };
  };

  it("streams deltas to response.completed, with store:false and the token", async () => {
    const deltas: string[] = [];
    const { sent, fetchImpl } = capture(
      sse(
        [
          event("response.created"),
          event("response.output_text.delta", { delta: "Hello, " }).slice(0, 20),
          event("response.output_text.delta", { delta: "Hello, " }).slice(20) + event("response.output_text.delta", { delta: "world!" }),
          event("response.completed", { response: { usage: { input_tokens: 9, output_tokens: 4 } } }),
        ],
        { "x-request-id": "req_1" },
      ),
    );
    const done = await streamResponse("at-1", { model: "gpt-6-luna", input: "hi", onDelta: (text) => deltas.push(text) }, fetchImpl);
    assert.equal(done.text, "Hello, world!");
    assert.deepEqual(deltas, ["Hello, ", "world!"]);
    assert.deepEqual(done.usage, { input_tokens: 9, output_tokens: 4 });
    assert.equal(done.requestId, "req_1");

    assert.equal(sent.url, "https://api.openai.com/v1/responses");
    const headers = sent.init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer at-1");
    const body = JSON.parse(String(sent.init?.body)) as Record<string, unknown>;
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.input, [{ role: "user", content: "hi" }]);
    for (const unsupported of ["temperature", "max_output_tokens", "previous_response_id", "top_p"]) assert.equal(unsupported in body, false);
  });

  it("fails a stream that ends without response.completed", async () => {
    const { fetchImpl } = capture(sse([event("response.output_text.delta", { delta: "Hel" })]));
    await assert.rejects(streamResponse("at", { model: "m", input: "hi" }, fetchImpl), (error: unknown) => error instanceof PlanError && error.code === "stream_ended");
  });

  it("fails on response.failed, response.incomplete and error events", async () => {
    const cases: Array<[string, string]> = [
      [event("response.failed", { response: { error: { code: "server_error", message: "boom" } } }), "server_error"],
      [event("response.incomplete", { response: { incomplete_details: { reason: "max_output_tokens" } } }), "incomplete"],
      [event("error", { code: "subscription_sharing_usage_limit_exceeded", message: "limit" }), "subscription_sharing_usage_limit_exceeded"],
    ];
    for (const [chunk, code] of cases) {
      const { fetchImpl } = capture(sse([chunk]));
      await assert.rejects(streamResponse("at", { model: "m", input: "hi" }, fetchImpl), (error: unknown) => error instanceof PlanError && error.code === code);
    }
  });

  it("reads a Responses error body and the admission layer's detail body", async () => {
    const coded = capture(
      new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", message: "no", param: "tools[0]" } }), {
        status: 400,
        headers: { "x-request-id": "req_2" },
      }),
    );
    await assert.rejects(streamResponse("at", { model: "m", input: "hi" }, coded.fetchImpl), (error: unknown) => {
      assert.ok(error instanceof PlanError);
      assert.equal(error.status, 400);
      assert.equal(error.code, "subscription_sharing_unsupported_capability");
      assert.equal(error.param, "tools[0]");
      assert.equal(error.requestId, "req_2");
      return true;
    });
    const detail = capture(json({ detail: "direct routing disabled" }, 503));
    await assert.rejects(streamResponse("at", { model: "m", input: "hi" }, detail.fetchImpl), (error: unknown) => {
      assert.ok(error instanceof PlanError);
      assert.equal(error.code, null);
      assert.equal(error.message, "direct routing disabled");
      return true;
    });
  });
});

describe("listModels", () => {
  it("keeps the listed models in the server's order", async () => {
    const fetchImpl = (async () =>
      json({
        models: [
          { slug: "gpt-6-luna", display_name: "GPT-6 Luna", visibility: "list" },
          { slug: "internal", display_name: "Hidden", visibility: "hide" },
          { slug: "gpt-6.1-sol", visibility: "list" },
        ],
      })) as typeof fetch;
    assert.deepEqual(await listModels("at", fetchImpl), [
      { slug: "gpt-6-luna", displayName: "GPT-6 Luna" },
      { slug: "gpt-6.1-sol", displayName: "gpt-6.1-sol" },
    ]);
  });

  it("throws a PlanError on a refusal", async () => {
    const fetchImpl = (async () => json({ error: { code: "subscription_sharing_user_not_eligible", message: "no" } }, 403)) as typeof fetch;
    await assert.rejects(listModels("at", fetchImpl), (error: unknown) => error instanceof PlanError && error.code === "subscription_sharing_user_not_eligible");
  });
});

describe("explainPlanError", () => {
  it("explains the documented codes", () => {
    assert.match(explainPlanError(new PlanError(403, "subscription_sharing_user_not_eligible", "x")), /Plus or Pro/);
    assert.match(explainPlanError(new PlanError(429, "subscription_sharing_usage_limit_exceeded", "x")), /Settings → Usage/);
    assert.match(explainPlanError(new PlanError(400, "subscription_sharing_unsupported_capability", "x", "tools")), /tools/);
    assert.match(explainPlanError(new PlanError(401, "subscription_sharing_invalid_user", "x")), /login chatgpt/);
  });

  it("explains a bare 401, 403 and 503 by status", () => {
    assert.match(explainPlanError(new PlanError(401, null, "bad")), /scopes/);
    assert.match(explainPlanError(new PlanError(403, null, "bad")), /region/);
    assert.match(explainPlanError(new PlanError(503, null, "bad")), /Direct routing/);
  });

  it("passes anything else through", () => {
    assert.equal(explainPlanError(new PlanError(500, "server_error", "boom")), "boom");
  });
});
