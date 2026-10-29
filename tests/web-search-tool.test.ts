import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import type { Config, JsonObject } from "../src/server/config.js";
import { ToolDispatcher, ToolRegistry, TOOL_CALL_STOPPED, type ToolDefinition } from "../src/server/modules/agent/tool-registry.js";
import { createWebTools } from "../src/server/modules/web/web-tools.js";
import { mountWebRoutes } from "../src/server/modules/web/web-routes.js";
import { applyWebSearchPatch, webSearchSettings } from "../src/server/modules/web/web-search-settings.js";
import { CHECK_QUERY, checkWebSearch, createWebSearch } from "../src/server/modules/web/web-search.js";
import { SEARCH_KINDS } from "../src/server/modules/web/kinds/index.js";
import { SEARCH_TIMEOUT_MS, SearchFailure, type SearchKind } from "../src/server/modules/web/search-kind.js";
import { buildCommonToolPacks } from "../src/server/modules/registry.js";
import { GLOBAL_REUSED_TOOLS, pickGlobalReusedTools } from "../src/server/modules/global/global-scope.js";
import { pickSubagentTools, SUBAGENT_TOOLS } from "../src/server/runtime/scopes/subagent-scope.js";
import { formatSearchText, parseSearchText } from "../src/shared/web-tool-text.js";
import type { MandateStore } from "../src/server/app/store.js";
import type { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import type { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import { jsonResponse, mockFetch } from "./helpers/fetch.js";
import { stub, toolContext } from "./helpers/typed.js";

const ID = "0123456789abcdef";
const configWith = (webSearch: Config["webSearch"]): Config => ({ ...structuredClone(DEFAULT_CONFIG), webSearch });
const toolNamed = (tools: readonly ToolDefinition[], name: string) => tools.find((t) => t.name === name)!;
/** A clock that moves on by `step` ms at each reading. */
const ticking = (step: number) => { let t = 0; return () => (t += step); };
// A kind added only here, with a field of every type: it is listed, saved
// and searched with no change outside the kind. Its searches are filed in
// `records`.
function probeKind(records: Array<{ scopeType: string; scopeId: string }> = []): SearchKind {
  return {
    id: "probe", label: "Probe", description: "A test kind.",
    fields: [
      { key: "m", type: "model", label: "M", required: true, accepts: (model) => model.provider === "openai" },
      { key: "p", type: "provider", label: "P", required: false, providerTypes: ["openai"] },
      { key: "s", type: "secret", label: "S", required: true },
      { key: "u", type: "url", label: "U", required: false, placeholder: "https://u.example" },
      { key: "c", type: "choice", label: "C", required: false, options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }], defaultValue: "y" }
    ],
    describe: () => "Probe",
    search: async (setup, query, ctx) => {
      records.push(ctx.record);
      return { results: [{ title: `${setup.c}:${query}`, url: "https://p.test", excerpt: setup.s! }] };
    }
  };
}

test("the search tool's texts read word for word", () => {
  const tool = toolNamed(createWebTools({ getConfig: () => configWith({ use: "off", kinds: {} }) }).tools, "web_search");
  expect(tool.description).toBe("Search the web. Returns what the search found: the pages, each with its address and a short excerpt, and an answer written from them when the search gives one. Use it for information that may be newer than what you know or that needs a source; read a page with `web_fetch` when an excerpt is not enough.");
  expect((tool.parameters as unknown as { shape: { query: { description?: string } } }).shape.query.description).toBe("What to find, written as you would ask a person.");
});

test("web_search is offered only while the chosen kind is set up; web_fetch always", () => {
  let config = configWith({ use: "off", kinds: {} });
  const web = createWebTools({ getConfig: () => config });
  const registry = new ToolRegistry();
  for (const tool of web.tools) registry.register(tool);
  const offered = () => Object.keys(registry.tools).sort();
  expect(offered()).toEqual(["web_fetch"]);
  config = configWith({ use: "tavily", kinds: {} });
  expect(offered()).toEqual(["web_fetch"]);
  config = configWith({ use: "tavily", kinds: { tavily: { apiKey: "k" } } });
  expect(offered()).toEqual(["web_fetch", "web_search"]);
  config = configWith({ use: "retired-kind", kinds: { "retired-kind": { a: "b" } } });
  expect(offered()).toEqual(["web_fetch"]);
});

test("a search reads as the formatted findings", async () => {
  const config = configWith({ use: "tavily", kinds: { tavily: { apiKey: "k" } } });
  mockFetch(() => jsonResponse({ answer: "A", results: [{ title: "T", url: "https://e.test", content: "C" }] }));
  const tool = toolNamed(createWebTools({ getConfig: () => config, now: ticking(1200), randomId: () => ID }).tools, "web_search");
  const out = await tool.handler({ query: "kettles" }, toolContext({ threadId: "thr_1" }));
  expect(out).toBe(formatSearchText({ answer: "A", results: [{ title: "T", url: "https://e.test", excerpt: "C" }], backend: "Tavily", ms: 1200, id: ID }));
});

test("nothing found reads as the nothing-found line; an answer with no pages is the answer", async () => {
  const config = configWith({ use: "tavily", kinds: { tavily: { apiKey: "k" } } });
  mockFetch(() => jsonResponse({ results: [] }));
  const tool = toolNamed(createWebTools({ getConfig: () => config, randomId: () => ID, now: ticking(1000) }).tools, "web_search");
  expect(await tool.handler({ query: "q" }, toolContext({}))).toBe("The search found nothing for this query.");
  mockFetch(() => jsonResponse({ answer: "Kettles boil at 100.", results: [] }));
  expect(await tool.handler({ query: "q" }, toolContext({}))).toBe(`<<<WEB_TEXT id="${ID}">>>\nAnswer: Kettles boil at 100.\n<<<END_WEB_TEXT id="${ID}">>>\nFound by Tavily in 1.0 s.`);
});

test("a failure is an error naming the backend and the reason", async () => {
  const config = configWith({ use: "searxng", kinds: { searxng: { address: "https://s.test" } } });
  mockFetch(() => new Response("no", { status: 403, statusText: "Forbidden" }));
  const registry = new ToolRegistry();
  for (const tool of createWebTools({ getConfig: () => config, wait: async () => {} }).tools) registry.register(tool);
  expect(await new ToolDispatcher(registry).dispatch({ toolCallId: "c", toolName: "web_search", args: { query: "q" } }, toolContext({})))
    .toEqual({ isError: true, error: "Web search failed (SearXNG · s.test): the instance refused JSON output (403)." });
  // A reason that ends a sentence of its own gets no second full stop.
  mockFetch(() => { throw new TypeError("network down."); });
  expect((await new ToolDispatcher(registry).dispatch({ toolCallId: "c", toolName: "web_search", args: { query: "q" } }, toolContext({}))).error)
    .toBe("Web search failed (SearXNG · s.test): network down.");
});

test("a stopped turn aborts the search request", async () => {
  const config = configWith({ use: "exa", kinds: { exa: { apiKey: "k" } } });
  const calls = mockFetch(() => new Promise<Response>(() => {}));
  const stop = new AbortController();
  const tool = toolNamed(createWebTools({ getConfig: () => config }).tools, "web_search");
  const pending = tool.handler({ query: "q" }, toolContext({ signal: stop.signal }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort();
  await expect(pending).rejects.toThrow(TOOL_CALL_STOPPED);
  expect((calls[0]!.init!.signal as AbortSignal).aborted).toBe(true);
});

// The check is the user's look at the search, apart from what an agent is
// given: what came back, or what a model said instead of searching.
test("the check shows the search's answer and its first three pages, or what a model said instead of searching", async () => {
  const config = configWith({ use: "found", kinds: { found: {} } });
  const pages = [1, 2, 3, 4, 5].map((i) => ({ title: `Page ${i}`, url: `https://p${i}.test/x`, excerpt: "e" }));
  const kind = (search: SearchKind["search"]): SearchKind => ({ id: "found", label: "Found", description: "", fields: [], describe: () => "Found", search });
  const check = (search: SearchKind["search"]) => checkWebSearch(createWebSearch({ getConfig: () => config, kinds: [kind(search)], now: ticking(1500) }));
  expect(await check(async () => ({ answer: "  Python 3.15.0\n  is the latest.  ", results: pages }))).toEqual({
    result: "works", count: 5, ms: 1500, answer: "Python 3.15.0 is the latest.",
    top: pages.slice(0, 3).map(({ title, url }) => ({ title, url }))
  });
  // No answer, none shown; a long one is cut to what a few lines hold.
  expect(await check(async () => ({ results: pages.slice(0, 1) }))).toEqual({ result: "works", count: 1, ms: 1500, top: [{ title: "Page 1", url: "https://p1.test/x" }] });
  const long = await check(async () => ({ answer: "word ".repeat(400), results: pages })) as { answer: string };
  expect(long.answer.length).toBeLessThanOrEqual(401);
  expect(long.answer.endsWith("…")).toBe(true);
  // A model that answered without searching: the check fails, with what it said.
  expect(await check(async () => { throw new SearchFailure("the model answered without searching", undefined, "I can't search\n  the web here."); }))
    .toEqual({ result: "failed", message: "the model answered without searching", reply: "I can't search the web here." });
  // Any other failure: its reason alone.
  expect(await check(async () => { throw new SearchFailure("401 Unauthorized", 401); })).toEqual({ result: "failed", message: "401 Unauthorized" });
  // An agent is told what it was told before: the reason, not the reply.
  const tool = toolNamed(createWebTools({ getConfig: () => config, kinds: [kind(async () => { throw new SearchFailure("the model answered without searching", undefined, "I can't search the web here."); })] }).tools, "web_search");
  await expect(tool.handler({ query: "q" }, toolContext())).rejects.toThrow("Web search failed (Found): the model answered without searching.");
});

test("the check runs one real search with a fixed query and says what came of it", async () => {
  // A question about something current, so a model that may choose not to
  // search does: a bare word got a request to say what to look up.
  expect(CHECK_QUERY).toBe("What is the latest stable version of Python?");
  const config = configWith({ use: "tavily", kinds: { tavily: { apiKey: "k" } } });
  const calls = mockFetch(() => jsonResponse({ results: [{ title: "a", url: "https://a.test", content: "x" }, { title: "b", url: "https://b.test", content: "y" }] }));
  const top = [{ title: "a", url: "https://a.test" }, { title: "b", url: "https://b.test" }];
  expect(await checkWebSearch(createWebSearch({ getConfig: () => config, now: ticking(2345) }))).toEqual({ result: "works", count: 2, ms: 2345, top });
  expect(JSON.parse(String(calls[0]!.init!.body)).query).toBe("What is the latest stable version of Python?");
  mockFetch(() => new Response(JSON.stringify({ detail: "Invalid key" }), { status: 401, statusText: "Unauthorized" }));
  expect(await checkWebSearch(createWebSearch({ getConfig: () => config }))).toEqual({ result: "failed", message: "401 Unauthorized: Invalid key" });
  expect(await checkWebSearch(createWebSearch({ getConfig: () => configWith({ use: "off", kinds: {} }) }))).toEqual({ result: "failed", message: "Not set up" });
});

// The Settings check, through its route.
const appFor = (webSearch: Config["webSearch"], now?: () => number) => {
  const app = new Hono();
  mountWebRoutes(app, { config: configWith(webSearch), store: null as never }, now ? { now } : {});
  return app;
};
const check = async (app: Hono) => (await app.request("/api/settings/web-search/check", { method: "POST" })).json();

test("the check runs one real search with the saved settings and says how many results and how long", async () => {
  let t = 0;
  const calls = mockFetch(() => jsonResponse({ results: [{ title: "a", url: "https://a.test", content: "x" }, { title: "b", url: "https://b.test", content: "y" }] }));
  expect(await check(appFor({ use: "tavily", kinds: { tavily: { apiKey: "k" } } }, () => (t += 2345)))).toEqual({
    ok: true, result: "works", count: 2, ms: 2345, top: [{ title: "a", url: "https://a.test" }, { title: "b", url: "https://b.test" }]
  });
  expect(calls).toHaveLength(1);
});

test("a kind added only here works end to end with no change outside it", async () => {
  const records: Array<{ scopeType: string; scopeId: string }> = [];
  const probe = probeKind(records);
  const config = configWith({ use: "probe", kinds: { probe: { m: "p/m1", s: "secret" } } });
  const web = createWebTools({ getConfig: () => config, kinds: [...SEARCH_KINDS, probe] });
  const tool = toolNamed(web.tools, "web_search");
  expect(tool.available!()).toBe(true);
  expect(parseSearchText(await tool.handler({ query: "q" }, toolContext({ threadId: "thr_7" })) as string)).toMatchObject({ backend: "Probe", results: [{ title: "y:q", excerpt: "secret" }] });
  expect(await checkWebSearch(web.search)).toMatchObject({ result: "works", count: 1 });
  // An agent's search is filed under its thread; the check under Settings.
  expect(records).toStrictEqual([{ scopeType: "agent_thread", scopeId: "thr_7" }, { scopeType: "settings", scopeId: "web_search" }]);
});

test("a kind added only for the test is listed with its five fields and saved, its secret never sent", () => {
  const kinds = [...SEARCH_KINDS, probeKind()];
  const root: JsonObject = {};
  applyWebSearchPatch(root, { use: "probe", kinds: { probe: { m: "p/m1", p: "p", s: "secret-value", u: "https://u.test", c: "x" } } }, kinds);
  expect(root.webSearch).toEqual({ use: "probe", kinds: { probe: { m: "p/m1", p: "p", s: "secret-value", u: "https://u.test", c: "x" } } });
  const config: Config = { ...structuredClone(DEFAULT_CONFIG), webSearch: root.webSearch as Config["webSearch"] };
  config.models.providers = { p: { type: "openai", baseURL: "", apiKey: "k", models: [{ id: "m1", input: ["text"] }] }, z: { type: "anthropic", baseURL: "", apiKey: "k", models: [{ id: "c1", input: ["text"] }] } };
  const section = webSearchSettings(config, kinds);
  expect(section.use).toBe("probe");
  const listed = section.kinds.find((k) => k.id === "probe")!;
  expect(JSON.stringify(listed)).not.toContain("secret-value");
  expect([listed.setUp, listed.fields.map((f) => [f.key, f.type, f.value])]).toEqual([true, [["m", "model", "p/m1"], ["p", "provider", "p"], ["s", "secret", ""], ["u", "url", "https://u.test"], ["c", "choice", "x"]]]);
  expect(listed.fields[0]!.options).toEqual([{ value: "p/m1", label: "p/m1" }]);
  expect(listed.fields[1]!.options).toEqual([{ value: "p", label: "p" }]);
  expect([listed.fields[2]!.configured, listed.fields[3]!.placeholder, listed.fields[4]!.options]).toEqual([true, "https://u.example", [{ value: "x", label: "X" }, { value: "y", label: "Y" }]]);
});

test("every agent kind gets both tools; a subagent gets its parent's", () => {
  const web = createWebTools({ getConfig: () => configWith({ use: "tavily", kinds: { tavily: { apiKey: "k" } } }) });
  const packsFor = (scope: "manager" | "worker") => buildCommonToolPacks({
    scope, web, store: stub<MandateStore>({ db: stub<Database>() }), skillRegistry: stub<SkillRegistry>(), watchManager: stub<WindowWatchManager>()
  });
  const names = (tools: readonly ToolDefinition[]) => tools.map((t) => t.name).filter((n) => n.startsWith("web_")).sort();
  const manager = packsFor("manager");
  const worker = packsFor("worker");
  expect(names(manager.flatMap((p) => p.tools))).toEqual(["web_fetch", "web_search"]);
  expect(names(worker.flatMap((p) => p.tools))).toEqual(["web_fetch", "web_search"]);
  expect([GLOBAL_REUSED_TOOLS.has("web_search"), GLOBAL_REUSED_TOOLS.has("web_fetch"), SUBAGENT_TOOLS.has("web_search"), SUBAGENT_TOOLS.has("web_fetch")]).toEqual([true, true, true, true]);
  expect(names(pickGlobalReusedTools(manager).tools)).toEqual(["web_fetch", "web_search"]);
  expect(names(pickSubagentTools("worker", worker).tools)).toEqual(["web_fetch", "web_search"]);
  expect(names(pickSubagentTools("manager", manager).tools)).toEqual(["web_fetch", "web_search"]);
  // Built once for every agent: the kept pages are one set.
  expect(toolNamed(manager.flatMap((p) => p.tools), "web_fetch")).toBe(toolNamed(worker.flatMap((p) => p.tools), "web_fetch"));
});

test("a call that names web_search after search was turned off is an unknown tool", async () => {
  let config = configWith({ use: "exa", kinds: { exa: { apiKey: "k" } } });
  const registry = new ToolRegistry();
  for (const tool of createWebTools({ getConfig: () => config }).tools) registry.register(tool);
  expect(Object.keys(registry.tools)).toContain("web_search");
  config = configWith({ use: "off", kinds: { exa: { apiKey: "k" } } });
  expect(await new ToolDispatcher(registry).dispatch({ toolCallId: "c", toolName: "web_search", args: { query: "q" } }, toolContext({})))
    .toEqual({ isError: true, error: "unknown tool: web_search" });
});

// Unless a test passes its own, every backend is given the search's 2
// minutes.
test("a search hands its backend the 2 minutes a search may take", async () => {
  const config = configWith({ use: "found", kinds: { found: {} } });
  const given: number[] = [];
  const kind: SearchKind = { id: "found", label: "Found", description: "", fields: [], describe: () => "Found", search: async (_setup, _query, ctx) => { given.push(ctx.timeoutMs); return { results: [] }; } };
  await createWebSearch({ getConfig: () => config, kinds: [kind] }).search("python release", { record: { scopeType: "agent_thread", scopeId: "thr_a" } });
  expect(given).toEqual([SEARCH_TIMEOUT_MS]);
  expect(SEARCH_TIMEOUT_MS).toBe(120_000);
});
