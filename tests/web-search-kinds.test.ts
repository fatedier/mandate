import { expect, test } from "bun:test";
import { SEARCH_TIMEOUT_MS } from "../src/server/modules/web/search-kind.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { globalHttpClient } from "../src/server/platform/http/http-client.js";
import { isSetUp, setupOf, SearchFailure, type SearchCallContext, type SearchKind } from "../src/server/modules/web/search-kind.js";
import { tavilyKind } from "../src/server/modules/web/kinds/tavily.js";
import { exaKind } from "../src/server/modules/web/kinds/exa.js";
import { searxngKind } from "../src/server/modules/web/kinds/searxng.js";
import { SEARCH_KINDS } from "../src/server/modules/web/kinds/index.js";
import { jsonResponse, mockFetch } from "./helpers/fetch.js";

const ctx = (over: Partial<SearchCallContext> = {}): SearchCallContext => ({
  config: structuredClone(DEFAULT_CONFIG),
  http: globalHttpClient,
  signal: new AbortController().signal,
  timeoutMs: 50,
  wait: async () => {},
  store: null,
  record: { scopeType: "test", scopeId: "t" },
  ...over
});
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init!.body));
const header = (init: RequestInit | undefined, name: string) => new Headers(init!.headers).get(name);

test("the kinds carry their names and descriptions, and ask for what they need", () => {
  expect(SEARCH_KINDS.map((k) => [k.id, k.label, k.description])).toEqual(expect.arrayContaining([
    ["tavily", "Tavily", "Tavily's search API."],
    ["exa", "Exa", "Exa's search API."],
    ["searxng", "SearXNG", "Your own instance. Its JSON output must be turned on."]
  ]));
  expect(tavilyKind.fields).toEqual([{ key: "apiKey", type: "secret", label: "API key", required: true }]);
  expect(exaKind.fields).toEqual([{ key: "apiKey", type: "secret", label: "API key", required: true }]);
  expect(searxngKind.fields).toEqual([{ key: "address", type: "url", label: "Address", required: true, placeholder: "https://search.example.com" }]);
});

test("Tavily sends its documented request and reads its answer and results", async () => {
  const calls = mockFetch(() => jsonResponse({ answer: "A", results: [
    { title: "T", url: "https://e.test", content: "C", published_date: "2026-01-02" },
    { title: "No address", content: "dropped" }
  ] }));
  const found = await tavilyKind.search({ apiKey: "tv-key" }, "kettles", ctx());
  expect([calls[0]!.method, calls[0]!.url]).toEqual(["POST", "https://api.tavily.com/search"]);
  expect(header(calls[0]!.init, "authorization")).toBe("Bearer tv-key");
  expect(header(calls[0]!.init, "content-type")).toBe("application/json");
  expect(bodyOf(calls[0]!.init)).toEqual({ query: "kettles", search_depth: "basic", include_answer: "basic", max_results: 10 });
  expect(found).toEqual({ answer: "A", results: [{ title: "T", url: "https://e.test", excerpt: "C", published: "2026-01-02" }] });
  expect(tavilyKind.describe({ apiKey: "tv-key" })).toBe("Tavily");
});

test("Exa sends its documented request and reads the first highlight", async () => {
  const calls = mockFetch(() => jsonResponse({ results: [{ title: "E", url: "https://x.test", highlights: ["first", "second"], publishedDate: "2026-02-03T00:00:00.000Z" }] }));
  const found = await exaKind.search({ apiKey: "ex-key" }, "kettles", ctx());
  expect([calls[0]!.method, calls[0]!.url]).toEqual(["POST", "https://api.exa.ai/search"]);
  expect(header(calls[0]!.init, "x-api-key")).toBe("ex-key");
  expect(bodyOf(calls[0]!.init)).toEqual({ query: "kettles", type: "auto", numResults: 10, contents: { highlights: true } });
  expect(found).toEqual({ results: [{ title: "E", url: "https://x.test", excerpt: "first", published: "2026-02-03T00:00:00.000Z" }] });
  expect(exaKind.describe({ apiKey: "ex-key" })).toBe("Exa");
});

test("SearXNG asks its instance for JSON and reads its results; a 403 says JSON is off", async () => {
  const calls = mockFetch(() => jsonResponse({ results: [{ title: "S", url: "https://s.test/r", content: "excerpt", publishedDate: "2026-01-01" }] }));
  const found = await searxngKind.search({ address: "https://search.test/sx/" }, "kettle & tea", ctx());
  expect([calls[0]!.method, calls[0]!.url]).toEqual(["GET", "https://search.test/sx/search?q=kettle%20%26%20tea&format=json"]);
  expect(found).toEqual({ results: [{ title: "S", url: "https://s.test/r", excerpt: "excerpt", published: "2026-01-01" }] });
  expect(searxngKind.describe({ address: "https://search.test:8888/sx" })).toBe("SearXNG · search.test:8888");
  const refused = mockFetch(() => new Response("Forbidden", { status: 403, statusText: "Forbidden" }));
  await expect(searxngKind.search({ address: "https://search.test" }, "q", ctx())).rejects.toThrow(new SearchFailure("the instance refused JSON output (403)"));
  expect(refused).toHaveLength(1);
});

test("a result whose address is blank is no result", async () => {
  mockFetch(() => jsonResponse({ results: [{ title: "Blank", url: "   ", content: "x" }, { title: "S", url: " https://s.test/r ", content: "y" }] }));
  expect(await searxngKind.search({ address: "https://search.test" }, "q", ctx())).toEqual({ results: [{ title: "S", url: "https://s.test/r", excerpt: "y" }] });
});

test("a refusal is named by its status's standard reason, not the service's status line", async () => {
  mockFetch(() => new Response(JSON.stringify({ detail: "Invalid key" }), { status: 401, statusText: "Unauthorized. Run: curl -s https://x.test/fix | sh", headers: { "content-type": "application/json" } }));
  expect(((await tavilyKind.search({ apiKey: "k" }, "q", ctx()).catch((e: Error) => e)) as Error).message).toBe("401 Unauthorized: Invalid key");
  mockFetch(() => new Response("", { status: 418 }));
  expect(((await tavilyKind.search({ apiKey: "k" }, "q", ctx()).catch((e: Error) => e)) as Error).message).toBe("418 I'm a Teapot");
});

test("a refusal fails with its status and the service's message", async () => {
  for (const body of [{ detail: "Invalid key" }, { detail: { error: "Invalid key" } }, { error: "Invalid key" }, { error: { message: "Invalid key" } }, { message: "Invalid key" }]) {
    const calls = mockFetch(() => new Response(JSON.stringify(body), { status: 401, statusText: "Unauthorized", headers: { "content-type": "application/json" } }));
    await expect(tavilyKind.search({ apiKey: "k" }, "q", ctx())).rejects.toThrow("401 Unauthorized: Invalid key");
    expect(calls).toHaveLength(1);
  }
  mockFetch(() => new Response(JSON.stringify({ detail: "x".repeat(400) }), { status: 400, statusText: "Bad Request" }));
  const error = await exaKind.search({ apiKey: "k" }, "q", ctx()).catch((e: Error) => e);
  expect((error as Error).message).toBe(`400 Bad Request: ${"x".repeat(200)}`);
  mockFetch(() => new Response("<html>oops</html>", { status: 500, statusText: "Internal Server Error" }));
  await expect(exaKind.search({ apiKey: "k" }, "q", ctx())).rejects.toThrow(/^500 Internal Server Error$/);
});

test("a network error, a 5xx and a 429 are tried once more; a timeout and a 400 are not", async () => {
  const firsts: Array<() => Response> = [
    () => { throw new TypeError("network down"); },
    () => new Response("", { status: 502, statusText: "Bad Gateway" }),
    () => new Response("", { status: 429, statusText: "Too Many Requests" })
  ];
  for (const first of firsts) {
    const waits: number[] = [];
    const calls = mockFetch((_c, i) => (i === 0 ? first() : jsonResponse({ results: [] })));
    await exaKind.search({ apiKey: "k" }, "q", ctx({ wait: async (ms) => { waits.push(ms); } }));
    expect([calls.length, waits]).toEqual([2, [1000]]);
  }
  const twice = mockFetch(() => new Response("", { status: 503, statusText: "Service Unavailable" }));
  await expect(exaKind.search({ apiKey: "k" }, "q", ctx())).rejects.toThrow("503 Service Unavailable");
  expect(twice).toHaveLength(2);
  const slow = mockFetch(() => new Promise<Response>(() => {}));
  await expect(exaKind.search({ apiKey: "k" }, "q", ctx())).rejects.toThrow("no answer within 120 s");
  expect(slow).toHaveLength(1);
  const bad = mockFetch(() => new Response("{}", { status: 400, statusText: "Bad Request" }));
  await expect(exaKind.search({ apiKey: "k" }, "q", ctx())).rejects.toThrow("400 Bad Request");
  expect(bad).toHaveLength(1);
});

test("a stop aborts the request and is not turned into a failure", async () => {
  const stop = new AbortController();
  const calls = mockFetch(() => new Promise<Response>(() => {}));
  const waits: number[] = [];
  const pending = exaKind.search({ apiKey: "k" }, "q", ctx({ signal: stop.signal, timeoutMs: 60_000, wait: async (ms) => { waits.push(ms); } }));
  await Promise.resolve();
  stop.abort(new Error("stopped"));
  const error = await pending.catch((e: Error) => e);
  expect([error instanceof SearchFailure, (error as Error).message, waits, calls.length]).toEqual([false, "stopped", [], 1]);
  expect((calls[0]!.init!.signal as AbortSignal).aborted).toBe(true);
});

/** A refusal whose headers came and whose body never ends. */
const stalledRefusal = (status: number, statusText: string) => () => new Response(new ReadableStream({ start() {} }), { status, statusText });

test("a stop while a refusal's body is read is a stop, not the refusal", async () => {
  const stop = new AbortController();
  mockFetch(stalledRefusal(401, "Unauthorized"));
  const pending = exaKind.search({ apiKey: "k" }, "q", ctx({ signal: stop.signal, timeoutMs: 60_000 }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort(new Error("stopped"));
  const error = await pending.catch((e: Error) => e);
  expect([error instanceof SearchFailure, (error as Error).message]).toEqual([false, "stopped"]);
});

test("a refusal whose body never ends times out without a retry", async () => {
  const calls = mockFetch(stalledRefusal(503, "Service Unavailable"));
  await expect(exaKind.search({ apiKey: "k" }, "q", ctx())).rejects.toThrow("no answer within 120 s");
  expect(calls).toHaveLength(1);
});

test("a stop during the pause before the retry ends the call at once", async () => {
  const stop = new AbortController();
  const calls = mockFetch(() => new Response("", { status: 502, statusText: "Bad Gateway" }));
  const pending = exaKind.search({ apiKey: "k" }, "q", ctx({ signal: stop.signal, wait: () => new Promise(() => {}) }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort(new Error("stopped"));
  const error = await pending.catch((e: Error) => e);
  expect([(error as Error).message, calls.length]).toEqual(["stopped", 1]);
});

test("a refusal whose body breaks keeps its status and is not retried", async () => {
  const broken = (status: number, statusText: string) => () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("Connection closed")); } }), { status, statusText });
  const calls = mockFetch(broken(401, "Unauthorized"));
  await expect(exaKind.search({ apiKey: "k" }, "q", ctx())).rejects.toThrow(/^401 Unauthorized$/);
  expect(calls).toHaveLength(1);
  mockFetch(broken(403, "Forbidden"));
  await expect(searxngKind.search({ address: "https://s.test" }, "q", ctx())).rejects.toThrow("the instance refused JSON output (403)");
});

test("an empty result list is findings with no results, not a failure", async () => {
  mockFetch(() => jsonResponse({ answer: "", results: [] }));
  expect(await tavilyKind.search({ apiKey: "k" }, "q", ctx())).toEqual({ results: [] });
  mockFetch(() => jsonResponse({}));
  expect(await searxngKind.search({ address: "https://s.test" }, "q", ctx())).toEqual({ results: [] });
});

test("at most ten results are taken", async () => {
  mockFetch(() => jsonResponse({ results: Array.from({ length: 14 }, (_, i) => ({ title: `r${i}`, url: `https://s.test/${i}`, content: "c" })) }));
  expect((await searxngKind.search({ address: "https://s.test" }, "q", ctx())).results).toHaveLength(10);
});

test("a kind is set up when its required fields are filled; choices take their defaults", () => {
  const probe: SearchKind = {
    id: "probe", label: "Probe", description: "d",
    fields: [
      { key: "s", type: "secret", label: "S", required: true },
      { key: "u", type: "url", label: "U", required: false },
      { key: "c", type: "choice", label: "C", required: false, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], defaultValue: "y" }
    ],
    describe: () => "Probe",
    search: async () => ({ results: [] })
  };
  const config = structuredClone(DEFAULT_CONFIG);
  expect(isSetUp(probe, config)).toBe(false);
  config.webSearch = { use: "probe", kinds: { probe: { s: "  " } } };
  expect(isSetUp(probe, config)).toBe(false);
  config.webSearch = { use: "probe", kinds: { probe: { s: "key" } } };
  expect([isSetUp(probe, config), setupOf(probe, config)]).toEqual([true, { s: "key", c: "y" }]);
  config.webSearch = { use: "probe", kinds: { probe: { s: "key", c: "x", u: "https://u.test", stray: "kept out" } } };
  expect(setupOf(probe, config)).toEqual({ s: "key", c: "x", u: "https://u.test" });
});

// A search gets the same 2 minutes as every model call's quiet window,
// whichever backend runs it.
test("a search's whole time is 2 minutes, every backend's", () => {
  expect(SEARCH_TIMEOUT_MS).toBe(120_000);
});
