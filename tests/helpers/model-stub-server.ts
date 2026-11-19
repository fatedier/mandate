/**
 * Model providers on this machine for tests: Anthropic Messages, OpenAI
 * Chat Completions and Responses (Open Responses too), Google. Each request
 * takes the next scripted reply, or the default for its API; every body is
 * kept. This thread's fetch is closed to the network in tests, so `fetchHere`
 * reaches the handler directly; a worker thread uses `url` over loopback.
 */

export type StubReply = (body: Record<string, unknown>, api: StubApi) => Response | Promise<Response>;
export type StubApi = "messages" | "chat" | "responses" | "google";

const sse = (frames: string[]) => new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function textReply(api: StubApi, text: string, opts: { reasoning?: string } = {}): Response {
  switch (api) {
    case "messages": return sse([
      frame({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 0 } } }, "message_start"),
      ...(opts.reasoning ? [
        frame({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }, "content_block_start"),
        frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: opts.reasoning } }, "content_block_delta"),
        frame({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }, "content_block_delta"),
        frame({ type: "content_block_stop", index: 0 }, "content_block_stop")
      ] : []),
      frame({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, "content_block_start"),
      ...text.split(" ").map((w, i) => frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: (i ? " " : "") + w } }, "content_block_delta")),
      frame({ type: "content_block_stop", index: 1 }, "content_block_stop"),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, "message_delta"),
      frame({ type: "message_stop" }, "message_stop")
    ]);
    case "chat": return sse([
      ...text.split(" ").map((w, i) => frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { ...(i ? {} : { role: "assistant" }), content: (i ? " " : "") + w }, finish_reason: null }] })),
      frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }),
      "data: [DONE]\n\n"
    ]);
    case "responses": {
      const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      return sse([
        frame({ type: "response.created", response: { id: "resp_1", created_at: 0, model: "m", status: "in_progress", output: [] } }),
        frame({ type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } }),
        ...text.split(" ").map((w, i) => frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: (i ? " " : "") + w })),
        frame({ type: "response.output_item.done", output_index: 0, item: message }),
        frame({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [message], usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } })
      ]);
    }
    case "google": return sse([
      ...text.split(" ").map((w, i) => frame({ candidates: [{ content: { parts: [{ text: (i ? " " : "") + w }], role: "model" }, index: 0 }] })),
      frame({ candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 } })
    ]);
  }
}

/** A Chat Completions reply that calls one tool with these arguments. */
export function chatToolCallReply(name: string, args: Record<string, unknown>): Response {
  return sse([
    frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }),
    frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }),
    "data: [DONE]\n\n"
  ]);
}

/** A reply that streams text slowly, for Stop and a lost worker mid-stream. */
export function slowChatReply(words: number, everyMs: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let i = 0; i < words; i++) {
          controller.enqueue(new TextEncoder().encode(frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: `w${i} ` }, finish_reason: null }] })));
          await sleep(everyMs);
        }
        controller.enqueue(new TextEncoder().encode(frame({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n"));
        controller.close();
      } catch { /* the client went away */ }
    }
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

export function startModelStub() {
  const bodies: Array<{ api: StubApi; body: string }> = [];
  const script: StubReply[] = [];
  const apiOf = (url: URL): StubApi =>
    url.pathname.endsWith("/messages") ? "messages"
      : url.pathname.endsWith("/chat/completions") ? "chat"
        : url.pathname.endsWith("/responses") ? "responses"
          : "google";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text();
      const api = apiOf(new URL(req.url));
      bodies.push({ api, body });
      const reply = script.shift();
      return reply ? reply(JSON.parse(body) as Record<string, unknown>, api) : textReply(api, "Hello there, world.");
    }
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    bodies,
    /** The replies the next requests take, in order. */
    next: (...replies: StubReply[]) => { script.push(...replies); },
    fetchHere: ((input: RequestInfo | URL, init?: RequestInit) => server.fetch(new Request(input, init))) as typeof fetch,
    stop: () => server.stop(true)
  };
}
