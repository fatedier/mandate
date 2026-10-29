import { expect, test } from "bun:test";
import { sameBaseURL, trimModelsDev } from "../src/server/modules/pricing/models-dev.js";
import { isPrivateAddress } from "../src/server/modules/pricing/private-address.js";
import { priceUsage } from "../src/server/modules/pricing/rates.js";

const API = {
  known: { id: "known", name: "Known", api: "https://known.example.test/v1", models: { a: { id: "a", cost: { input: 1, output: 2 } } } },
  fill: {
    id: "fill", name: "Fill", api: "https://fill.example.test/v1",
    models: {
      m1: { id: "m1", cost: { input: 0.5, output: 1, cache_read: 0.05 } },
      zero: { id: "zero", cost: { input: 0, output: 0 } },
      half: { id: "half", cost: { input: 1 } }
    }
  },
  "fill-coding-plan": { id: "fill-coding-plan", name: "Fill plan", api: "https://plan.example.test/v1", models: { p: { id: "p", cost: { input: 1, output: 2 } } } },
  "all-free": { id: "all-free", name: "All free", api: "https://free.example.test/v1", models: { f: { id: "f", cost: { input: 0, output: 0 } } } },
  local: { id: "local", name: "Local", api: "http://127.0.0.1:1234/v1", models: { l: { id: "l", cost: { input: 1, output: 1 } } } },
  noapi: { id: "noapi", name: "No api", models: { n: { id: "n", cost: { input: 1, output: 1 } } } }
};

const usage = (input: number, extra: { cacheRead?: number; cacheWrite?: number } = {}) =>
  ({ input, output: 0, cacheRead: extra.cacheRead ?? 0, cacheWrite: extra.cacheWrite ?? 0, cacheWrite1h: 0 });

test("trim keeps priced models as rates, drops $0 and half-priced ones, private and address-less providers, and lists plans apart", () => {
  const t = trimModelsDev(API, "2026-10-22");
  expect(t.date).toBe("2026-10-22");
  expect(t.providers.map((p) => p.id)).toEqual(["known", "fill"]);
  expect(t.providers[1]!.models).toEqual([{ id: "m1", rates: { base: { input: 0.5, output: 1, cacheRead: 0.05 } } }]);
  expect(t.plans).toEqual([
    { id: "fill-coding-plan", api: "https://plan.example.test/v1" },
    { id: "all-free", api: "https://free.example.test/v1" }
  ]);
  expect(trimModelsDev("not a catalog", "2026-10-22")).toEqual({ date: "2026-10-22", providers: [], plans: [] });
});

test("a context tier and context_over_200k are the long-context tier", () => {
  const t = trimModelsDev({
    tiered: {
      id: "tiered", name: "Tiered", api: "https://tiered.example.test/v1",
      models: {
        t: { id: "t", cost: { input: 1, output: 2, cache_read: 0.1, tiers: [{ input: 2, output: 4, cache_read: 0.2, tier: { type: "context", size: 256_000 } }] } },
        o: { id: "o", cost: { input: 1, output: 2, context_over_200k: { input: 2, output: 4 } } },
        w: { id: "w", cost: { input: 1, output: 2, tiers: [{ cache_write: 2.5, tier: { type: "context", size: 256_000 } }] } }
      }
    }
  }, "2026-10-22");
  const [t1, o, w] = t.providers[0]!.models;
  expect(t1!.rates).toEqual({ base: { input: 1, output: 2, cacheRead: 0.1 }, tiers: [{ above: 256_000, rates: { input: 2, output: 4, cacheRead: 0.2 } }] });
  expect(priceUsage(t1!.rates, usage(300_000), null)!.usd).toBeCloseTo(0.6, 12);
  expect(o!.rates).toEqual({ base: { input: 1, output: 2 }, tiers: [{ above: 200_000, rates: { input: 2, output: 4 } }] });
  // A cache price given only above a tier: below it, cache writes count at the input price.
  expect(priceUsage(w!.rates, usage(300_000, { cacheWrite: 300_000 }), null)!.usd).toBeCloseTo(0.75, 12);
  expect(priceUsage(w!.rates, usage(100_000, { cacheWrite: 100_000 }), null)!.usd).toBeCloseTo(0.1, 12);
});

test("a plan on a host whose pay-per-use API is listed too is still listed as a plan", () => {
  const api = {
    "known-coding-plan": { id: "known-coding-plan", name: "Known plan", api: "https://known.example.test/api/coding/v4", models: { a: { id: "a", cost: { input: 0, output: 0 } } } },
    known: { id: "known", name: "Known", api: "https://known.example.test/v1", models: { a: { id: "a", cost: { input: 1, output: 2 } } } }
  };
  const t = trimModelsDev(api, "2026-10-22");
  expect(t.plans).toEqual([{ id: "known-coding-plan", api: "https://known.example.test/api/coding/v4" }]);
  expect(t.providers.map((p) => p.id)).toEqual(["known"]);
});

test("a plan that shares its address with a pay-per-use provider is not a plan: the address cannot tell them apart", () => {
  const api = {
    "shared-coding-plan": { id: "shared-coding-plan", name: "Shared plan", api: "https://shared.example.test/anthropic/v1", models: { a: { id: "a", cost: { input: 0, output: 0 } } } },
    shared: { id: "shared", name: "Shared", api: "https://shared.example.test/anthropic", models: { a: { id: "a", cost: { input: 1, output: 2 } } } },
    "own-coding-plan": { id: "own-coding-plan", name: "Own plan", api: "https://own.example.test/coding/v4", models: { a: { id: "a", cost: { input: 0, output: 0 } } } },
    own: { id: "own", name: "Own", api: "https://own.example.test/paas/v4", models: { a: { id: "a", cost: { input: 1, output: 2 } } } }
  };
  const t = trimModelsDev(api, "2026-10-22");
  expect(t.plans).toEqual([{ id: "own-coding-plan", api: "https://own.example.test/coding/v4" }]);
  expect(t.providers.map((p) => p.id)).toEqual(["shared", "own"]);
});

test("a provider without a base URL takes its AI SDK package's default", () => {
  const t = trimModelsDev({
    deep: { id: "deepinfra", name: "DeepInfra", npm: "@ai-sdk/deepinfra", models: { d: { id: "d", cost: { input: 1, output: 2 } } } },
    other: { id: "other", name: "Other", npm: "some-unknown-package", models: { o: { id: "o", cost: { input: 1, output: 2 } } } }
  }, "2026-10-22");
  expect(t.providers.map((p) => [p.id, p.api])).toEqual([["deepinfra", "https://api.deepinfra.com/v1/openai"]]);
});

test("sameBaseURL ignores a trailing slash and a trailing /v1", () => {
  expect(sameBaseURL("https://x.example.test/v1/", "https://x.example.test")).toBe(true);
  expect(sameBaseURL("HTTPS://X.example.test/v1", "https://x.example.test/v1")).toBe(true);
  expect(sameBaseURL("https://x.example.test/api", "https://x.example.test/v1")).toBe(false);
  expect(sameBaseURL("https://x.example.test", "https://y.example.test")).toBe(false);
});

test("a package name that is not a mapping of its own gives no base URL", () => {
  const t = trimModelsDev({
    a: { id: "a", name: "A", npm: "__proto__", models: { m: { id: "m", cost: { input: 1, output: 2 } } } },
    b: { id: "b", name: "B", npm: "constructor", models: { m: { id: "m", cost: { input: 1, output: 2 } } } }
  }, "2026-10-22");
  expect(t.providers).toEqual([]);
});

test("private addresses: loopback, private ranges and localhost names", () => {
  for (const url of ["http://127.0.0.1:1234/v1", "http://localhost:8080", "http://api.localhost/v1", "http://10.1.2.3", "http://172.20.0.5", "http://192.168.1.9", "http://169.254.1.1", "http://[::1]:11434", "http://[fd00::1]/v1", "http://localhost.:8000/v1", "http://api.localhost.:8000", "http://0.0.0.0:1234/v1", "http://[::]:1234/v1"]) {
    expect(isPrivateAddress(url)).toBe(true);
  }
  for (const url of ["https://api.example.test/v1", "https://8.8.8.8", "not a url", "https://100.128.0.1/v1", "https://local.example.test/v1"]) {
    expect(isPrivateAddress(url)).toBe(false);
  }
});

test("private addresses: names only a local network resolves, and the shared address range", () => {
  for (const url of [
    "http://MacBook.local:1234/v1", "http://gpu-box.lan:11434", "http://ollama.internal/v1", "http://nas.home.arpa:8000",
    "https://box.tail1234.ts.net/v1", "http://gpu-box:11434/v1", "http://100.64.0.1:11434", "http://100.127.255.254/v1", "http://ollama.local./v1"
  ]) {
    expect([url, isPrivateAddress(url)]).toEqual([url, true]);
  }
});

