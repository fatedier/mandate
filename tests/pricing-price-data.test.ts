import { expect, jest, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { LITELLM_PRICES_URL } from "../src/server/modules/pricing/litellm.js";
import { MODELS_DEV_URL } from "../src/server/modules/pricing/models-dev.js";
import { PriceData } from "../src/server/modules/pricing/price-data.js";
import type { HttpClient } from "../src/server/platform/http/http-client.js";
import { fakeClock } from "./helpers/fake-clock.js";
import { tempDir } from "./helpers/temp.js";

// Both lists as their sources publish them, with sample rates.
function litellmTable(extra = 0) {
  const table: Record<string, unknown> = {
    "gpt-test-5": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 },
    "claude-test-1": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 4e-6, output_cost_per_token: 2e-5 }
  };
  for (let i = 0; i < extra; i += 1) table[`extra-${i}`] = { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 };
  return JSON.stringify(table);
}
function modelsDevApi() {
  return JSON.stringify({
    fill: { id: "fill", name: "Fill", api: "https://fill.example.test/v1", models: { m1: { id: "m1", cost: { input: 0.5, output: 1 } } } },
    "fill-coding-plan": { id: "fill-coding-plan", name: "Fill plan", api: "https://plan.example.test/v1", models: { p: { id: "p", cost: { input: 0, output: 0 } } } }
  });
}

type Reply = { status: number; body?: string; headers?: Record<string, string> };
function fakeHttp(replies: Record<string, Reply | ((init?: RequestInit) => Reply)>) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const http: HttpClient = {
    async fetch(input, init) {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      const reply = replies[url];
      if (!reply) return new Response("missing", { status: 404 });
      const r = typeof reply === "function" ? reply(init) : reply;
      return new Response(r.status === 304 ? null : r.body ?? "", { status: r.status, headers: r.headers });
    }
  };
  return { http, calls };
}

const BOTH = () => ({
  [LITELLM_PRICES_URL]: { status: 200, body: litellmTable(), headers: { etag: "\"l1\"" } },
  [MODELS_DEV_URL]: { status: 200, body: modelsDevApi(), headers: { etag: "\"m1\"" } }
});

const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
const openai = { model: "gpt-test-5", baseURL: "https://api.openai.com/v1", providerType: "openai", serviceTier: null, usage };
const fill = { model: "m1", baseURL: "https://fill.example.test/v1", providerType: "openai-compatible", serviceTier: null, usage };

let clock = Date.parse("2026-10-22T08:00:00Z");
async function loaded(dataDir: string, http: HttpClient, autoUpdate = true) {
  const data = new PriceData({ dataDir, http, autoUpdate: () => autoUpdate, now: () => new Date(clock) });
  await data.load();
  return data;
}

/** Waits for a download `ensure()` started. */
async function settled(data: PriceData) {
  for (let i = 0; i < 50 && !data.ready(); i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("nothing ships: with no saved copy nothing is priced and pricing waits until a download is tried", async () => {
  const data = await loaded(tempDir("md-prices-"), fakeHttp({}).http);
  expect(data.catalog().dataInfo()).toMatchObject({ litellmDate: null, modelsDevDate: null });
  expect(data.catalog().listPrice(openai)).toBeNull();
  expect(data.ready()).toBe(false);
});

test("the first need downloads both lists, trimmed and saved; the next start reads them and asks nothing", async () => {
  const dir = tempDir("md-prices-");
  const { http, calls } = fakeHttp(BOTH());
  const data = await loaded(dir, http);
  let changed = 0;
  data.onChange(() => { changed += 1; });
  data.ensure();
  await settled(data);
  expect(data.ready()).toBe(true);
  expect(changed).toBe(1);
  expect(data.catalog().listPrice(openai)!.usd).toBeCloseTo(2, 12);
  expect(data.catalog().catalogPrice(fill)!.usd).toBeCloseTo(0.5, 12);
  expect(data.catalog().isPlanProvider("https://plan.example.test/v1")).toBe(true);
  expect(data.catalog().dataInfo()).toMatchObject({ litellmDate: "2026-10-22", modelsDevDate: "2026-10-22" });
  expect(calls.map((c) => c.url)).toStrictEqual([LITELLM_PRICES_URL, MODELS_DEV_URL]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "prices", "litellm.json"), "utf8"));
  expect(Object.keys(saved.entries).sort()).toEqual(["claude-test-1", "gpt-test-5"]);

  const again = fakeHttp({});
  const next = await loaded(dir, again.http);
  expect(next.ready()).toBe(true);
  next.ensure();
  expect(again.calls).toStrictEqual([]);
  expect(next.catalog().listPrice(openai)!.usd).toBeCloseTo(2, 12);
});

test("a daily refresh sends the saved copies' validators, and 304 keeps them", async () => {
  const dir = tempDir("md-prices-");
  const first = await loaded(dir, fakeHttp(BOTH()).http);
  await first.refresh();
  const { http, calls } = fakeHttp({ [LITELLM_PRICES_URL]: { status: 304 }, [MODELS_DEV_URL]: { status: 304 } });
  const data = await loaded(dir, http);
  expect(await data.refresh()).toEqual({ litellm: "unchanged", modelsDev: "unchanged" });
  expect(calls.map((c) => c.headers.get("if-none-match"))).toStrictEqual(["\"l1\"", "\"m1\""]);
  expect(data.catalog().listPrice(openai)).not.toBeNull();
});

test("a download that lost most of its models, is cut off, or is not a table is kept out", async () => {
  const dir = tempDir("md-prices-");
  const data = await loaded(dir, fakeHttp({ ...BOTH(), [LITELLM_PRICES_URL]: { status: 200, body: litellmTable(10) } }).http);
  await data.refresh();
  for (const body of [litellmTable(), litellmTable(10).slice(0, 200), "[]", "{}"]) {
    const next = fakeHttp({ [LITELLM_PRICES_URL]: { status: 200, body }, [MODELS_DEV_URL]: { status: 304 } });
    const replaced = new PriceData({ dataDir: dir, http: next.http, autoUpdate: () => true, now: () => new Date(clock) });
    await replaced.load();
    expect((await replaced.refresh()).litellm).toBe("kept");
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "prices", "litellm.json"), "utf8")).entries)).toHaveLength(12);
  }
});

test("a failed download keeps what is in use, lets pricing go on, and is not tried again for an hour", async () => {
  const dir = tempDir("md-prices-");
  const { http, calls } = fakeHttp({});
  const data = await loaded(dir, http);
  data.ensure();
  await settled(data);
  expect(data.ready()).toBe(true);
  expect(data.catalog().listPrice(openai)).toBeNull();
  data.ensure();
  expect(calls).toHaveLength(2);
  clock += 61 * 60 * 1000;
  data.ensure();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(4);
});

test("one download at a time", async () => {
  const { http, calls } = fakeHttp(BOTH());
  const data = await loaded(tempDir("md-prices-"), http);
  data.ensure();
  data.ensure();
  await settled(data);
  expect(calls).toHaveLength(2);
});

test("an unwritable data dir still prices with what was downloaded", async () => {
  const dir = tempDir("md-prices-");
  fs.writeFileSync(path.join(dir, "prices"), "not a directory");
  const data = await loaded(dir, fakeHttp(BOTH()).http);
  expect(await data.refresh()).toEqual({ litellm: "updated", modelsDev: "updated" });
  expect(data.catalog().listPrice(openai)).not.toBeNull();
});

test("with automatic updates off nothing is fetched, and pricing does not wait", async () => {
  const { http, calls } = fakeHttp(BOTH());
  const data = await loaded(tempDir("md-prices-"), http, false);
  expect(data.ready()).toBe(true);
  data.ensure();
  expect(await data.refresh()).toEqual({ litellm: "off", modelsDev: "off" });
  expect(calls).toStrictEqual([]);
});

test("a saved copy of the wrong shape, or cut off, is set aside at load; the other is used", async () => {
  const dir = tempDir("md-prices-");
  const first = await loaded(dir, fakeHttp(BOTH()).http);
  await first.refresh();
  fs.writeFileSync(path.join(dir, "prices", "litellm.json"), JSON.stringify({ date: "2026-10-22", entries: { x: { provider: "openai", rates: { base: { input: "1" } } } } }));
  const data = await loaded(dir, fakeHttp({}).http);
  expect(data.catalog().listPrice(openai)).toBeNull();
  expect(data.catalog().catalogPrice(fill)).not.toBeNull();
  expect(data.ready()).toBe(false);
  fs.writeFileSync(path.join(dir, "prices", "models-dev.json"), "{\"date\": \"2026-");
  const cut = await loaded(dir, fakeHttp({}).http);
  expect(cut.catalog().dataInfo()).toMatchObject({ litellmDate: null, modelsDevDate: null });
});

test("a saved copy that is not used sends no validators, so a download can replace it", async () => {
  const dir = tempDir("md-prices-");
  fs.mkdirSync(path.join(dir, "prices"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prices", "litellm.json"), "not json");
  fs.writeFileSync(path.join(dir, "prices", "litellm.meta.json"), JSON.stringify({ etag: "\"old\"" }));
  let seen = "unset" as string | null;
  const { http } = fakeHttp({
    [LITELLM_PRICES_URL]: (init) => { seen = new Headers(init?.headers).get("if-none-match"); return { status: 200, body: litellmTable() }; },
    [MODELS_DEV_URL]: { status: 304 }
  });
  const data = await loaded(dir, http);
  expect((await data.refresh()).litellm).toBe("updated");
  expect(seen).toBeNull();
});

test("a saved copy whose optional rates have the wrong shape is set aside, whichever list it is", async () => {
  const dir = tempDir("md-prices-");
  const first = await loaded(dir, fakeHttp(BOTH()).http);
  await first.refresh();
  const litellm = JSON.parse(fs.readFileSync(path.join(dir, "prices", "litellm.json"), "utf8"));
  const modelsDev = JSON.parse(fs.readFileSync(path.join(dir, "prices", "models-dev.json"), "utf8"));
  const bad: Array<[string, (rates: Record<string, unknown>) => void]> = [
    ["tiers not a list", (r) => { r.tiers = {}; }],
    ["a tier without a threshold", (r) => { r.tiers = [{ rates: { input: 1 } }]; }],
    ["a tier rate not a number", (r) => { r.tiers = [{ above: 1000, rates: { input: "1" } }]; }],
    ["a cache rate not a number", (r) => { (r.base as Record<string, unknown>).cacheRead = null; }],
    ["flex not rates", (r) => { r.flex = 1; }],
    ["flex tiers not a list", (r) => { r.flex = { base: {}, tiers: "x" }; }]
  ];
  for (const [, spoil] of bad) {
    const l = structuredClone(litellm);
    spoil(l.entries["gpt-test-5"].rates);
    fs.writeFileSync(path.join(dir, "prices", "litellm.json"), JSON.stringify(l));
    const m = structuredClone(modelsDev);
    spoil(m.providers[0].models[0].rates);
    fs.writeFileSync(path.join(dir, "prices", "models-dev.json"), JSON.stringify(m));
    const data = await loaded(dir, fakeHttp({}).http);
    expect(data.catalog().dataInfo()).toMatchObject({ litellmDate: null, modelsDevDate: null });
  }
});

test("a request that waits for a download in flight gets the data it brings", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const replies = BOTH();
  const http: HttpClient = {
    async fetch(input) {
      await gate;
      const r = replies[String(input) as keyof typeof replies];
      return new Response(r.body, { status: r.status, headers: r.headers });
    }
  };
  const data = await loaded(tempDir("md-prices-"), http);
  data.ensure();
  const waited = data.whenSettled(5_000);
  release();
  await waited;
  expect(data.catalog().listPrice(openai)).not.toBeNull();
  // Nothing in flight: no wait.
  const started = Date.now();
  await data.whenSettled(5_000);
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("a wait for a download stays until its time, and then answers with what there is", async () => {
  const http: HttpClient = { fetch: () => new Promise<Response>(() => {}) };
  const data = await loaded(tempDir("md-prices-"), http);
  data.ensure();
  fakeClock();
  let done = false;
  const waited = data.whenSettled(15_000).then(() => { done = true; });
  jest.advanceTimersByTime(14_999);
  // Long enough for a settled wait to reach `done`.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(done).toBe(false);
  jest.advanceTimersByTime(1);
  await waited;
  expect(done).toBe(true);
  expect(data.catalog().listPrice(openai)).toBeNull();
});
