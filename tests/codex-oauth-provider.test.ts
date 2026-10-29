import { expect, test } from "bun:test";
import { streamText } from "ai";
import {
  CodexHttpError,
  CodexTransportError,
  codexHttpErrorFromResponse,
  codexTransportErrorFromCause,
  normalizeCodexResponsesRequest,
  createCodexOAuthLanguageModel
} from "../src/server/modules/codex/codex-oauth-provider.js";
import { getCodexAuthProfile } from "../src/server/modules/codex/codex-auth-store.js";
import { collectStream } from "../src/server/modules/agent/stream-collector.js";
import { codexAuthStore, codexEvents, codexSse, codexTestModel } from "./helpers/codex.js";

test("Codex OAuth provider moves system input into instructions", () => {
  const next = normalizeCodexResponsesRequest({
    method: "POST",
    body: JSON.stringify({
      model: "gpt-5.5",
      input: [
        { role: "developer", content: "Developer prompt" },
        { role: "system", content: [{ type: "input_text", text: "System prompt" }] },
        { role: "user", content: [{ type: "input_text", text: "hello" }] }
      ],
      stream: true
    })
  });

  const payload = JSON.parse(next?.body as string);
  expect(payload.instructions).toBe("Developer prompt\n\nSystem prompt");
  expect(payload.store).toBe(false);
  expect(payload.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "hello" }] }
  ]);
});

test("Codex OAuth provider preserves existing instructions", () => {
  const next = normalizeCodexResponsesRequest({
    body: JSON.stringify({
      input: [
        { role: "developer", content: "Developer prompt" },
        { role: "user", content: [{ type: "input_text", text: "hello" }] }
      ],
      instructions: "Existing instructions"
    })
  });

  const payload = JSON.parse(next?.body as string);
  expect(payload.instructions).toBe("Existing instructions\n\nDeveloper prompt");
  expect(payload.store).toBe(false);
});

test("Codex OAuth provider injects service tier", () => {
  const next = normalizeCodexResponsesRequest({
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] }
      ],
      service_tier: "flex"
    })
  }, "priority");

  const payload = JSON.parse(next?.body as string);
  expect(payload.service_tier).toBe("priority");
});

test("Codex OAuth provider preserves existing service tier", () => {
  const next = normalizeCodexResponsesRequest({
    body: JSON.stringify({
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] }
      ],
      service_tier: "priority"
    })
  });

  const payload = JSON.parse(next?.body as string);
  expect(payload.service_tier).toBe("priority");
});

test("Codex OAuth provider leaves non-JSON bodies unchanged", () => {
  const init = {
    body: "invalid JSON"
  };
  expect(normalizeCodexResponsesRequest(init)).toBe(init);
});

test("Codex HTTP errors carry structured metadata without relying on stack text", async () => {
  const error = await codexHttpErrorFromResponse(new Response(JSON.stringify({
    error: { message: "upstream unavailable" }
  }), {
    status: 503,
    statusText: "Service Unavailable",
    headers: { "x-oai-request-id": "req_123" }
  }));

  expect(error).toBeInstanceOf(CodexHttpError);
  expect(error).toMatchObject({
    name: "CodexHttpError",
    code: "codex_http_503",
    status: 503,
    statusCode: 503,
    requestId: "req_123",
    detail: "upstream unavailable"
  });
  expect(error.message).toBe("OpenAI Codex API HTTP 503 Service Unavailable: upstream unavailable: request_id=req_123");
});

test("Codex transport errors compact DOMException causes", () => {
  const error = codexTransportErrorFromCause(
    new DOMException("The operation timed out.", "TimeoutError")
  );

  expect(error).toBeInstanceOf(CodexTransportError);
  expect(error.name).toBe("CodexTransportError");
  expect(error.message).toBe("Codex request failed: The operation timed out. (TimeoutError code=23)");
});

for (const baseURL of [undefined, "https://relay.example.test/forward/"]) {
  for (const store of [undefined, true]) {
    test(`Codex SDK request replays encrypted reasoning and phase with store=${store}, baseURL=${baseURL}`, async () => {
      const requests: Array<{ url: string; body: any }> = [];
      const model = codexTestModel({
        async fetch(input, init) {
          requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return codexSse(codexEvents({
            id: String(requests.length), text: "Checking", phase: "commentary", encryptedReasoning: "encrypted-state"
          }));
        }
      }, baseURL);
      const first = streamText({ model, prompt: "hello", maxRetries: 0 });
      await collectStream(first.fullStream);
      const history = await first.responseMessages;
      const second = streamText({
        model, system: "system instructions", maxRetries: 0,
        messages: [{ role: "user", content: "hello" }, ...history, { role: "user", content: "continue" }],
        providerOptions: { openai: { store, promptCacheKey: "thread-1", include: ["message.output_text.logprobs"] } }
      });
      await collectStream(second.fullStream);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.url).toBe(`${baseURL?.replace(/\/+$/, "") ?? "https://chatgpt.com/backend-api/codex"}/responses`);
      const body = requests[1]!.body;
      expect(body.store).toBe(false);
      expect(body.stream).toBe(true);
      expect(body.instructions).toBe("system instructions");
      expect(body.prompt_cache_key).toBe("thread-1");
      expect(body.include).toContain("reasoning.encrypted_content");
      expect(body.include).toContain("message.output_text.logprobs");
      expect(body.input.some((item: any) => item.type === "item_reference")).toBe(false);
      expect(body.input.find((item: any) => item.type === "reasoning")).toEqual({
        type: "reasoning", encrypted_content: "encrypted-state", summary: []
      });
      const assistant = body.input.find((item: any) => item.role === "assistant");
      expect(assistant.phase).toBe("commentary");
      expect(assistant.id).toBeUndefined();
      expect(requests[0]!.body.instructions.length).toBeGreaterThan(0);
    });
  }
}

test("Codex provider refreshes a locally valid token once after 401 and replays the same request", async () => {
  const store = codexAuthStore();
  const requests: Array<{ body: unknown; headers: Headers }> = [];
  let refreshes = 0;
  const model = createCodexOAuthLanguageModel({
    providerName: "codex", model: "gpt-5.5", authStore: store,
    httpClient: {
      async fetch(input, init) {
        if (String(input).endsWith("/oauth/token")) {
          refreshes++;
          expect(String(init?.body)).toContain("refresh_token=test-refresh");
          return Response.json({ access_token: "new-access", expires_in: 3600 });
        }
        requests.push({ body: init?.body, headers: new Headers(init?.headers) });
        return requests.length === 1 ? new Response("unauthorized", { status: 401 })
          : codexSse(codexEvents({ text: "recovered" }));
      }
    }
  });
  const result = await collectStream(streamText({ model, prompt: "hello", maxRetries: 0 }).fullStream);
  expect(result.text).toBe("recovered");
  expect(refreshes).toBe(1);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.body).toBe(requests[1]!.body);
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-access");
  expect(requests[1]!.headers.get("authorization")).toBe("Bearer new-access");
  expect(getCodexAuthProfile("codex", store)?.refresh).toBe("test-refresh");
});

test("Codex provider stops after one 401 recovery and preserves the final HTTP error", async () => {
  let refreshes = 0;
  let requests = 0;
  const model = codexTestModel({
    async fetch(input) {
      if (String(input).endsWith("/oauth/token")) {
        refreshes++;
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh" });
      }
      requests++;
      return new Response("still unauthorized", { status: 401, headers: { "x-oai-request-id": "req-final" } });
    }
  });
  const stream = streamText({ model, prompt: "hello", maxRetries: 0, onError() {} });
  await expect(collectStream(stream.fullStream)).rejects.toThrow(/still unauthorized.*req-final/);
  expect(refreshes).toBe(1);
  expect(requests).toBe(2);
});

test("Codex provider does not refresh on non-401 failures", async () => {
  let requests = 0;
  const model = codexTestModel({
    async fetch(input) {
      expect(String(input)).not.toContain("/oauth/token");
      requests++;
      return new Response("overloaded", { status: 429 });
    }
  });
  const stream = streamText({ model, prompt: "hello", maxRetries: 0, onError() {} });
  await expect(collectStream(stream.fullStream)).rejects.toThrow(/overloaded/);
  expect(requests).toBe(1);
});

test("Codex concurrent 401 responses share a single token refresh", async () => {
  const issued = Promise.withResolvers<void>();
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  let rejected = 0;
  let recovered = 0;
  let refreshes = 0;
  const model = codexTestModel({
    async fetch(input, init) {
      if (String(input).endsWith("/oauth/token")) {
        refreshes++;
        refreshStarted.resolve();
        await releaseRefresh.promise;
        return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh" });
      }
      if (new Headers(init?.headers).get("authorization") === "Bearer test-access") {
        if (++rejected === 2) issued.resolve();
        return new Response("expired", { status: 401 });
      }
      recovered++;
      return codexSse(codexEvents({ text: "recovered" }));
    }
  });
  const pending = ["one", "two"].map(prompt => collectStream(streamText({ model, prompt, maxRetries: 0 }).fullStream));
  await issued.promise;
  await refreshStarted.promise;
  releaseRefresh.resolve();
  expect((await Promise.all(pending)).map(result => result.text)).toEqual(["recovered", "recovered"]);
  expect(rejected).toBe(2);
  expect(recovered).toBe(2);
  expect(refreshes).toBe(1);
});

for (const mode of ["expired", "401"] as const) {
  test(`Codex caller can cancel during a shared ${mode} refresh without canceling its peer`, async () => {
    const authStore = codexAuthStore();
    if (mode === "expired") {
      const data = authStore.read();
      data.profiles!["codex:default"]!.expiresAt = 0;
      authStore.write(data);
    }
    const refreshStarted = Promise.withResolvers<void>();
    const releaseRefresh = Promise.withResolvers<void>();
    const abort = new AbortController();
    let refreshSignal: AbortSignal | null | undefined;
    let refreshes = 0;
    let recovered = 0;
    const model = createCodexOAuthLanguageModel({
      providerName: "codex", model: "gpt-5.5", authStore,
      httpClient: { async fetch(input, init) {
        if (String(input).endsWith("/oauth/token")) {
          refreshes++;
          refreshSignal = init?.signal;
          refreshStarted.resolve();
          await releaseRefresh.promise;
          return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh" });
        }
        if (new Headers(init?.headers).get("authorization") === "Bearer test-access") {
          return new Response("expired", { status: 401 });
        }
        recovered++;
        return codexSse(codexEvents({ text: "recovered" }));
      } }
    });
    let canceled: unknown;
    const first = collectStream(streamText({
      model, prompt: "first", maxRetries: 0, abortSignal: abort.signal, onError() {}
    }).fullStream).catch(error => { canceled = error; });
    await refreshStarted.promise;
    const peer = collectStream(streamText({ model, prompt: "peer", maxRetries: 0 }).fullStream);
    try {
      abort.abort(new Error("user canceled"));
      // Drain the abort event and SDK promise callbacks while refresh remains
      // explicitly blocked; no elapsed-time threshold controls the assertion.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(canceled).toBeInstanceOf(Error);
      expect(String(canceled)).toContain("user canceled");
      expect(refreshSignal?.aborted).toBe(false);
      expect(recovered).toBe(0);
    } finally {
      releaseRefresh.resolve();
    }
    await first;
    expect((await peer).text).toBe("recovered");
    expect(refreshes).toBe(1);
    expect(recovered).toBe(1);
    expect(getCodexAuthProfile("codex", authStore)?.refresh).toBe("rotated-refresh");
  });
}
