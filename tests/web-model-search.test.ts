import { expect, test } from "bun:test";
import { loadConfig, type JsonObject, type ResolvedProviderConfig } from "../src/server/config.js";
import { resolveModelSelection } from "../src/server/config/model-resolution.js";
import { globalHttpClient } from "../src/server/platform/http/http-client.js";
import { modelSearchKind, MODEL_SEARCH_INSTRUCTIONS, searchApiOf } from "../src/server/modules/web/kinds/model-search.js";
import { SEARCH_KINDS } from "../src/server/modules/web/kinds/index.js";
import { SearchFailure, type SearchCallContext } from "../src/server/modules/web/search-kind.js";
import { mockFetch } from "./helpers/fetch.js";
import { MemoryJsonStore } from "./helpers/memory-json-store.js";
import { sseFrame } from "./helpers/sse.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { onCleanup } from "./helpers/cleanup.js";

const config = loadConfig(undefined, new MemoryJsonStore<JsonObject>({
  models: {
    providers: {
      p: { type: "openai", apiKey: "not-a-real-key", models: [{ id: "m1" }] },
      a: { type: "anthropic", apiKey: "not-a-real-key", models: [{ id: "c1" }] },
      k: { type: "openai-compatible", baseURL: "https://k.test/v1", apiKey: "not-a-real-key", models: [{ id: "x", protocol: "chat" }, { id: "msg", protocol: "messages" }, { id: "resp" }] },
      bare: { type: "openai-compatible", apiKey: "not-a-real-key", models: [{ id: "msg", protocol: "messages" }] },
      kilo: { type: "kilo", apiKey: "not-a-real-key", models: [{ id: "kx" }] }
    }
  }
}));

const ctx = (over: Partial<SearchCallContext> = {}): SearchCallContext => ({
  config, http: globalHttpClient, signal: new AbortController().signal, timeoutMs: 10_000, wait: async () => {},
  store: null, record: { scopeType: "agent_thread", scopeId: "thr_1" }, ...over
});

const sse = (events: unknown[]) => new Response(events.map((data) => sseFrame({ data })).join(""), { headers: { "content-type": "text/event-stream" } });
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init!.body));

/** An OpenAI Responses stream: web search calls, then a message with its citations. */
function responsesStream(searches: Array<{ id: string; query: string; sources?: string[] }>, message?: { text: string; citations?: Array<{ url: string; title: string }> }) {
  const events: unknown[] = [{ type: "response.created", response: { id: "resp_1", created_at: 1, model: "m1" } }];
  let index = 0;
  for (const search of searches) {
    events.push({ type: "response.output_item.added", output_index: index, item: { type: "web_search_call", id: search.id, status: "in_progress" } });
    events.push({ type: "response.output_item.done", output_index: index, item: { type: "web_search_call", id: search.id, status: "completed",
      action: { type: "search", query: search.query, ...(search.sources ? { sources: search.sources.map((url) => ({ type: "url", url })) } : {}) } } });
    index += 1;
  }
  const output: unknown[] = [];
  if (message) {
    const annotations = (message.citations ?? []).map((c) => ({ type: "url_citation", url: c.url, title: c.title, start_index: 0, end_index: 4 }));
    const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: message.text, annotations }] };
    events.push({ type: "response.output_item.added", output_index: index, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } });
    events.push({ type: "response.output_text.delta", item_id: "msg_1", output_index: index, content_index: 0, delta: message.text });
    for (const annotation of annotations) events.push({ type: "response.output_text.annotation.added", item_id: "msg_1", output_index: index, content_index: 0, annotation_index: 0, annotation });
    events.push({ type: "response.output_item.done", output_index: index, item });
    output.push(item);
  }
  events.push({ type: "response.completed", response: { id: "resp_1", status: "completed", output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } } });
  return sse(events);
}

/** An Anthropic Messages stream: a server search, its results, then text citing them. */
function messagesStream(results: Array<{ url: string; title: string; pageAge?: string }>, text: string, citations: Array<{ url: string; title: string; citedText?: string; noIndex?: true }>) {
  return sse([
    { type: "message_start", message: { id: "msg_1", model: "c1", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"kettles"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1",
      content: results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, encrypted_content: "enc", page_age: r.pageAge ?? null })) } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    // A citation without citedText comes as some gateways send it: without
    // cited_text and encrypted_index, which Anthropic always includes.
    ...citations.map((c) => ({ type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: c.url, title: c.title,
      ...(c.citedText === undefined ? {} : { cited_text: c.citedText, ...(c.noIndex ? {} : { encrypted_index: "ei" }) }) } } })),
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" }
  ]);
}

test("model search is first in the list, with its name, fields and instructions", () => {
  expect(SEARCH_KINDS[0]).toBe(modelSearchKind);
  expect([modelSearchKind.id, modelSearchKind.label, modelSearchKind.description]).toEqual(["model", "Model search", "A model's built-in search, through its provider."]);
  expect(modelSearchKind.fields.map((f) => [f.key, f.type, f.label, f.required])).toEqual([
    ["model", "model", "Model", true], ["api", "choice", "API", false], ["effort", "choice", "Reasoning effort", false]
  ]);
  expect(modelSearchKind.fields[0]!.description).toBe("Only models on the Responses or Messages API can search.");
  expect(modelSearchKind.fields[1]).toMatchObject({
    description: "For a custom provider's model, which of the two it searches on. How agents call the model does not change.",
    defaultValue: "model",
    options: [{ value: "model", label: "As the model is set" }, { value: "responses", label: "Responses" }, { value: "messages", label: "Messages" }]
  });
  expect(modelSearchKind.fields[2]).toMatchObject({ defaultValue: "low" });
  expect(MODEL_SEARCH_INSTRUCTIONS).toBe("Search the web for what is asked below and answer from what you find. Name the pages you used. If the search finds nothing reliable, say so instead of answering from memory.");
  expect(modelSearchKind.describe({ model: "p/m1", effort: "low" })).toBe("Model search · p/m1");
});

test("on Responses the hosted search is the one tool, the model chooses to use it, and the cited pages come first", async () => {
  const calls = mockFetch(() => responsesStream(
    [{ id: "ws_1", query: "kettles", sources: ["https://a.test/consulted", "https://b.test/cited"] }],
    { text: "Kettles boil at 100.", citations: [{ url: "https://b.test/cited", title: "Cited" }] }
  ));
  const found = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "kettles", ctx());
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
  const body = bodyOf(calls[0]!.init);
  expect(body.tools).toEqual([expect.objectContaining({ type: "web_search" })]);
  expect(body.tool_choice).toBe("auto");
  expect(body.reasoning).toMatchObject({ effort: "low" });
  expect(body.instructions ?? body.input?.[0]?.content).toContain(MODEL_SEARCH_INSTRUCTIONS);
  expect(JSON.stringify(body.input)).toContain("kettles");
  expect(found).toEqual({ answer: "Kettles boil at 100.", results: [
    { title: "Cited", url: "https://b.test/cited", excerpt: "" },
    { title: "", url: "https://a.test/consulted", excerpt: "" }
  ] });
});

test("on Messages the search is the one tool, the model chooses to use it, thinking is off, five uses at most, and cited text is the excerpt", async () => {
  const calls = mockFetch(() => messagesStream(
    [{ url: "https://a.test/one", title: "One", pageAge: "March 1, 2026" }, { url: "https://b.test/two", title: "Two" }],
    "Kettles boil at 100.",
    [{ url: "https://b.test/two", title: "Two", citedText: "boils at 100 degrees" }]
  ));
  const found = await modelSearchKind.search({ model: "a/c1", effort: "high" }, "kettles", ctx());
  expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
  const body = bodyOf(calls[0]!.init);
  expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  expect(body.tool_choice).toEqual({ type: "auto" });
  expect(body.thinking).toEqual({ type: "disabled" });
  expect(JSON.stringify(body.system)).toContain(MODEL_SEARCH_INSTRUCTIONS);
  expect(found).toEqual({ answer: "Kettles boil at 100.", results: [
    { title: "Two", url: "https://b.test/two", excerpt: "boils at 100 degrees" },
    { title: "One", url: "https://a.test/one", excerpt: "", published: "March 1, 2026" }
  ] });
});

test("a Messages citation that comes without cited_text or encrypted_index still names its page, keeping what cited text it has", async () => {
  mockFetch(() => messagesStream(
    [{ url: "https://a.test/one", title: "One" }, { url: "https://b.test/two", title: "Two" }, { url: "https://c.test/three", title: "Three" }],
    "Kettles boil at 100.",
    [{ url: "https://b.test/two", title: "Two" }, { url: "https://c.test/three", title: "Three", citedText: "at sea level", noIndex: true }]
  ));
  const found = await modelSearchKind.search({ model: "k/msg", effort: "low" }, "kettles", ctx());
  expect(found).toEqual({ answer: "Kettles boil at 100.", results: [
    { title: "Two", url: "https://b.test/two", excerpt: "" },
    { title: "Three", url: "https://c.test/three", excerpt: "at sea level" },
    { title: "One", url: "https://a.test/one", excerpt: "" }
  ] });
});

test("a Messages gateway's error keeps its own words though it is labelled a stream", async () => {
  mockFetch(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "maximum context length exceeded" } }), { status: 400, headers: { "content-type": "text/event-stream" } }));
  const failed = await modelSearchKind.search({ model: "k/msg", effort: "low" }, "kettles", ctx()).then(() => null, (error: unknown) => error);
  expect(String((failed as Error | null)?.message)).toContain("maximum context length exceeded");
});

test("a custom provider's Messages model searches at its own address", async () => {
  const calls = mockFetch(() => messagesStream([{ url: "https://a.test", title: "A" }], "ok", []));
  await modelSearchKind.search({ model: "k/msg", effort: "low" }, "q", ctx());
  expect(calls[0]!.url).toBe("https://k.test/v1/messages");
});

// A gateway may serve both APIs: a model its agents call on one can search on
// the other, and only the search changes.
test("a custom provider's model searches on the API the search names, whatever the model is set to", async () => {
  const calls = mockFetch(({ url }) => url.endsWith("/messages") ? messagesStream([{ url: "https://a.test", title: "A" }], "ok", []) : responsesStream([{ id: "ws_1", query: "q" }], { text: "ok" }));
  await modelSearchKind.search({ model: "k/resp", api: "messages", effort: "low" }, "q", ctx());
  expect(calls[0]!.url).toBe("https://k.test/v1/messages");
  expect(bodyOf(calls[0]!.init).tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  await modelSearchKind.search({ model: "k/msg", api: "responses", effort: "low" }, "q", ctx());
  expect(calls[1]!.url).toBe("https://k.test/v1/responses");
  expect(bodyOf(calls[1]!.init).tools).toEqual([expect.objectContaining({ type: "web_search" })]);
  // As the model is set: each on its own.
  await modelSearchKind.search({ model: "k/resp", api: "model", effort: "low" }, "q", ctx());
  await modelSearchKind.search({ model: "k/msg", api: "model", effort: "low" }, "q", ctx());
  expect(calls.slice(2).map((call) => call.url)).toStrictEqual(["https://k.test/v1/responses", "https://k.test/v1/messages"]);
  // How agents call the model is as it was.
  expect(searchApiOf(resolveModelSelection(config, { model: "k/resp", reasoningEffort: "low" }))).toBe("responses");
  expect(searchApiOf(resolveModelSelection(config, { model: "k/msg", reasoningEffort: "low" }))).toBe("messages");
});

test("a provider with one API searches on it whatever is chosen", async () => {
  const calls = mockFetch(({ url }) => url.endsWith("/messages") ? messagesStream([{ url: "https://a.test", title: "A" }], "ok", []) : responsesStream([{ id: "ws_1", query: "q" }], { text: "ok" }));
  await modelSearchKind.search({ model: "p/m1", api: "messages", effort: "low" }, "q", ctx());
  await modelSearchKind.search({ model: "a/c1", api: "responses", effort: "low" }, "q", ctx());
  expect(calls.map((call) => call.url)).toStrictEqual(["https://api.openai.com/v1/responses", "https://api.anthropic.com/v1/messages"]);
});

/** A Responses stream of web search calls with these actions (as a provider
 *  sends them), then a message with no citations. */
function actionsStream(actions: unknown[], text: string) {
  const events: unknown[] = [{ type: "response.created", response: { id: "resp_1", created_at: 1, model: "m1" } }];
  actions.forEach((action, index) => {
    events.push({ type: "response.output_item.added", output_index: index, item: { type: "web_search_call", id: `ws_${index}`, status: "in_progress" } });
    events.push({ type: "response.output_item.done", output_index: index, item: { type: "web_search_call", id: `ws_${index}`, status: "completed", action } });
  });
  const at = actions.length;
  const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  events.push({ type: "response.output_item.added", output_index: at, item: { ...item, status: "in_progress", content: [] } });
  events.push({ type: "response.output_text.delta", item_id: "msg_1", output_index: at, content_index: 0, delta: text });
  events.push({ type: "response.output_item.done", output_index: at, item });
  events.push({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } } });
  return sse(events);
}

// A provider may name its pages only in the answer's text: DeepSeek's
// Responses gives no citations and ignores `include` (no sources), and adds
// a code of its own after an address. Mandate reads what it is given.
test("pages named only in the answer's links are the results, without the codes a provider adds after an address", async () => {
  const text = "Python 3.15.0 is the latest ([python.org](https://www.python.org/downloads/)); see https://docs.python.org/3/whatsnew/3.15.html#1#1 and [the blog](https://blog.python.org/#ws_call_id=call_02), [again](https://www.python.org/downloads/#ws_call_id=call_03).";
  mockFetch(() => actionsStream([{ type: "search", queries: ["python", "ws_call_id=call_00"] }], text));
  expect(await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx())).toEqual({ answer: text, results: [
    { title: "python.org", url: "https://www.python.org/downloads/", excerpt: "" },
    { title: "", url: "https://docs.python.org/3/whatsnew/3.15.html", excerpt: "" },
    { title: "the blog", url: "https://blog.python.org/", excerpt: "" }
  ] });
});

// A number after "#" can be a page's own anchor (a comment on a thread): one
// number is kept; only what no page has (a call code, numbers repeated) goes.
test("a page's own numbered anchor is kept: two comments on one thread are two pages", async () => {
  mockFetch(() => responsesStream([{ id: "ws_1", query: "q" }], { text: "Two replies.", citations: [
    { url: "https://news.ycombinator.com/item?id=1#15", title: "First" }, { url: "https://news.ycombinator.com/item?id=1#17", title: "Second" }
  ] }));
  expect((await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx())).results.map((r) => r.url))
    .toEqual(["https://news.ycombinator.com/item?id=1#15", "https://news.ycombinator.com/item?id=1#17"]);
});

test("a page the model opened or looked in is a result, its address without the provider's call code; the answer's links are not added then", async () => {
  mockFetch(() => actionsStream([
    { type: "search", queries: ["q"] },
    { type: "open_page", url: "https://x.test/page#ws_call_id=call_03" },
    { type: "find_in_page", url: "https://y.test/doc#ws_call_id=call_04", pattern: "2026" }
  ], "Done, from [z](https://z.test/other)."));
  expect((await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx())).results).toEqual([
    { title: "", url: "https://x.test/page", excerpt: "" },
    { title: "", url: "https://y.test/doc", excerpt: "" }
  ]);
  // A cited page is kept as cited: a link in the answer beside it adds nothing.
  mockFetch(() => responsesStream([{ id: "ws_1", query: "q" }], { text: "See [other](https://o.test/x).", citations: [{ url: "https://c.test/cited", title: "Cited" }] }));
  expect((await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx())).results).toEqual([{ title: "Cited", url: "https://c.test/cited", excerpt: "" }]);
});

test("an answer written without searching is a failure, which keeps what the model wrote", async () => {
  mockFetch(() => responsesStream([], { text: "From memory." }));
  const failure = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx()).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SearchFailure);
  expect([(failure as SearchFailure).message, (failure as SearchFailure).reply]).toEqual(["the model answered without searching", "From memory."]);
});

test("a hosted search that failed fails with the code the provider gave", async () => {
  mockFetch(() => sse([
    { type: "message_start", message: { id: "msg_1", model: "c1", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "I could not search." } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" }
  ]));
  await expect(modelSearchKind.search({ model: "a/c1", effort: "low" }, "q", ctx())).rejects.toThrow(new SearchFailure("too_many_requests"));
});

test("a search that found no pages is findings with no results", async () => {
  mockFetch(() => responsesStream([{ id: "ws_1", query: "q" }], { text: "Nothing reliable came up." }));
  expect(await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx())).toEqual({ answer: "Nothing reliable came up.", results: [] });
});

test("at most ten pages come back", async () => {
  mockFetch(() => responsesStream([{ id: "ws_1", query: "q", sources: Array.from({ length: 14 }, (_, i) => `https://s.test/${i}`) }], { text: "Many." }));
  expect((await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx())).results).toHaveLength(10);
});

test("a model no longer on Responses or Messages, or taken off its provider's list, fails with its reason, before any request", async () => {
  const calls = mockFetch(() => new Response("never", { status: 500 }));
  // k serves resp and x and msg; "gone" is not on its list, whatever it once spoke.
  for (const model of ["k/x", "kilo/kx", "bare/msg", "gone/model", "k/gone"]) {
    await expect(modelSearchKind.search({ model, effort: "low" }, "q", ctx())).rejects.toThrow(new SearchFailure(`${model} is not on the Responses or Messages API`));
  }
  expect(calls).toHaveLength(0);
});

test("a stream that reports an error after its answer is a failure, and a retryable one is tried again", async () => {
  const withError = (message: string) => {
    const good = responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test"] }], { text: "Partial." });
    return good.text().then((body) => new Response(body + sseFrame({ data: { type: "error", sequence_number: 99, code: "server_error", message } }), { headers: { "content-type": "text/event-stream" } }));
  };
  const calls = mockFetch((_c, i) => (i === 0 ? withError("The server had an error.") : responsesStream([{ id: "ws_1", query: "q", sources: ["https://b.test"] }], { text: "Whole." })));
  const found = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx());
  expect([calls.length, found.answer]).toEqual([2, "Whole."]);
});

test("a call that fails its checks is recorded with the tokens it used", async () => {
  const env = freshStoresEnv("md-model-search-usage-");
  onCleanup(env.cleanup);
  const recorded = { ...config, agent: { ...config.agent, logRequests: "metadata" as const } };
  mockFetch(() => responsesStream([], { text: "From memory." }));
  await expect(modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ config: recorded, store: env.store }))).rejects.toThrow("the model answered without searching");
  const rows = env.store.db.prepare("select status, input_tokens, output_tokens from llm_calls").all();
  expect(rows).toEqual([{ status: "failed", input_tokens: 10, output_tokens: 5 }]);
});

test("a provider error before the search's result is that error, retried, not a search that never ran", async () => {
  const startedThenFailed = () => sse([
    { type: "response.created", response: { id: "resp_1", created_at: 1, model: "m1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
    { type: "error", sequence_number: 3, code: "server_error", message: "The server had an error." }
  ]);
  const calls = mockFetch((_c, i) => (i === 0 ? startedThenFailed() : responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test"] }], { text: "Fine." })));
  const found = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx());
  expect([calls.length, found.answer]).toEqual([2, "Fine."]);
});

test("a failed attempt is recorded with the pages it had found", async () => {
  const env = freshStoresEnv("md-model-search-sources-");
  onCleanup(env.cleanup);
  const recorded = { ...config, agent: { ...config.agent, logRequests: "metadata" as const } };
  mockFetch(() => responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test/p"] }], { text: "Partial." }).text()
    .then((body) => new Response(body + sseFrame({ data: { type: "error", sequence_number: 99, code: "invalid_request_error", message: "Bad." } }), { headers: { "content-type": "text/event-stream" } })));
  await expect(modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ config: recorded, store: env.store }))).rejects.toThrow();
  const rows = env.store.db.prepare("select status, metadata_json from llm_calls").all() as Array<{ status: string; metadata_json: string }>;
  expect(rows.map((r) => [r.status, JSON.parse(r.metadata_json).sources])).toEqual([["failed", ["https://a.test/p"]]]);
});

test("a stream cut off after its search keeps the pages it had found in the record", async () => {
  const env = freshStoresEnv("md-model-search-cut-");
  onCleanup(env.cleanup);
  const recorded = { ...config, agent: { ...config.agent, logRequests: "metadata" as const } };
  // The whole answer but its last event, then the connection drops.
  mockFetch(async () => {
    const frames = (await responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test/seen"] }], { text: "Part", citations: [{ url: "https://a.test/cited", title: "C" }] }).text())
      .split("\n\n").filter(Boolean).slice(0, -1).map((frame) => `${frame}\n\n`);
    const encoder = new TextEncoder();
    // Erroring a stream drops what it still queues: each frame is read first.
    let next = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < frames.length) controller.enqueue(encoder.encode(frames[next++]!));
        else controller.error(new TypeError("terminated"));
      }
    }), { headers: { "content-type": "text/event-stream" } });
  });
  await expect(modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ config: recorded, store: env.store }))).rejects.toThrow();
  const rows = env.store.db.prepare("select status, metadata_json from llm_calls").all() as Array<{ status: string; metadata_json: string }>;
  expect(rows.length).toBeGreaterThan(0);
  // The pages the search returned are kept. A citation comes with the end of
  // the text it supports, which a stream cut off before it never sends.
  expect(rows.map((r) => [r.status, JSON.parse(r.metadata_json).sources])).toEqual(rows.map(() => ["failed", ["https://a.test/seen"]]));
});

test("searchApiOf names the API each kind of model is served on", () => {
  const api = (ref: string) => searchApiOf(resolveModelSelection(config, { model: ref, reasoningEffort: "low" }));
  expect(["p/m1", "a/c1", "k/resp", "k/msg", "k/x", "bare/msg", "kilo/kx", "gone/model"].map((ref) => [ref, api(ref)])).toEqual([
    ["p/m1", "responses"], ["a/c1", "messages"], ["k/resp", "responses"], ["k/msg", "messages"],
    ["k/x", null], ["bare/msg", null], ["kilo/kx", null], ["gone/model", null]
  ]);
  const codex = { ...resolveModelSelection(config, { model: "p/m1", reasoningEffort: "low" }), provider: "codex", providerType: "codex" } as ResolvedProviderConfig;
  expect(searchApiOf(codex)).toBe("responses");
});

test("the call is recorded with purpose web_search under the caller's scope", async () => {
  const env = freshStoresEnv("md-model-search-");
  onCleanup(env.cleanup);
  const recorded = { ...config, agent: { ...config.agent, logRequests: "metadata" as const } };
  mockFetch(() => responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test"] }], { text: "A." }));
  await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ config: recorded, store: env.store }));
  const rows = env.store.db.prepare("select purpose, scope_type, scope_id, status from llm_calls").all();
  expect(rows).toEqual([{ purpose: "web_search", scope_type: "agent_thread", scope_id: "thr_1", status: "succeeded" }]);
});

test("a retryable failure is tried again on the same model", async () => {
  const waits: number[] = [];
  const calls = mockFetch((_c, i) => (i === 0
    ? new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "content-type": "application/json" } })
    : responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test"] }], { text: "A." })));
  const found = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ wait: async (ms) => { waits.push(ms); } }));
  expect([calls.length, waits.length, found.results.length]).toEqual([2, 1, 1]);
});

/** A stream that sends these frames one read at a time, then drops a moment
 *  later (an errored stream discards what is still queued in it, so a drop
 *  at once would lose frames a real one would have delivered). */
function droppedAfter(events: unknown[]): Response {
  const frames = events.map((data) => new TextEncoder().encode(sseFrame({ data })));
  let next = 0;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next < frames.length) controller.enqueue(frames[next++]!);
      else {
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.error(new TypeError("terminated"));
      }
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

test("a provider error the stream sent before it dropped is the attempt's error, and is retried", async () => {
  const calls = mockFetch((_c, i) => (i === 0
    ? droppedAfter([
        { type: "response.created", response: { id: "resp_1", created_at: 1, model: "m1" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
        { type: "error", sequence_number: 3, code: "server_error", message: "The server had an error." }
      ])
    : responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test"] }], { text: "Fine." })));
  const found = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx());
  expect([calls.length, found.answer]).toEqual([2, "Fine."]);
});

test("a retried attempt is recorded with its attempt number beside its pages", async () => {
  const env = freshStoresEnv("md-model-search-attempt-");
  onCleanup(env.cleanup);
  const recorded = { ...config, agent: { ...config.agent, logRequests: "metadata" as const } };
  mockFetch((_c, i) => (i === 0
    ? new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "content-type": "application/json" } })
    : responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test/p"] }], { text: "A." })));
  await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ config: recorded, store: env.store }));
  const rows = env.store.db.prepare("select status, metadata_json from llm_calls order by rowid").all() as Array<{ status: string; metadata_json: string }>;
  const meta = rows.map((r) => JSON.parse(r.metadata_json) as Record<string, unknown>);
  expect(rows.map((r) => r.status)).toEqual(["failed", "succeeded"]);
  expect([meta[1]!.attempt, meta[1]!.candidateIndex, meta[1]!.sources]).toEqual([2, 0, ["https://a.test/p"]]);
  // A second attempt that fails too keeps its number.
  mockFetch(() => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "content-type": "application/json" } }));
  await expect(modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ config: recorded, store: env.store }))).rejects.toThrow();
  const failed = (env.store.db.prepare("select metadata_json from llm_calls order by rowid").all() as Array<{ metadata_json: string }>).slice(2)
    .map((r) => JSON.parse(r.metadata_json) as Record<string, unknown>);
  expect(failed.map((m) => [m.attempt ?? 1, m.sources])).toEqual([[1, []], [2, []]]);
});

test("a stop after the stream sent a provider error is a stop, not that error", async () => {
  const stop = new AbortController();
  const frames = [
    { type: "response.created", response: { id: "resp_1", created_at: 1, model: "m1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
    { type: "error", sequence_number: 3, code: "server_error", message: "The server had an error." }
  ].map((data) => new TextEncoder().encode(sseFrame({ data })));
  let next = 0;
  mockFetch(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < frames.length) controller.enqueue(frames[next++]!);
      else return new Promise(() => {});
    }
  }), { headers: { "content-type": "text/event-stream" } }));
  const pending = modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ signal: stop.signal }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  stop.abort(new Error("stopped"));
  const error = await pending.catch((e: Error) => e);
  expect(String((error as Error).message)).not.toContain("The server had an error.");
});

test("a search with no answer within its time fails with that reason, and is not tried again", async () => {
  const frames = [{ type: "response.created", response: { id: "resp_1", created_at: 1, model: "m1" } }].map((data) => new TextEncoder().encode(sseFrame({ data })));
  let next = 0;
  const calls = mockFetch(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < frames.length) controller.enqueue(frames[next++]!);
      else return new Promise(() => {});
    }
  }), { headers: { "content-type": "text/event-stream" } }));
  const error = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ timeoutMs: 50 })).catch((e: Error) => e);
  expect([error instanceof SearchFailure, (error as Error).message, calls.length]).toEqual([true, "no answer within 120 s", 1]);
});

test("a provider error the stream sent before its time ran out is the attempt's error, and is retried", async () => {
  const frames = [
    { type: "response.created", response: { id: "resp_1", created_at: 1, model: "m1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "web_search_call", id: "ws_1", status: "in_progress" } },
    { type: "error", sequence_number: 3, code: "server_error", message: "The server had an error." }
  ].map((data) => new TextEncoder().encode(sseFrame({ data })));
  const stalled = () => {
    let next = 0;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < frames.length) controller.enqueue(frames[next++]!);
        else return new Promise(() => {});
      }
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const calls = mockFetch((_c, i) => (i === 0 ? stalled() : responsesStream([{ id: "ws_1", query: "q", sources: ["https://a.test"] }], { text: "Fine." })));
  const found = await modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ timeoutMs: 150 }));
  expect([calls.length, found.answer]).toEqual([2, "Fine."]);
});

test("a stop aborts the call and is not turned into a failure", async () => {
  const stop = new AbortController();
  const calls = mockFetch(() => new Promise<Response>(() => {}));
  const pending = modelSearchKind.search({ model: "p/m1", effort: "low" }, "q", ctx({ signal: stop.signal }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort(new Error("stopped"));
  const error = await pending.catch((e: Error) => e);
  expect(error instanceof SearchFailure).toBe(false);
  expect((calls[0]!.init!.signal as AbortSignal).aborted).toBe(true);
});

// Kilo models stay out of Model search, whatever API Kilo tags them with:
// Kilo passing the hosted search tools through is untested.
test("searchApiOf: a Kilo model has no search on any API; a custom gateway's Messages model keeps its", async () => {
  const { clearKiloModelApis, replaceKiloModelApis } = await import("../src/server/config/kilo-model-apis.js");
  replaceKiloModelApis("kilo", new Map([["vendor/claude-x", "messages"], ["vendor/gpt-x", "responses"]]));
  onCleanup(() => clearKiloModelApis());
  const config = loadConfig(undefined, new MemoryJsonStore({ models: { providers: {
    kilo: { type: "kilo", apiKey: "k-test", models: [{ id: "vendor/claude-x" }, { id: "vendor/gpt-x" }, { id: "vendor/other-x" }] },
    gw: { type: "openai-compatible", baseURL: "https://gw.example/v1", apiKey: "sk-test", models: [{ id: "m-messages", protocol: "messages" }] }
  } } }));
  const api = (model: string) => searchApiOf(resolveModelSelection(config, { model, reasoningEffort: "low" }));
  expect(api("kilo/vendor/claude-x")).toBeNull();
  expect(api("kilo/vendor/gpt-x")).toBeNull();
  expect(api("kilo/vendor/other-x")).toBeNull();
  expect(api("gw/m-messages")).toBe("messages");
});
