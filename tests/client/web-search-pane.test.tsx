import { expect, test } from "bun:test";
import { act, useState } from "react";
import { api } from "@/lib/api-paths";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse, WebSearchKindSettings, WebSearchSettingsConfig } from "@/routes/settings/types";
import { WebSearchPane } from "@/routes/settings/WebSearchPane";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

// The page knows no kind: it draws whatever the server lists, field by field.
const MODEL: WebSearchKindSettings = {
  id: "model", label: "Model search", description: "A model's built-in search, through its provider.", setUp: false,
  fields: [
    { key: "model", type: "model", label: "Model", description: "Only models on the Responses or Messages API can search.", required: true, value: "", options: [{ value: "p/m1", label: "p/m1 · Responses" }] },
    { key: "effort", type: "choice", label: "Reasoning effort", required: false, value: "low", options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] }
  ]
};
const TAVILY = (configured: boolean): WebSearchKindSettings => ({
  id: "tavily", label: "Tavily", description: "Tavily's search API.", setUp: configured,
  fields: [{ key: "apiKey", type: "secret", label: "API key", required: true, value: "", configured }]
});
const SEARXNG: WebSearchKindSettings = {
  id: "searxng", label: "SearXNG", description: "Your own instance. Its JSON output must be turned on.", setUp: false,
  fields: [{ key: "address", type: "url", label: "Address", required: true, value: "", placeholder: "https://search.example.com" }]
};
const PROBE: WebSearchKindSettings = {
  id: "probe", label: "Probe", description: "A test kind.", setUp: false,
  fields: [
    { key: "m", type: "model", label: "M", required: true, value: "", options: [{ value: "p/m1", label: "p/m1" }] },
    { key: "p", type: "provider", label: "P", required: false, value: "", options: [{ value: "openai-p", label: "openai-p" }] },
    { key: "s", type: "secret", label: "S", required: true, value: "", configured: false },
    { key: "u", type: "url", label: "U", required: false, value: "", placeholder: "https://u.example" },
    { key: "c", type: "choice", label: "C", required: false, value: "y", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] }
  ]
};

const configWith = (webSearch: WebSearchSettingsConfig) => ({ ok: true, restartRequired: false, models: { providers: {} }, webSearch }) as unknown as SettingsConfigResponse;

async function pane(start: WebSearchSettingsConfig, opts: {
  check?: (call: FetchCall) => Response;
  saved?: (body: { webSearch: WebSearchSettingsConfig }) => WebSearchSettingsConfig;
  /** A save is answered only once this settles. */
  hold?: Promise<void>;
} = {}) {
  let current = start;
  const saves: unknown[] = [];
  const checks: FetchCall[] = [];
  mockFetch((call) => {
    if (call.url === api.settingsWebSearchCheck) {
      checks.push(call);
      return opts.check ? opts.check(call) : jsonResponse({ ok: true, result: "works", count: 7, ms: 9_840 });
    }
    if (call.method === "POST") {
      const body = JSON.parse(String(call.init!.body));
      saves.push(body);
      current = opts.saved ? opts.saved(body) : current;
      if (opts.hold) return opts.hold.then(() => jsonResponse(configWith(current)));
    }
    return jsonResponse(configWith(current));
  });
  // The page mounts the pane again when Settings search opens and closes; the
  // provider, and any save it has on its way, stays.
  let remount = () => {};
  function Pane() {
    const [key, setKey] = useState(0);
    remount = () => setKey((k) => k + 1);
    return <WebSearchPane key={key} />;
  }
  const { host } = await mountAsync(<SettingsConfigProvider><Pane /></SettingsConfigProvider>);
  await settle();
  const rows = () => [...host.querySelectorAll('[data-slot="setting-row"] [data-slot="setting-label"]')].map((el) => el.textContent);
  const row = (label: string) => [...host.querySelectorAll<HTMLElement>('[data-slot="setting-row"]')].find((r) => r.querySelector('[data-slot="setting-label"]')?.textContent === label)!;
  const choose = async (rowLabel: string, optionLabel: string) => {
    const trigger = row(rowLabel).querySelector<HTMLElement>('[data-slot="select-trigger"]')!;
    await act(async () => { trigger.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === optionLabel)!;
    await act(async () => { option.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" })); option.click(); });
    await settle();
  };
  const type = async (rowLabel: string, value: string) => {
    const input = row(rowLabel).querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const press = async (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;
    await act(async () => { button.click(); });
    await settle(20);
  };
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) ?? null;
  const chip = () => host.querySelector('[data-slot="section-header"]')?.textContent ?? "";
  const description = (rowLabel: string) => row(rowLabel).querySelector('[data-slot="setting-description"]')?.textContent ?? "";
  const again = async () => { await act(async () => { remount(); }); await settle(); };
  return { host, rows, row, choose, type, press, button, chip, description, saves, checks, again };
}

const KINDS = (tavilyConfigured = false) => [MODEL, TAVILY(tavilyConfigured), SEARXNG, PROBE];

test("Off shows only the choice, says agents have no web search, and the chip says Off", async () => {
  const p = await pane({ use: "off", kinds: KINDS() });
  expect(p.rows()).toEqual(["Search with"]);
  expect(p.description("Search with")).toBe("Agents have no web search.");
  expect(p.chip()).toContain("Web search");
  expect(p.chip()).toContain("Lets every agent search the web with the backend you choose.");
  expect(p.chip()).toContain("Off");
});

test("each kind draws its own fields, then the check", async () => {
  const p = await pane({ use: "off", kinds: KINDS() });
  await p.choose("Search with", "Model search");
  expect(p.rows()).toEqual(["Search with", "Model", "Reasoning effort", "Check"]);
  expect(p.description("Search with")).toBe("A model's built-in search, through its provider.");
  expect(p.description("Model")).toBe("Only models on the Responses or Messages API can search.");
  expect(p.description("Check")).toBe("Runs one real search.");
  await p.choose("Search with", "Tavily");
  expect(p.rows()).toEqual(["Search with", "API key", "Check"]);
  await p.choose("Search with", "SearXNG");
  expect(p.rows()).toEqual(["Search with", "Address", "Check"]);
  expect(p.row("Address").querySelector("input")!.getAttribute("placeholder")).toBe("https://search.example.com");
  await p.choose("Search with", "Probe");
  expect(p.rows()).toEqual(["Search with", "M", "P", "S", "U", "C", "Check"]);
  expect(["M", "P", "C"].map((label) => Boolean(p.row(label).querySelector('[data-slot="select-trigger"]')))).toEqual([true, true, true]);
  expect(p.row("S").querySelector<HTMLInputElement>("input")!.type).toBe("password");
  expect(p.row("S").querySelector<HTMLInputElement>("input")!.getAttribute("aria-label")).toBe("S");
});

test("going back to a kind keeps what was typed for it", async () => {
  const p = await pane({ use: "off", kinds: KINDS() });
  await p.choose("Search with", "SearXNG");
  await p.type("Address", "https://s.test");
  await p.choose("Search with", "Tavily");
  await p.choose("Search with", "SearXNG");
  expect(p.row("Address").querySelector("input")!.value).toBe("https://s.test");
});

test("saving sends the choice and the kind's values; a key only when typed, null when removed", async () => {
  const p = await pane({ use: "off", kinds: KINDS() });
  await p.choose("Search with", "Probe");
  await p.choose("M", "p/m1");
  await p.choose("P", "openai-p");
  await p.type("S", "new-secret");
  await p.type("U", "https://u.test");
  await p.choose("C", "X");
  await p.press("Save");
  expect(p.saves).toStrictEqual([{ webSearch: { use: "probe", kinds: { probe: { m: "p/m1", p: "openai-p", s: "new-secret", u: "https://u.test", c: "x" } } } }]);
  const q = await pane({ use: "tavily", kinds: KINDS(true) });
  await q.press("Remove");
  await q.press("Save");
  expect(q.saves).toStrictEqual([{ webSearch: { use: "tavily", kinds: { tavily: { apiKey: null } } } }]);
});

test("the check waits for a save, then says how many results and how long", async () => {
  const p = await pane({ use: "off", kinds: KINDS() }, { saved: (body) => ({ use: body.webSearch.use, kinds: KINDS(true) }) });
  await p.choose("Search with", "Tavily");
  expect([p.button("Save to check")?.disabled, p.checks.length]).toEqual([true, 0]);
  await p.type("API key", "tvly-key");
  await p.press("Save");
  expect(p.button("Check search")?.disabled).toBe(false);
  await p.press("Check search");
  expect(p.checks).toHaveLength(1);
  expect(p.row("Check").textContent).toContain("Search works: 7 results in 9.8 s");
  const failing = await pane({ use: "tavily", kinds: KINDS(true) }, { check: () => jsonResponse({ ok: true, result: "failed", message: "401 Unauthorized" }) });
  await failing.press("Check search");
  expect(failing.row("Check").textContent).toContain("Search failed: 401 Unauthorized");
});

// The check is the user's look at the search: under its line, the answer and
// the first pages it found, or what a model said instead of searching.
test("under the check's line: the answer and the first pages, or what the model said instead of searching", async () => {
  const works = await pane({ use: "tavily", kinds: KINDS(true) }, { check: () => jsonResponse({
    ok: true, result: "works", count: 10, ms: 3_200, answer: "The latest stable version of Python is 3.15.0.",
    top: [{ title: "Python Release Python 3.15.0", url: "https://www.python.org/downloads/release/python-3150/" }, { title: "", url: "https://docs.python.org/3/whatsnew/3.15.html" }]
  }) });
  await works.press("Check search");
  expect(works.row("Check").querySelector('[data-slot="web-search-check-result"]')!.textContent).toBe("Search works: 10 results in 3.2 s");
  const found = works.row("Check").querySelector('[data-slot="web-search-check-found"]')!;
  expect(found.querySelector('[data-slot="web-search-check-answer"]')!.textContent).toBe("The latest stable version of Python is 3.15.0.");
  // A page by its title and its site; one with no title by its address.
  expect([...found.querySelectorAll('[data-slot="web-search-check-page"]')].map((page) => page.textContent)).toEqual([
    "Python Release Python 3.15.0 — www.python.org", "docs.python.org/3/whatsnew/3.15.html"
  ]);
  const unsearched = await pane({ use: "tavily", kinds: KINDS(true) }, { check: () => jsonResponse({
    ok: true, result: "failed", message: "the model answered without searching", reply: "I don't have live web-search access in this chat."
  }) });
  await unsearched.press("Check search");
  expect(unsearched.row("Check").querySelector('[data-slot="web-search-check-result"]')!.textContent).toBe("Search failed: the model answered without searching");
  expect(unsearched.row("Check").querySelector('[data-slot="web-search-check-reply"]')!.textContent).toBe("\u201cI don't have live web-search access in this chat.\u201d");
  // An answer that named no pages reads as that, not as no results.
  const answerOnly = await pane({ use: "tavily", kinds: KINDS(true) }, { check: () => jsonResponse({ ok: true, result: "works", count: 0, ms: 4_500, answer: "Python 3.15.0.", top: [] }) });
  await answerOnly.press("Check search");
  expect(answerOnly.row("Check").querySelector('[data-slot="web-search-check-result"]')!.textContent).toBe("Search works: answer only, in 4.5 s");
  // A failure with no reply has nothing under its line.
  const failing = await pane({ use: "tavily", kinds: KINDS(true) }, { check: () => jsonResponse({ ok: true, result: "failed", message: "401 Unauthorized" }) });
  await failing.press("Check search");
  expect(failing.row("Check").querySelector('[data-slot="web-search-check-found"], [data-slot="web-search-check-reply"]') === null).toBe(true);
});

test("a change waits for its save before it can be checked, and a save drops the last answer", async () => {
  const p = await pane({ use: "tavily", kinds: KINDS(true) }, { saved: () => ({ use: "tavily", kinds: KINDS(true) }) });
  await p.press("Check search");
  expect(p.row("Check").textContent).toContain("Search works: 7 results in 9.8 s");
  await p.press("Replace");
  await p.type("API key", "tvly-other");
  expect(p.button("Save to check")?.disabled).toBe(true);
  expect(p.row("Check").textContent).not.toContain("Search works");
  await p.press("Save");
  expect(p.button("Check search")?.disabled).toBe(false);
  expect(p.row("Check").textContent).not.toContain("Search works");
});

test("the check waits while a save is on its way, even when the form reads as saved", async () => {
  let answer!: () => void;
  const hold = new Promise<void>((resolve) => { answer = resolve; });
  const saved = (address: string): WebSearchKindSettings => ({ ...SEARXNG, setUp: true, fields: [{ ...SEARXNG.fields[0]!, value: address }] });
  const p = await pane({ use: "searxng", kinds: [MODEL, saved("https://a.test")] }, { hold, saved: () => ({ use: "searxng", kinds: [MODEL, saved("https://b.test")] }) });
  await p.type("Address", "https://b.test");
  await p.press("Save");
  await p.type("Address", "https://a.test");
  expect(p.button("Check search")?.disabled).toBe(true);
  // Mounted again while the save is on its way, the pane still waits for it.
  await p.again();
  expect(p.row("Address").querySelector("input")!.value).toBe("https://a.test");
  expect(p.button("Check search")?.disabled).toBe(true);
  await act(async () => { answer(); });
  await settle(20);
  expect(p.row("Address").querySelector("input")!.value).toBe("https://b.test");
  expect(p.button("Check search")?.disabled).toBe(false);
});

test("the check never runs by itself, and a kind not set up cannot be checked", async () => {
  const p = await pane({ use: "tavily", kinds: KINDS(false) });
  expect([p.checks.length, p.button("Check search")?.disabled]).toEqual([0, true]);
});

test("the chip reads the saved setup", async () => {
  expect((await pane({ use: "tavily", kinds: KINDS(false) })).chip()).toContain("Not set up");
  expect((await pane({ use: "tavily", kinds: KINDS(true) })).chip()).toContain("Ready");
  expect((await pane({ use: "retired", kinds: KINDS(true) })).chip()).toContain("Off");
});
