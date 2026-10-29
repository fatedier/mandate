import { expect, test } from "bun:test";
import { act } from "react";
import { useLocation, useNavigate, type NavigateFunction } from "react-router";
import type { PriceMatchDto, PriceMatchResponse, ProviderPricingResponse } from "@shared/api/pricing";
import { api } from "@/lib/api-paths";
import { EditModelDialog } from "@/routes/settings/EditModelDialog";
import { ProvidersPane } from "@/routes/settings/ProvidersPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import { BillingRow, PricesSectionView } from "@/routes/settings/PriceField";
import { BILLING_OPTIONS } from "@/routes/settings/price-text";
import { buildProvidersPatch, providerFormsFromConfig, type ModelForm } from "@/routes/settings/provider-form";
import { searchSettings } from "@/routes/settings/settings-search";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mount, mountAsync, settleRounds } from "../helpers/mount.js";

const MODEL: ModelForm = { id: "row-1", modelId: "openai/gpt-6.1-sol", input: ["text"], supportsReasoning: true, protocol: "responses", kind: "chat" };
const SUGGESTED: PriceMatchDto = { ref: "litellm:gpt-6.1-sol", label: "OpenAI gpt-6.1-sol", origin: "litellm", rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: null }, dataDate: "2026-10-15" };
const OPUS: PriceMatchDto = { ref: "litellm:claude-opus-5-5", label: "Anthropic claude-opus-5-5", origin: "litellm", rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }, dataDate: "2026-10-21" };

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const has = (text: string) => dialog().textContent?.includes(text) ?? false;
const button = (text: string) => Array.from(dialog().querySelectorAll("button")).find((el) => el.textContent?.trim() === text)!;
const radio = (text: string) => Array.from(dialog().querySelectorAll<HTMLButtonElement>('[aria-label="Price"] [role="radio"]')).find((el) => el.textContent?.trim() === text)!;
const input = (label: string) => dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const click = (el: HTMLElement) => act(() => el.click());
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};

function routes(match: PriceMatchResponse, search: PriceMatchDto[] = []) {
  return mockFetch((call) => {
    if (call.url.includes("/api/pricing/match")) return jsonResponse(match);
    if (call.url.includes("/api/pricing/catalog")) return jsonResponse({ results: search });
    return jsonResponse({}, 404);
  });
}

let saved: ModelForm[] = [];
async function renderDialog(model: ModelForm = MODEL) {
  saved = [];
  await mountAsync(
    <EditModelDialog open model={model} providerType="openai-compatible" providerName="gw" declared={undefined} locked={false}
      onCancel={() => {}} onSave={async (next) => { saved.push(next); }} />
  );
  await flush();
}

test("Price offers Automatic, Price as… and Your price; Automatic shows what it finds", async () => {
  routes({ found: OPUS, suggestion: null });
  await renderDialog({ ...MODEL, modelId: "claude-opus-5-5" });
  expect([radio("Automatic"), radio("Price as…"), radio("Your price")].map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  expect(has("Anthropic claude-opus-5-5 · $4.00 in · $20.00 out · $0.20 cached per 1M · prices as of Oct 21")).toBe(true);
});

test("nothing found: No price found, and a suggestion taken with Use its price", async () => {
  routes({ found: null, suggestion: SUGGESTED });
  await renderDialog();
  expect(has("No price found.")).toBe(true);
  expect(has("Looks like OpenAI gpt-6.1-sol.")).toBe(true);
  click(button("Use its price"));
  click(button("Save"));
  expect(saved.map((m) => m.price)).toStrictEqual([{ as: "litellm:gpt-6.1-sol" }]);
});

test("Your price saves the rates typed, and a negative one cannot be saved", async () => {
  routes({ found: null, suggestion: null });
  await renderDialog();
  click(radio("Your price"));
  expect(has("Applies to every call of this model, past and future.")).toBe(true);
  expect(has("USD per 1M tokens")).toBe(true);
  for (const label of ["Input", "Output", "Cache read", "Cache write", "1-hour cache write"]) expect(input(label) !== null).toBe(true);
  await type(input("Input"), "-1");
  await type(input("Output"), "15");
  expect(button("Save").disabled).toBe(true);
  await type(input("Input"), "3");
  click(button("Save"));
  expect(saved.map((m) => m.price)).toStrictEqual([{ input: 3, output: 15 }]);
});

test("a price of its own typed wrong cannot be saved, rather than saved as Automatic", async () => {
  routes({ found: null, suggestion: null });
  await renderDialog({ ...MODEL, price: { input: 1, output: 1 } });
  await type(input("Input"), "-1");
  expect(button("Save").disabled).toBe(true);
});

test("Price as… searches the price lists and saves the model chosen", async () => {
  routes({ found: null, suggestion: null }, [OPUS]);
  await renderDialog();
  click(radio("Price as…"));
  expect(button("Save").disabled).toBe(true);
  await type(input("Search price lists"), "opus");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  await flush();
  click(button("Anthropic claude-opus-5-5"));
  click(button("Save"));
  expect(saved.map((m) => m.price)).toStrictEqual([{ as: "litellm:claude-opus-5-5" }]);
});

test("Automatic again clears the price", async () => {
  routes({ found: null, suggestion: null });
  await renderDialog({ ...MODEL, price: { input: 1, output: 1 } });
  expect(radio("Your price").getAttribute("aria-checked")).toBe("true");
  click(radio("Automatic"));
  click(button("Save"));
  expect(saved.map((m) => m.price)).toStrictEqual([undefined]);
});

test("Billing: three choices with their help; the plan suggestion sets it", () => {
  const changes: string[] = [];
  const { host, rerender } = mount(<BillingRow billing="usage" planSuggested={false} onChange={(b) => changes.push(b)} />);
  expect(host.textContent).toContain("Billing");
  expect(host.textContent).toContain("How this provider charges you. Calls on a plan show as Included; free calls are not counted as spend.");
  expect(BILLING_OPTIONS.map((o) => o.label)).toEqual(["Pay per use", "Subscription or plan", "Free"]);
  expect(host.textContent).toContain("Pay per use");
  expect(host.textContent?.includes("This address looks like a plan.")).toBe(false);
  rerender(<BillingRow billing="usage" planSuggested onChange={(b) => changes.push(b)} />);
  expect(host.textContent).toContain("This address looks like a plan.");
  const set = [...host.querySelectorAll("button")].find((b) => b.textContent === "Set to Subscription or plan")!;
  act(() => set.click());
  expect(changes).toStrictEqual(["plan"]);
  rerender(<BillingRow billing="plan" planSuggested onChange={(b) => changes.push(b)} />);
  expect(host.textContent?.includes("This address looks like a plan.")).toBe(false);
});

test("a connection's billing is in its form and its save", () => {
  const config = {
    models: { providers: {
      codex: { type: "codex", baseURL: "https://chatgpt.com/backend-api/codex", billing: "plan", models: [], apiKeyConfigured: false },
      gw: { type: "openai-compatible", baseURL: "https://gw.example.test/v1", billing: "usage", models: [], apiKeyConfigured: true }
    } }
  } as unknown as SettingsConfigResponse;
  const cards = providerFormsFromConfig(config).map((form) => ({ form, baseline: { ...form } }));
  expect(cards.map((c) => c.form.billing)).toEqual(["plan", "usage"]);
  const gw = cards[1]!;
  gw.form = { ...gw.form, billing: "free" };
  expect(buildProvidersPatch(cards, { savedId: gw.form.id }).models!.providers!.gw!.billing).toBe("free");
});

test("Prices: the switch and the data's date", () => {
  const changes: boolean[] = [];
  const { host } = mount(<PricesSectionView autoUpdate status={{ autoUpdate: true, litellmDate: "2026-10-15", modelsDevDate: "2026-10-21" }} onAutoUpdate={(on) => changes.push(on)} />);
  expect(host.textContent).toContain("Prices");
  expect(host.textContent).toContain("Update prices automatically");
  expect(host.textContent).toContain("Price data from Oct 21 (LiteLLM, models.dev)");
  act(() => host.querySelector<HTMLElement>('[role="switch"]')!.click());
  expect(changes).toStrictEqual([false]);
});

test("Prices: the data's date names the lists in use, and says when there is none yet", () => {
  const line = (litellmDate: string | null, modelsDevDate: string | null) =>
    mount(<PricesSectionView autoUpdate status={{ autoUpdate: true, litellmDate, modelsDevDate }} onAutoUpdate={() => {}} />).host.textContent ?? "";
  expect(line("2026-10-15", null)).toContain("Price data from Oct 15 (LiteLLM)");
  expect(line(null, "2026-10-21")).toContain("Price data from Oct 21 (models.dev)");
  expect(line(null, null)).toContain("No price data yet");
  const loading = mount(<PricesSectionView autoUpdate status={null} onAutoUpdate={() => {}} />).host.textContent ?? "";
  expect(loading.includes("Price data") || loading.includes("No price data")).toBe(false);
});

test("settings search finds billing, a model's price and price updates", () => {
  expect(searchSettings("billing").map((r) => r.label)).toContain("Billing");
  expect(searchSettings("price").map((r) => r.label)).toEqual(expect.arrayContaining(["Price", "Update prices automatically"]));
});

// ---- the Providers pane: Billing, the Models section, Prices ----

const AGENT = { modelOverrides: { manager: false, worker: false, global: false }, managerModel: { model: "" }, managerModelFallbacks: [], workerModel: { model: "" }, workerModelFallbacks: [], globalModel: { model: "" }, globalModelFallbacks: [] };
const CONFIG = {
  ok: true,
  restartRequired: false,
  models: {
    default: { model: "", reasoningEffort: "provider-default", modelFallbacks: [] },
    prices: { autoUpdate: true },
    providers: {
      gw: { type: "openai-compatible", baseURL: "https://gw.example.test/v1", billing: "usage", apiKeyConfigured: true, models: [{ id: "openai/gpt-6.1-sol", input: ["text"] }, { id: "other", input: ["text"] }] },
      gw2: { type: "openai-compatible", baseURL: "https://gw2.example.test/v1", billing: "usage", apiKeyConfigured: true, models: [{ id: "second", input: ["text"] }] }
    }
  },
  memory: { embedding: { model: "" } },
  agent: AGENT
} as unknown as SettingsConfigResponse;

let search = "";
let navigate: NavigateFunction = () => {};
function Where() {
  search = useLocation().search;
  navigate = useNavigate();
  return null;
}
const go = async (to: string) => { await act(async () => { await navigate(to); }); await settleRounds(); };
const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];

async function renderPane(path: string, pricing: ProviderPricingResponse = { planSuggested: false, models: {} }, config = CONFIG) {
  const posts: unknown[] = [];
  // A save answers with the providers as saved, as the server does.
  let current = config as unknown as { models: { providers: Record<string, Record<string, unknown>> } };
  mockFetch((call) => {
    if (call.url === api.settingsConfig) {
      if ((call.init?.method ?? "GET") !== "GET") {
        const body = JSON.parse(String(call.init!.body)) as { models?: { providers?: Record<string, Record<string, unknown>> } };
        posts.push(body);
        const saved = body.models?.providers ?? {};
        current = { ...current, models: { ...current.models, providers: Object.fromEntries(Object.entries(saved).map(([name, entry]) => [name, { ...current.models.providers[name], ...entry }])) } };
      }
      return jsonResponse(current);
    }
    if (call.url.startsWith(api.pricingProvider("gw"))) return jsonResponse(pricing);
    if (call.url.startsWith(api.pricingStatus)) return jsonResponse({ autoUpdate: true, litellmDate: "2026-10-15", modelsDevDate: "2026-10-21" });
    if (call.url.includes("/api/pricing/match")) return jsonResponse({ found: null, suggestion: null });
    return jsonResponse({ ok: true, providerName: "gw", providerType: "openai-compatible", source: "configured", cached: false, models: [] });
  });
  const view = mount(<><SettingsConfigProvider><ProvidersPane /></SettingsConfigProvider><Where /></>, { path });
  await settleRounds();
  return { ...view, posts };
}

test("a link naming a model opens its dialog, and the link drops the model", async () => {
  await renderPane("/settings?tab=providers&provider=gw&model=openai%2Fgpt-6.1-sol");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("openai/gpt-6.1-sol");
  expect(new URLSearchParams(search).get("model")).toBeNull();
  expect(new URLSearchParams(search).get("provider")).toBe("gw");
});

test("a model Automatic finds no price for offers its suggestion on its row, and taking it saves Price as", async () => {
  const { host, posts } = await renderPane("/settings?tab=providers&provider=gw", {
    planSuggested: false,
    models: { "openai/gpt-6.1-sol": { found: null, suggestion: SUGGESTED }, other: { found: null, suggestion: null } }
  });
  const lines = host.querySelectorAll("[data-price-suggestion]");
  expect(lines.length).toBe(1);
  expect(lines[0]!.textContent).toContain("Looks like OpenAI gpt-6.1-sol.");
  await act(async () => { [...lines[0]!.querySelectorAll("button")].find((b) => b.textContent === "Use its price")!.click(); });
  await settleRounds();
  const saved = (posts.at(-1) as { models: { providers: Record<string, { models: Array<{ id: string; price?: unknown }> }> } }).models.providers.gw!.models;
  expect(saved.map((m) => m.price ?? null)).toEqual([{ as: "litellm:gpt-6.1-sol" }, null]);
});

test("the Prices section ends the providers list", async () => {
  const { host } = await renderPane("/settings?tab=providers");
  const titles = [...host.querySelectorAll("h2, h3")].map((n) => n.textContent?.trim());
  expect(titles.at(-1)).toBe("Prices");
  expect(host.textContent).toContain("Price data from Oct 21 (LiteLLM, models.dev)");
});

test("a link naming a model its connection no longer has opens Add models with that id picked; added, its dialog opens", async () => {
  const { posts } = await renderPane("/settings?tab=providers&provider=gw&model=acme-gone");
  const add = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(add().textContent).toContain("Add models");
  expect(add().textContent).toContain("acme-gone");
  expect(new URLSearchParams(search).get("model")).toBeNull();
  const confirm = [...add().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add 1 model")!;
  await act(async () => { confirm.click(); });
  await settleRounds();
  const saved = (posts.at(-1) as { models: { providers: Record<string, { models: Array<{ id: string }> }> } }).models.providers.gw!.models;
  expect(saved.map((m) => m.id)).toContain("acme-gone");
  expect(document.querySelector('[role="dialog"] [aria-label="Price"]') !== null).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("acme-gone");
});

test("Add models opened by a link and cancelled adds nothing, opens nothing, and opens empty next time", async () => {
  const { host, posts } = await renderPane("/settings?tab=providers&provider=gw&model=acme-gone");
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  await act(async () => { [...dialog()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancel")!.click(); });
  await settleRounds();
  expect(dialog() === null).toBe(true);
  expect(posts).toStrictEqual([]);
  await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add models")!.click(); });
  await settleRounds();
  expect(dialog()!.textContent?.includes("acme-gone")).toBe(false);
});

test("a model link whose provider is not saved is forgotten with it", async () => {
  await renderPane("/settings?tab=providers&provider=nobody&model=openai%2Fgpt-6.1-sol");
  expect(new URLSearchParams(search).get("model")).toBeNull();
  await renderPane("/settings?tab=providers&model=openai%2Fgpt-6.1-sol");
  expect(new URLSearchParams(search).get("model")).toBeNull();
  expect(document.querySelector('[role="dialog"]') === null).toBe(true);
});

test("taking the plan suggestion is saved with the connection", async () => {
  const { host, posts } = await renderPane("/settings?tab=providers&provider=gw", { planSuggested: true, models: {} });
  await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent === "Set to Subscription or plan")!.click(); });
  const bar = host.querySelector<HTMLElement>('[data-slot="provider-save-bar"]')!;
  await act(async () => { [...bar.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save")!.click(); });
  await settleRounds();
  expect((posts.at(-1) as { models: { providers: Record<string, { billing?: string }> } }).models.providers.gw!.billing).toBe("plan");
});

test("a model with a price of its own shows no suggestion, whatever Automatic finds", async () => {
  const priced = structuredClone(CONFIG) as unknown as { models: { providers: { gw: { models: Array<Record<string, unknown>> } } } };
  priced.models.providers.gw.models[0]!.price = { input: 1, output: 1 };
  const { host } = await renderPane("/settings?tab=providers&provider=gw", {
    planSuggested: false,
    models: { "openai/gpt-6.1-sol": { found: null, suggestion: SUGGESTED } }
  }, priced as unknown as SettingsConfigResponse);
  expect(host.querySelector("[data-model-row]") !== null).toBe(true);
  expect(host.querySelectorAll("[data-price-suggestion]").length).toBe(0);
});

test("Add models opened by a link does not follow the page to another provider", async () => {
  const { posts } = await renderPane("/settings?tab=providers&provider=gw&model=acme-gone");
  expect(dialogs().map((d) => d.textContent?.includes("acme-gone"))).toEqual([true]);
  await go("/settings?tab=providers&provider=gw2");
  // A count, not the elements: a failing compare of DOM nodes never finishes printing.
  expect(dialogs().length).toBe(0);
  expect(posts).toStrictEqual([]);
});

test("a second link while Add models is open picks the model it names, not the first one", async () => {
  const { posts } = await renderPane("/settings?tab=providers&provider=gw&model=acme-gone");
  await go("/settings?tab=providers&provider=gw&model=acme-new");
  const [add] = dialogs();
  expect(add!.textContent).toContain("acme-new");
  expect(add!.textContent?.includes("acme-gone")).toBe(false);
  await act(async () => { [...add!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Add 1 model")!.click(); });
  await settleRounds();
  const saved = (posts.at(-1) as { models: { providers: Record<string, { models: Array<{ id: string }> }> } }).models.providers.gw!.models.map((m) => m.id);
  expect(saved).toContain("acme-new");
  expect(saved.includes("acme-gone")).toBe(false);
});

test("a new link closes the dialog the last one opened: one dialog at a time", async () => {
  await renderPane("/settings?tab=providers&provider=gw&model=other");
  expect(dialogs().length).toBe(1);
  await go("/settings?tab=providers&provider=gw&model=acme-gone");
  expect(dialogs().length).toBe(1);
  expect(dialogs()[0]!.textContent).toContain("Add models");
  await go("/settings?tab=providers&provider=gw&model=other");
  expect(dialogs().length).toBe(1);
  expect(dialogs()[0]!.querySelector('[aria-label="Price"]') !== null).toBe(true);
});
