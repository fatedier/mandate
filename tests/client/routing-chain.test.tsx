import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { api } from "@/lib/api-paths";
import { RoutingPane } from "@/routes/settings/RoutingPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import { SETTINGS_SEARCH_INDEX } from "@/routes/settings/settings-search";
import type { SettingsConfigResponse } from "@shared/settings";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { routingPage } from "../helpers/routing-page.js";

// Settings › Routing: each route drawn as the chain it is tried in, a step
// card each, edited in place; a route following the default says what it
// follows. Configuration only. A route that is on saves each change to its
// steps as it is made (a step's × asks first); switching a route of its own
// on or off waits for the route's Save.

const sel = (model: string, reasoningEffort = "provider-default") => ({ model, reasoningEffort });

function config(over: { fallbacks?: ReturnType<typeof sel>[]; models?: Record<string, string[]> } = {}): SettingsConfigResponse {
  const models = over.models ?? {
    "provider-1": ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"],
    kilo: ["anthropic/claude-opus-5.5", "x-ai/grok-4.7"],
    codex: ["gpt-6.1-sol"]
  };
  const types: Record<string, string> = { "provider-1": "openai-compatible", kilo: "kilo", codex: "codex", openai: "openai" };
  const fallbacks = over.fallbacks ?? [sel("kilo/anthropic/claude-opus-5.5", "xhigh"), sel("kilo/x-ai/grok-4.7", "high")];
  const first = over.models ? `${Object.keys(models)[0]}/${Object.values(models)[0]![0]}` : "provider-1/anthropic/claude-opus-5-5";
  return {
    ok: true,
    restartRequired: false,
    models: {
      default: { model: first, reasoningEffort: "xhigh", modelFallbacks: fallbacks },
      providers: Object.fromEntries(Object.entries(models).map(([name, ids]) => [name, { type: types[name] ?? "openai", baseURL: "", apiKeyConfigured: true, models: ids.map((id) => ({ id, input: ["text"] })) }]))
    },
    agent: {
      modelOverrides: { manager: false, worker: true },
      managerModel: sel(first, "xhigh"),
      managerModelFallbacks: fallbacks,
      workerModel: sel("codex/gpt-6.1-sol", "high"),
      workerModelFallbacks: [sel("provider-1/openai/gpt-6.1-sol", "high")],
      personalModel: sel(first, "xhigh"),
      personalModelFallbacks: fallbacks,
      dreamModel: sel(first, "xhigh"),
      dreamModelFallbacks: fallbacks,
      extractionModel: sel(first, "xhigh"),
      extractionModelFallbacks: fallbacks,
      subagentModel: sel(first, "xhigh"),
      subagentModelFallbacks: fallbacks,
      pageModel: sel(first, "xhigh"),
      pageModelFallbacks: fallbacks,
      skillReviewModel: sel(first, "xhigh"),
      skillReviewModelFallbacks: fallbacks,
      decisionsModel: { model: "", reasoningEffort: "provider-default" },
      decisionsModelFallbacks: [],
      toolReviewSecondLookModel: { model: "", reasoningEffort: "provider-default" },
      toolReviewSecondLookModelFallbacks: []
    }
  } as unknown as SettingsConfigResponse;
}

let host: HTMLElement;
let posts: Array<Record<string, any>> = [];
/** Whether the server keeps what it is sent (else it answers with the config as it was). */
let reflect = true;
/** Whether the next saves fail. */
let failing = false;
/** Whether saves wait for `release()` before answering. */
let holding = false;
let held: Array<() => void> = [];
const release = () => act(async () => { held.shift()!(); });

/** The config with a routing patch applied, as the server keeps it. */
function applied(cfg: SettingsConfigResponse, patch: Record<string, any>): SettingsConfigResponse {
  const next = structuredClone(cfg) as any;
  if (patch.models?.default) {
    next.models.default = { ...next.models.default, ...patch.models.default };
    // A route without its own runs the default: the server answers it so.
    for (const route of ["manager", "worker", "personal", "subagent", "page", "dream", "extraction"]) {
      if (next.agent.modelOverrides?.[route]) continue;
      next.agent[`${route}Model`] = { model: next.models.default.model, reasoningEffort: next.models.default.reasoningEffort };
      next.agent[`${route}ModelFallbacks`] = next.models.default.modelFallbacks;
    }
  }
  for (const route of ["manager", "worker", "personal", "subagent", "page", "dream", "extraction"]) {
    if (!patch.agent || !(`${route}Model` in patch.agent)) continue;
    const own = patch.agent[`${route}Model`] !== null;
    next.agent.modelOverrides = { ...next.agent.modelOverrides, [route]: own };
    next.agent[`${route}Model`] = own ? patch.agent[`${route}Model`] : { model: next.models.default.model, reasoningEffort: next.models.default.reasoningEffort };
    next.agent[`${route}ModelFallbacks`] = own ? patch.agent[`${route}ModelFallbacks`] : next.models.default.modelFallbacks;
  }
  return next;
}

async function render(cfg = config()): Promise<void> {
  posts = [];
  reflect = true;
  failing = false;
  holding = false;
  held = [];
  let current = cfg;
  mockFetch((call: FetchCall) => {
    if (call.url === api.settingsConfig && (call.init?.method ?? "GET") !== "GET") {
      const patch = JSON.parse(String(call.init!.body));
      posts.push(patch);
      const answer = failing ? jsonResponse({ ok: false, error: "settings file is read-only" }, 500) : null;
      if (!failing && reflect) current = applied(current, patch);
      const kept = current;
      if (holding) return new Promise<Response>((resolve) => { held.push(() => resolve(answer ?? jsonResponse(kept))); });
      return answer ?? jsonResponse(current);
    }
    return jsonResponse(current);
  });
  host = (await mountAsync(
    <MemoryRouter>
      <SettingsConfigProvider>
        <RoutingPane />
      </SettingsConfigProvider>
    </MemoryRouter>
  )).host;
  await settle();
}

const { lane, cards, titlesOf, editor, button, toggle, openLane, summary, summarySteps } = routingPage(() => host);
const cardText = (route: string) => cards(route).map((card) => card.textContent);
const pointerOpen = (el: HTMLElement) => act(() => {
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
});
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'));
const menuItem = (text: string) => menuItems().find((el) => el.textContent?.includes(text));

async function openCard(route: string, index: number) {
  act(() => cards(route)[index]!.click());
  await settle();
}

const removeButtons = (route: string) => Array.from(lane(route).querySelectorAll<HTMLButtonElement>('[aria-label^="Remove "]'));
const confirmDialog = () => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).find((el) => el.textContent?.includes("Remove step")) ?? null;
/** A step's ×, then the dialog's answer. */
async function removeStep(route: string, index: number, answer: "Remove" | "Cancel" = "Remove") {
  act(() => removeButtons(route)[index]!.click());
  await settle();
  act(() => button(confirmDialog(), answer)!.click());
  await settle();
}
const pickEffort = (name: string) => act(() => Array.from(editor()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === name)!.click());

test("each route is drawn as its chain: first choice, then each fallback, with its provider and effort", async () => {
  await render();
  await openLane("default");
  expect(cardText("default")).toEqual([
    "First choiceAclaude-opus-5-5provider-1 · XHigh",
    "ThenAclaude-opus-5.5kilo · XHigh",
    "ThenXgrok-4.7kilo · High"
  ]);
  expect(cards("default")[0]!.getAttribute("aria-label")).toBe("First choice: provider-1/anthropic/claude-opus-5-5, XHigh");
  expect(lane("default").querySelectorAll('[data-slot="step-arrow"]').length).toBe(2);
  await openLane("worker");
  expect(cardText("worker")).toEqual(["First choiceOgpt-6.1-solcodex · High", "ThenOgpt-6.1-solprovider-1 · High"]);
  // Following the default: one line naming that chain, no cards.
  await openLane("manager");
  expect(cards("manager").length).toBe(0);
  expect(lane("manager").querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default:claude-opus-5-5claude-opus-5.5grok-4.7");
});

test("a card opens its editor: a model picked from the menu takes the step's place and the effort is set, each saved as it is made", async () => {
  await render();
  await openLane("default");
  await openCard("default", 1);
  expect(editor()?.textContent).toContain("Fallback 1");
  pointerOpen(editor()!.querySelector<HTMLElement>('[aria-label="Model"]')!);
  await settle();
  // Grouped under the providers; a model already on the route can't be picked twice.
  expect(Array.from(document.querySelectorAll('[data-slot="model-menu-group"]')).map((g) => g.textContent)).toEqual(["provider-1", "kilo", "codex"]);
  expect(menuItem("x-ai/grok-4.7")!.getAttribute("data-disabled")).not.toBeNull();
  // The step's own model is the checked one, not "in this route".
  expect(menuItems().find((el) => el.getAttribute("data-ref") === "kilo/anthropic/claude-opus-5.5")!.getAttribute("data-disabled")).toBeNull();
  act(() => menuItem("openai/gpt-6.1-sol")!.click());
  await settle();
  expect(posts.map((p) => p.models.default.modelFallbacks[0])).toStrictEqual([sel("provider-1/openai/gpt-6.1-sol", "xhigh")]);
  expect(Array.from(editor()!.querySelectorAll('[aria-label="Reasoning effort"] [role="radio"]')).map((r) => r.textContent)).toEqual(["Default", "None", "Minimal", "Low", "Medium", "High", "XHigh", "Max"]);
  act(() => Array.from(editor()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === "Max")!.click());
  await settle();
  expect(cardText("default")[1]).toBe("ThenOgpt-6.1-solprovider-1 · Max");
  expect(posts.at(-1)!.models.default.modelFallbacks[0]).toEqual(sel("provider-1/openai/gpt-6.1-sol", "max"));
  act(() => Array.from(editor()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === "High")!.click());
  await settle();
  expect(posts.at(-1)!.models.default.modelFallbacks).toEqual([sel("provider-1/openai/gpt-6.1-sol", "high"), sel("kilo/x-ai/grok-4.7", "high")]);
  act(() => button(editor(), "Done")!.click());
  await settle();
  expect(editor() === null).toBe(true);
  expect(cardText("default")[1]).toBe("ThenOgpt-6.1-solprovider-1 · High");
  // Nothing is left to save.
  expect(button(lane("default"), "Save") === undefined).toBe(true);
});

/** The editor's service tier choices, when its step has them. */
const tierRadios = () => Array.from(editor()!.querySelectorAll<HTMLElement>('[aria-label="Service tier"] [role="radio"]'));
const pickTier = (name: string) => act(() => tierRadios().find((r) => r.textContent === name)!.click());
const summaryTiers = (route: string) => Array.from(lane(route).querySelectorAll<HTMLElement>('[data-slot="summary-step"]'))
  .map((step) => step.querySelector('[data-slot="summary-tier"]')?.textContent ?? "");

test("a step whose API has a service tier offers one under its effort; the one chosen is saved and said on the card and in the row", async () => {
  await render();
  await openLane("default");
  await openCard("default", 0);
  expect(tierRadios().map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["Default", "true"], ["Priority", "false"], ["Flex", "false"]]);
  pickTier("Flex");
  await settle();
  expect(posts.at(-1)!.models.default).toMatchObject({ model: "provider-1/anthropic/claude-opus-5-5", reasoningEffort: "xhigh", serviceTier: "flex" });
  expect(cardText("default")[0]).toBe("First choiceAclaude-opus-5-5provider-1 · XHigh · Flex");
  expect(cards("default")[0]!.getAttribute("aria-label")).toBe("First choice: provider-1/anthropic/claude-opus-5-5, XHigh, Flex");
  expect(summaryTiers("default")).toEqual(["· Flex", "", ""]);
  expect(tierRadios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  // Back to none: the save says so, and the card and the row say nothing of a tier.
  pickTier("Default");
  await settle();
  expect(posts.at(-1)!.models.default.serviceTier).toBe("");
  expect(cardText("default")[0]).toBe("First choiceAclaude-opus-5-5provider-1 · XHigh");
  expect(summaryTiers("default")).toEqual(["", "", ""]);
});

test("a fallback keeps its own tier, at the default effort it is the only word after the model; Kilo's and Codex's steps offer none", async () => {
  const cfg = config();
  cfg.agent.workerModelFallbacks = [{ model: "provider-1/openai/gpt-6.1-sol", reasoningEffort: "provider-default" }];
  await render(cfg);
  await openLane("worker");
  await openCard("worker", 0);
  expect([editor()!.querySelector('[aria-label="Reasoning effort"]') !== null, tierRadios().length]).toEqual([true, 0]);
  await openCard("worker", 1);
  pickTier("Priority");
  await settle();
  expect(posts.at(-1)!.agent.workerModelFallbacks).toEqual([{ model: "provider-1/openai/gpt-6.1-sol", reasoningEffort: "provider-default", serviceTier: "priority" }]);
  expect(cardText("worker")).toEqual(["First choiceOgpt-6.1-solcodex · High", "ThenOgpt-6.1-solprovider-1 · default effort · Priority"]);
  expect(summaryTiers("worker")).toEqual(["", "Priority"]);
  await openLane("default");
  await openCard("default", 1);
  expect(tierRadios().length).toBe(0);
});

test("a step given a model whose API has no service tier loses the one it had", async () => {
  const cfg = config();
  (cfg.models.default as { serviceTier?: string }).serviceTier = "flex";
  await render(cfg);
  await openLane("default");
  expect(cardText("default")[0]).toBe("First choiceAclaude-opus-5-5provider-1 · XHigh · Flex");
  await openCard("default", 0);
  pointerOpen(editor()!.querySelector<HTMLElement>('[aria-label="Model"]')!);
  await settle();
  act(() => menuItems().find((el) => el.getAttribute("data-ref") === "codex/gpt-6.1-sol")!.click());
  await settle();
  expect(posts.at(-1)!.models.default).toMatchObject({ model: "codex/gpt-6.1-sol", serviceTier: "" });
  expect(cardText("default")[0]).toBe("First choiceOgpt-6.1-solcodex · XHigh");
  expect(tierRadios().length).toBe(0);
});

test("Earlier and Later move a step; Remove drops it, the next one becoming first when it was the first", async () => {
  await render();
  await openLane("default");
  await openCard("default", 2);
  act(() => button(editor(), "Earlier")!.click());
  await settle();
  expect(cards("default").map((c) => c.getAttribute("title"))).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/x-ai/grok-4.7", "kilo/anthropic/claude-opus-5.5"]);
  expect(posts.at(-1)!.models.default.modelFallbacks).toEqual([sel("kilo/x-ai/grok-4.7", "high"), sel("kilo/anthropic/claude-opus-5.5", "xhigh")]);
  // The editor goes with its step.
  expect(editor()!.textContent).toContain("Fallback 1");
  expect(editor()!.querySelector('[aria-label="Model"]')!.textContent).toBe("Xkilo/x-ai/grok-4.7");
  act(() => button(editor(), "Done")!.click());
  await settle();
  await openCard("default", 0);
  expect(button(editor(), "Earlier")!.disabled).toBe(true);
  // The editor's Remove asks first too.
  act(() => button(editor(), "Remove")!.click());
  await settle();
  expect(confirmDialog()!.textContent).toContain("The next step becomes the first choice.");
  act(() => button(confirmDialog(), "Remove")!.click());
  await settle();
  expect(editor() === null).toBe(true);
  expect(cards("default").map((c) => c.getAttribute("title"))).toEqual(["kilo/x-ai/grok-4.7", "kilo/anthropic/claude-opus-5.5"]);
  expect(cardText("default")[0]).toContain("First choice");
  expect(posts.at(-1)!.models.default).toMatchObject({ model: "kilo/x-ai/grok-4.7", reasoningEffort: "high", modelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh")] });
});

test("the only step of a route cannot be removed, and its card closes its editor again", async () => {
  await render(config({ fallbacks: [] }));
  await openLane("default");
  expect(removeButtons("default").map((b) => b.getAttribute("aria-label"))).toEqual([]);
  await openCard("default", 0);
  expect(button(editor(), "Remove")!.disabled).toBe(true);
  expect(button(editor(), "Later")!.disabled).toBe(true);
  // The card is the editor's toggle.
  await openCard("default", 0);
  expect(editor() === null).toBe(true);
});

test("+ lists the models set up, by provider, those on the route disabled, and adds the pick last at the default effort", async () => {
  await render();
  await openLane("worker");
  pointerOpen(lane("worker").querySelector<HTMLElement>('[aria-label="Add a step"]')!);
  await settle();
  expect(menuItem("codex") === undefined).toBe(true);
  expect(menuItem("gpt-6.1-sol")).toBeDefined();
  const used = menuItems().filter((el) => el.getAttribute("data-disabled") !== null).map((el) => el.getAttribute("data-ref"));
  expect(used.sort()).toEqual(["codex/gpt-6.1-sol", "provider-1/openai/gpt-6.1-sol"]);
  act(() => menuItems().find((el) => el.getAttribute("data-ref") === "kilo/x-ai/grok-4.7")!.click());
  await settle();
  expect(cardText("worker").at(-1)).toBe("ThenXgrok-4.7kilo · default effort");
  expect(posts.at(-1)!.agent.workerModelFallbacks).toEqual([sel("provider-1/openai/gpt-6.1-sol", "high"), sel("kilo/x-ai/grok-4.7")]);
});

test("with no other model to add, + is disabled and says why and where to add one", async () => {
  await render(config({ models: { openai: ["gpt-5.5"] }, fallbacks: [] }));
  await openLane("default");
  const add = lane("default").querySelector<HTMLButtonElement>('[aria-label="Add a step"]')!;
  expect(add.disabled).toBe(true);
  const hint = lane("default").querySelector("[data-slot=fallback-hint]");
  expect(hint?.textContent).toBe("No other model to fall back to. Add one in Providers.");
  expect(hint?.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=providers");
});

test("with another model to add, + is live and there is no hint", async () => {
  await render(config({ models: { openai: ["gpt-5.5", "gpt-5.5-mini"] }, fallbacks: [] }));
  await openLane("default");
  expect(lane("default").querySelector<HTMLButtonElement>('[aria-label="Add a step"]')!.disabled).toBe(false);
  expect(lane("default").querySelector("[data-slot=fallback-hint]") === null).toBe(true);
});

test("a route with four fallbacks or more says a long chain waits longer; three say nothing", async () => {
  const models = { p: ["m1", "m2", "m3", "m4", "m5"] };
  await render(config({ models, fallbacks: ["p/m2", "p/m3", "p/m4", "p/m5"].map((m) => sel(m)) }));
  await openLane("default");
  expect(lane("default").querySelector('[data-slot="route-long"]')?.textContent).toBe("Each step is tried in turn, so a long chain waits longer before a call gives up.");
  await render(config({ models, fallbacks: ["p/m2", "p/m3", "p/m4"].map((m) => sel(m)) }));
  await openLane("default");
  expect(lane("default").querySelector('[data-slot="route-long"]') === null).toBe(true);
});

test("turning on a route of its own draws the chain it starts from and waits for the route's Save; switched back, nothing is left to save", async () => {
  await render();
  await openLane("manager");
  const own = () => lane("manager").querySelector<HTMLButtonElement>('[role="switch"]')!;
  act(() => own().click());
  await settle();
  expect(cards("manager").map((c) => c.getAttribute("title"))).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5", "kilo/x-ai/grok-4.7"]);
  expect(lane("manager").querySelector('[data-slot="route-follows"]') === null).toBe(true);
  expect(posts).toStrictEqual([]);
  expect(lane("manager").textContent).toContain("Unsaved changes");
  act(() => own().click());
  await settle();
  expect(lane("manager").querySelector('[data-slot="route-follows"]')).not.toBeNull();
  expect(button(lane("manager"), "Save") === undefined).toBe(true);
});

test("a step's × asks first: Cancel keeps it, Remove drops it and saves the route", async () => {
  await render();
  await openLane("default");
  expect(removeButtons("default").map((b) => b.getAttribute("aria-label"))).toEqual([
    "Remove provider-1/anthropic/claude-opus-5-5",
    "Remove kilo/anthropic/claude-opus-5.5",
    "Remove kilo/x-ai/grok-4.7"
  ]);
  act(() => removeButtons("default")[1]!.click());
  await settle();
  expect(confirmDialog()!.textContent).toContain("Remove kilo/anthropic/claude-opus-5.5 from the default route?");
  expect(confirmDialog()!.textContent).not.toContain("first choice");
  act(() => button(confirmDialog(), "Cancel")!.click());
  await settle();
  expect([titlesOf("default").length, posts]).toEqual([3, []]);
  await removeStep("default", 1);
  expect(titlesOf("default")).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/x-ai/grok-4.7"]);
  expect(posts.map((p) => p.models.default.modelFallbacks)).toStrictEqual([[sel("kilo/x-ai/grok-4.7", "high")]]);
  // A route of its own names itself.
  await openLane("worker");
  act(() => removeButtons("worker")[0]!.click());
  await settle();
  expect(confirmDialog()!.textContent).toContain("Remove codex/gpt-6.1-sol from the workers' route? The next step becomes the first choice.");
});

test("a route switched on and not saved yet keeps the changes to its steps for its Save", async () => {
  await render();
  await openLane("manager");
  act(() => lane("manager").querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await settle();
  await removeStep("manager", 2);
  expect(titlesOf("manager")).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5"]);
  expect(posts).toStrictEqual([]);
  act(() => button(lane("manager"), "Save")!.click());
  await settle();
  expect(posts).toStrictEqual([{ agent: { managerModel: sel("provider-1/anthropic/claude-opus-5-5", "xhigh"), managerModelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh")] } }]);
});

test("a route switched off waits for its Save; switched back before it, its steps are still there", async () => {
  await render();
  await openLane("worker");
  const own = () => lane("worker").querySelector<HTMLButtonElement>('[role="switch"]')!;
  act(() => own().click());
  await settle();
  expect(lane("worker").querySelector('[data-slot="route-follows"]')).not.toBeNull();
  expect(lane("worker").textContent).toContain("Unsaved changes");
  act(() => own().click());
  await settle();
  expect(titlesOf("worker")).toEqual(["codex/gpt-6.1-sol", "provider-1/openai/gpt-6.1-sol"]);
  expect(posts).toStrictEqual([]);
  act(() => own().click());
  await settle();
  act(() => button(lane("worker"), "Save")!.click());
  await settle();
  expect(posts).toStrictEqual([{ agent: { workerModel: null, workerModelFallbacks: null } }]);
});

test("a switch moved while step changes are being saved is neither sent with them nor put back by their answers", async () => {
  await render();
  await openLane("worker");
  await openCard("worker", 0);
  const effort = (name: string) => act(() => Array.from(editor()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === name)!.click());
  holding = true;
  effort("Low");
  await settle();
  effort("Medium");
  act(() => button(editor(), "Done")!.click());
  await settle();
  act(() => lane("worker").querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await settle();
  await release();
  await settle();
  await release();
  await settle();
  expect(posts.map((p) => p.agent.workerModel)).toStrictEqual([sel("codex/gpt-6.1-sol", "low"), sel("codex/gpt-6.1-sol", "medium")]);
  // Still switched off, waiting for Save.
  expect(lane("worker").querySelector('[data-slot="route-follows"]')).not.toBeNull();
  expect(lane("worker").textContent).toContain("Unsaved changes");
  holding = false;
  act(() => button(lane("worker"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: { workerModel: null, workerModelFallbacks: null } });
});

test("a route switched back after its Save failed stays as it was saved, and its steps' saves do not carry the switch", async () => {
  await render();
  await openLane("manager");
  const own = () => lane("manager").querySelector<HTMLButtonElement>('[role="switch"]')!;
  act(() => own().click());
  await settle();
  failing = true;
  act(() => button(lane("manager"), "Save")!.click());
  await settle();
  failing = false;
  act(() => own().click());
  await settle();
  expect(own().getAttribute("aria-checked")).toBe("false");
  expect(lane("manager").querySelector('[data-slot="route-follows"]')).not.toBeNull();
  expect(button(lane("manager"), "Save") === undefined).toBe(true);
  // Its Retry, now, sends the route as it is saved: following the default.
  const retry = button(lane("manager").querySelector('[data-slot="inline-error"]'), "Retry")!;
  act(() => retry.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: { managerModel: null, managerModelFallbacks: null } });
  expect(own().getAttribute("aria-checked")).toBe("false");
});

test("a route switched off, its Save failed, and switched back on saves its steps as on", async () => {
  await render();
  await openLane("worker");
  const own = () => lane("worker").querySelector<HTMLButtonElement>('[role="switch"]')!;
  act(() => own().click());
  await settle();
  failing = true;
  act(() => button(lane("worker"), "Save")!.click());
  await settle();
  failing = false;
  act(() => own().click());
  await settle();
  expect(own().getAttribute("aria-checked")).toBe("true");
  await removeStep("worker", 1);
  expect(posts.at(-1)).toEqual({ agent: { workerModel: sel("codex/gpt-6.1-sol", "high"), workerModelFallbacks: [] } });
});

test("a route switched on and not saved keeps its step changes while the default route changes under it", async () => {
  await render();
  const effort = (name: string) => act(() => Array.from(editor()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === name)!.click());
  await openLane("manager");
  act(() => lane("manager").querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await settle();
  await openCard("manager", 0);
  effort("Low");
  act(() => button(editor(), "Done")!.click());
  await settle();
  await openLane("default");
  await openCard("default", 0);
  effort("Low");
  await settle();
  effort("Medium");
  await settle();
  act(() => button(editor(), "Done")!.click());
  await settle();
  await openLane("manager");
  expect(cardText("manager")[0]).toBe("First choiceAclaude-opus-5-5provider-1 · Low");
  act(() => button(lane("manager"), "Save")!.click());
  await settle();
  expect(posts.at(-1)!.agent.managerModel).toEqual(sel("provider-1/anthropic/claude-opus-5-5", "low"));
});

test("a change made while a Retry is on its way is saved after it, and stays", async () => {
  await render();
  await openLane("default");
  await openCard("default", 0);
  const effort = (name: string) => act(() => Array.from(editor()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === name)!.click());
  failing = true;
  effort("High");
  await settle();
  failing = false;
  holding = true;
  act(() => button(lane("default").querySelector('[data-slot="inline-error"]'), "Retry")!.click());
  await settle();
  effort("Low");
  await settle();
  await release();
  await settle();
  await release();
  await settle();
  expect(posts.map((p) => p.models.default.reasoningEffort)).toStrictEqual(["high", "high", "low"]);
  expect(cardText("default")[0]).toBe("First choiceAclaude-opus-5-5provider-1 · Low");
});

test("closing the removal dialog gives focus back: to the × on Cancel or Escape, to a card of the route after Remove", async () => {
  await render();
  await openLane("default");
  const x = () => removeButtons("default")[1]!;
  // A press need not focus the button (Safari): focus is elsewhere when it asks.
  act(() => cards("default")[0]!.focus());
  act(() => x().click());
  await settle();
  act(() => button(confirmDialog(), "Cancel")!.click());
  await settle();
  expect(document.activeElement === x()).toBe(true);
  act(() => x().click());
  await settle();
  act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  expect(document.activeElement === x()).toBe(true);
  act(() => x().click());
  await settle();
  act(() => button(confirmDialog(), "Remove")!.click());
  await settle();
  expect(document.activeElement?.getAttribute("title")).toBe("kilo/x-ai/grok-4.7");
  // Asked from the editor, which closes: back to the step's card.
  await openCard("default", 0);
  act(() => button(editor(), "Remove")!.click());
  await settle();
  act(() => button(confirmDialog(), "Cancel")!.click());
  await settle();
  expect(document.activeElement?.getAttribute("title")).toBe("provider-1/anthropic/claude-opus-5-5");
});

test("a change saved at once says Saved beside the route's title; one that fails keeps the change, says why and offers Retry", async () => {
  await render();
  failing = true;
  await openLane("default");
  await removeStep("default", 2);
  expect(titlesOf("default")).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5"]);
  const failure = lane("default").querySelector('[data-slot="inline-error"]');
  expect(failure?.textContent).toContain("Couldn't save.");
  expect(lane("default").querySelector('[data-slot="route-saved"]') === null).toBe(true);
  failing = false;
  act(() => button(failure, "Retry")!.click());
  await settle();
  expect(posts.map((p) => p.models.default.modelFallbacks.length)).toStrictEqual([1, 1]);
  expect(lane("default").querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(lane("default").querySelector('[data-slot="route-saved"]')?.textContent).toBe("Saved");
});

test("a route with no model yet asks for one, and a route following it says only that", async () => {
  const cfg = config({ fallbacks: [] });
  cfg.models.default = { model: "", reasoningEffort: "provider-default", modelFallbacks: [] };
  await render(cfg);
  await openLane("default");
  expect(cardText("default")).toEqual(["First choiceChoose a modeldefault effort"]);
  expect(cards("default")[0]!.getAttribute("aria-label")).toBe("First choice: no model, default effort");
  await openLane("manager");
  expect(lane("manager").querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default.");
  await openLane("default");
  await openCard("default", 0);
  expect(editor()!.querySelector('[aria-label="Model"]')!.textContent).toBe("Choose a model");
});

test("a card dragged across the one being edited leaves the editor on its step", async () => {
  await render();
  await openLane("default");
  await openCard("default", 1);
  const drag = (el: HTMLElement, type: string) => act(() => { el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true })); });
  drag(cards("default")[2]!, "dragstart");
  drag(cards("default")[0]!, "dragover");
  drag(cards("default")[0]!, "drop");
  await settle();
  expect(cards("default").map((c) => c.getAttribute("title"))).toEqual(["kilo/x-ai/grok-4.7", "provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5"]);
  expect(posts.at(-1)!.models.default.model).toBe("kilo/x-ai/grok-4.7");
  expect(editor()!.textContent).toContain("Fallback 2");
  expect(editor()!.querySelector('[aria-label="Model"]')!.textContent).toBe("Akilo/anthropic/claude-opus-5.5");
  act(() => Array.from(editor()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((r) => r.textContent === "Low")!.click());
  expect(cardText("default")[2]).toBe("ThenAclaude-opus-5.5kilo · Low");
});

test("an edited step that a save's answer takes away closes its editor, though another step now holds its place, and for good", async () => {
  await render();
  await openLane("default");
  await openCard("default", 1);
  // The server answers with the chain as it was: the step's new model is gone,
  // and the step it replaced is back in that place.
  reflect = false;
  pointerOpen(editor()!.querySelector<HTMLElement>('[aria-label="Model"]')!);
  await settle();
  act(() => menuItem("openai/gpt-6.1-sol")!.click());
  await settle();
  expect(titlesOf("default")).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5", "kilo/x-ai/grok-4.7"]);
  expect(editor() === null).toBe(true);
  // That model added later opens nothing by itself.
  reflect = true;
  pointerOpen(lane("default").querySelector<HTMLElement>('[aria-label="Add a step"]')!);
  await settle();
  act(() => menuItems().find((el) => el.getAttribute("data-ref") === "provider-1/openai/gpt-6.1-sol")!.click());
  await settle();
  expect(titlesOf("default").length).toBe(4);
  expect(editor() === null).toBe(true);
});

test("The personal agent has a lane of its own, after the default and before managers; it follows the default until given its own", async () => {
  await render();
  const lanes = Array.from(host.querySelectorAll<HTMLElement>("[data-route]"));
  expect(lanes.map((l) => l.getAttribute("data-route"))).toEqual(["default", "personal", "manager", "worker", "subagent", "page", "dream", "skillReview", "extraction", "decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck", "toolReviewScreen", "toolReviewSecondLook"]);
  expect(lanes.map((l) => l.querySelector('[data-slot="section-title"]')?.textContent)).toStrictEqual(["Default route", "Personal agent", "Managers", "Workers", "Subagents", "Page updates", "Dream", "Skill review", "Memory extraction", "Decisions", "Manager request check", "Manager stop check", "Memory repeat check", "Tool-call review: screen", "Tool-call review: second look"]);
  // Memory work has routes of its own now.
  await openLane("personal");
  expect(lane("personal").textContent).toContain("The personal agent, with its compaction.");
  await openLane("manager");
  expect(lane("manager").textContent).toContain("Every thread's manager, with its compaction.");
  expect(host.textContent).not.toContain("memory work");
  await openLane("personal");
  expect(lane("personal").querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default:claude-opus-5-5claude-opus-5.5grok-4.7");
  // Its own route: it starts from the default's chain and saves as its own.
  const own = lane("personal").querySelector<HTMLElement>('[aria-label="Own route for the personal agent"]')!;
  act(() => own.click());
  await settle();
  expect(cards("personal").map((c) => c.getAttribute("title"))).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5", "kilo/x-ai/grok-4.7"]);
  expect(posts).toStrictEqual([]);
  act(() => button(lane("personal"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: {
    personalModel: sel("provider-1/anthropic/claude-opus-5-5", "xhigh"),
    personalModelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh"), sel("kilo/x-ai/grok-4.7", "high")]
  } });
  // The managers' lane is untouched by it.
  await openLane("manager");
  expect(lane("manager").querySelector('[data-slot="route-follows"]')).not.toBeNull();
});

test("a saved route of the personal agent's own is drawn as its chain, apart from the managers'", async () => {
  const cfg = config();
  const agent = (cfg as unknown as { agent: Record<string, unknown> }).agent;
  agent.modelOverrides = { manager: false, worker: true, personal: true };
  agent.personalModel = sel("codex/gpt-6.1-sol", "low");
  agent.personalModelFallbacks = [];
  await render(cfg);
  await openLane("personal");
  expect(cardText("personal")).toEqual(["First choiceOgpt-6.1-solcodex · Low"]);
  await openLane("manager");
  expect(lane("manager").querySelector('[data-slot="route-follows"]')).not.toBeNull();
});

test("the dream and memory extraction have lanes of their own after the workers; each follows the default until given its own", async () => {
  await render();
  await openLane("dream");
  expect(lane("dream").querySelector('[data-slot="section-title"]')?.textContent).toBe("Dream");
  expect(lane("dream").textContent).toContain("The background pass that reviews, merges and prunes memories, and writes the briefs agents read first.");
  await openLane("extraction");
  expect(lane("extraction").querySelector('[data-slot="section-title"]')?.textContent).toBe("Memory extraction");
  expect(lane("extraction").textContent).toContain("Picks what to remember from conversations as they leave context.");
  for (const route of ["dream", "extraction"]) {
    await openLane(route);
    expect(lane(route).querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default:claude-opus-5-5claude-opus-5.5grok-4.7");
  }
  // The dream's own route: it starts from the default's chain and saves as its own.
  await openLane("dream");
  act(() => lane("dream").querySelector<HTMLElement>('[aria-label="Own route for the dream"]')!.click());
  await settle();
  expect(posts).toStrictEqual([]);
  act(() => button(lane("dream"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: {
    dreamModel: sel("provider-1/anthropic/claude-opus-5-5", "xhigh"),
    dreamModelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh"), sel("kilo/x-ai/grok-4.7", "high")]
  } });
  // Memory extraction's lane is untouched by it.
  await openLane("extraction");
  expect(lane("extraction").querySelector('[data-slot="route-follows"]')).not.toBeNull();
  expect(lane("extraction").querySelector('[aria-label="Own route for memory extraction"]')).not.toBeNull();
});

test("a saved memory extraction route of its own is drawn as its chain, apart from the dream's", async () => {
  const cfg = config();
  const agent = (cfg as unknown as { agent: Record<string, unknown> }).agent;
  agent.modelOverrides = { manager: false, worker: true, personal: false, dream: false, extraction: true };
  agent.extractionModel = sel("codex/gpt-6.1-sol", "medium");
  agent.extractionModelFallbacks = [];
  await render(cfg);
  await openLane("extraction");
  expect(cardText("extraction")).toEqual(["First choiceOgpt-6.1-solcodex · Medium"]);
  await openLane("dream");
  expect(lane("dream").querySelector('[data-slot="route-follows"]')).not.toBeNull();
});

test("the subagents have a lane after the workers; unset it says a subagent uses the asking agent's model, not the default's", async () => {
  await render();
  await openLane("subagent");
  expect(lane("subagent").querySelector('[data-slot="section-title"]')?.textContent).toBe("Subagents");
  expect(lane("subagent").textContent).toContain("The subagents an agent starts for a self-contained job, with their compaction.");
  expect(lane("subagent").querySelector('[data-slot="route-unset"]')?.textContent).toBe("Not set: uses the model of the agent that asks.");
  // Not the default's chain, which a lane off shows elsewhere.
  expect(lane("subagent").querySelector('[data-slot="route-follows"]') !== null).toBe(false);
  await openLane("dream");
  expect(lane("dream").querySelector('[data-slot="route-follows"]') !== null).toBe(true);
  // Its own route: it starts from the default's chain and saves as its own.
  await openLane("subagent");
  act(() => lane("subagent").querySelector<HTMLElement>('[aria-label="Own route for subagents"]')!.click());
  await settle();
  expect(titlesOf("subagent")).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5", "kilo/x-ai/grok-4.7"]);
  expect(lane("subagent").querySelector('[data-slot="route-unset"]') !== null).toBe(false);
  expect(posts).toStrictEqual([]);
  act(() => button(lane("subagent"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: {
    subagentModel: sel("provider-1/anthropic/claude-opus-5-5", "xhigh"),
    subagentModelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh"), sel("kilo/x-ai/grok-4.7", "high")]
  } });
  expect(lane("subagent").querySelector('[data-slot="route-unset"]') !== null).toBe(false);
  // The dream's lane is untouched by it.
  await openLane("dream");
  expect(lane("dream").querySelector('[data-slot="route-follows"]') !== null).toBe(true);
});

test("a saved subagent route is drawn as its chain; switched off and saved, it sends null for both and says it is unset again", async () => {
  const cfg = config();
  const agent = (cfg as unknown as { agent: Record<string, unknown> }).agent;
  agent.modelOverrides = { manager: false, worker: true, personal: false, dream: false, extraction: false, subagent: true };
  agent.subagentModel = sel("codex/gpt-6.1-sol", "medium");
  agent.subagentModelFallbacks = [];
  await render(cfg);
  await openLane("subagent");
  expect(cardText("subagent")).toEqual(["First choiceOgpt-6.1-solcodex · Medium"]);
  act(() => lane("subagent").querySelector<HTMLElement>('[aria-label="Own route for subagents"]')!.click());
  await settle();
  act(() => button(lane("subagent"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: { subagentModel: null, subagentModelFallbacks: null } });
  expect(lane("subagent").querySelector('[data-slot="route-unset"]')?.textContent).toBe("Not set: uses the model of the agent that asks.");
  expect(cards("subagent").length).toBe(0);
});

test("the Page updates row runs as the subagents do until given its own route, and saves it", async () => {
  await render();
  await openLane("page");
  expect(lane("page").querySelector('[data-slot="section-title"]')?.textContent).toBe("Page updates");
  expect(lane("page").textContent).toContain("The subagents that change the personal agent's page.");
  expect(lane("page").querySelector('[data-slot="route-unset"]')?.textContent).toBe("Not set: runs as the subagents do.");
  expect(lane("page").querySelector('[data-slot="route-follows"]') !== null).toBe(false);
  act(() => lane("page").querySelector<HTMLElement>('[aria-label="Own route for page updates"]')!.click());
  await settle();
  expect(titlesOf("page")).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5", "kilo/x-ai/grok-4.7"]);
  act(() => button(lane("page"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: {
    pageModel: sel("provider-1/anthropic/claude-opus-5-5", "xhigh"),
    pageModelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh"), sel("kilo/x-ai/grok-4.7", "high")]
  } });
  // The subagents' lane is untouched by it.
  await openLane("subagent");
  expect(lane("subagent").querySelector('[data-slot="route-unset"]')?.textContent).toBe("Not set: uses the model of the agent that asks.");
});

test("the Skill review row runs on the Dream's model until given its own route, and saves it", async () => {
  await render();
  await openLane("skillReview");
  expect(lane("skillReview").querySelector('[data-slot="section-title"]')?.textContent).toBe("Skill review");
  expect(lane("skillReview").textContent).toContain("Reviews finished work when an agent asks, and writes skills.");
  expect(lane("skillReview").querySelector('[data-slot="route-unset"]')?.textContent).toBe("Not set: uses the Dream's model.");
  act(() => lane("skillReview").querySelector<HTMLElement>('[aria-label="Own route for skill reviews"]')!.click());
  await settle();
  expect(titlesOf("skillReview")).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5", "kilo/x-ai/grok-4.7"]);
  act(() => button(lane("skillReview"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: {
    skillReviewModel: sel("provider-1/anthropic/claude-opus-5-5", "xhigh"),
    skillReviewModelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh"), sel("kilo/x-ai/grok-4.7", "high")]
  } });
});

const LANES_1 = ["default", "personal", "manager", "worker", "subagent", "page", "dream", "skillReview", "extraction"];
const LANES_2 = ["decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck", "toolReviewScreen", "toolReviewSecondLook"];

test("the lanes sit in two groups, each a closed row saying what it runs now", async () => {
  await render();
  const groups = Array.from(host.querySelectorAll<HTMLElement>('[data-slot="lane-group"]'));
  expect(groups.map((g) => g.querySelector("h3")?.textContent)).toEqual(["Agents and background work", "Quick judgements"]);
  expect(groups.map((g) => g.querySelector('[data-slot="lane-group-hint"]')?.textContent)).toEqual([
    "Each runs on the default route unless it has its own.",
    "Each runs on Decisions unless it has its own."
  ]);
  expect(groups.map((g) => Array.from(g.querySelectorAll("[data-route]")).map((el) => el.getAttribute("data-route")))).toEqual([LANES_1, LANES_2]);
  for (const route of [...LANES_1, ...LANES_2]) expect(toggle(route).getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelectorAll("[data-step]").length).toBe(0);
  expect(summarySteps("default")).toEqual([["provider-1/anthropic/claude-opus-5-5", "XHigh"], ["kilo/anthropic/claude-opus-5.5", "XHigh"], ["kilo/x-ai/grok-4.7", "High"]]);
  expect(summarySteps("worker")).toEqual([["codex/gpt-6.1-sol", "High"], ["provider-1/openai/gpt-6.1-sol", "High"]]);
  for (const route of ["manager", "personal", "dream", "extraction"]) expect(summary(route)).toBe("Default route");
  expect(summary("subagent")).toBe("The asking agent's model");
  expect(summary("page")).toBe("As subagents");
  expect(summary("skillReview")).toBe("The Dream's model");
});

test("a row opens in place to its description, switches and chain; opening another closes it", async () => {
  await render();
  await openLane("worker");
  expect(toggle("worker").getAttribute("aria-expanded")).toBe("true");
  expect(lane("worker").querySelector('[data-slot="lane-description"]')?.textContent).toBe("The agent inside each worker, with its compaction.");
  expect(lane("worker").querySelector('[role="switch"][aria-label="Own route for workers"]') === null).toBe(false);
  expect(cards("worker").length).toBe(2);
  // A change saved at once: the answer leaves the row open.
  await openCard("worker", 0);
  pickEffort("Low");
  await settle();
  expect(posts.at(-1)!.agent.workerModel).toEqual({ model: "codex/gpt-6.1-sol", reasoningEffort: "low" });
  expect(toggle("worker").getAttribute("aria-expanded")).toBe("true");
  await openLane("manager");
  expect(toggle("worker").getAttribute("aria-expanded")).toBe("false");
  expect(cards("worker").length).toBe(0);
  expect(lane("manager").querySelector('[data-slot="route-follows"]') === null).toBe(false);
  act(() => toggle("manager").click());
  await settle();
  expect(toggle("manager").getAttribute("aria-expanded")).toBe("false");
});

test("a lane switched to its own route and closed before its Save keeps Unsaved changes and Save under its row", async () => {
  await render();
  await openLane("manager");
  act(() => lane("manager").querySelector<HTMLButtonElement>('[role="switch"][aria-label="Own route for managers"]')!.click());
  await settle();
  await openLane("worker");
  await openCard("worker", 0);
  pickEffort("Low");
  await settle();
  expect("managerModel" in posts.at(-1)!.agent).toBe(false);
  expect(toggle("manager").getAttribute("aria-expanded")).toBe("false");
  expect(lane("manager").textContent).toContain("Unsaved changes");
  expect(button(lane("manager"), "Save") === undefined).toBe(false);
  await openLane("manager");
  expect(cards("manager").length).toBe(3);
  act(() => button(lane("manager"), "Save")!.click());
  await settle();
  expect(posts.at(-1)!.agent.managerModel).toEqual({ model: "provider-1/anthropic/claude-opus-5-5", reasoningEffort: "xhigh" });
});

test("a row held open by a failed save ignores its toggle, and a Retry that saves keeps it open", async () => {
  await render();
  await openLane("default");
  failing = true;
  await openCard("default", 1);
  pickEffort("Low");
  await settle();
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  await openLane("worker");
  // Its toggle does nothing while the error holds it open: the other row stays.
  act(() => toggle("default").click());
  await settle();
  expect([toggle("default").getAttribute("aria-expanded"), toggle("worker").getAttribute("aria-expanded")]).toEqual(["true", "true"]);
  // Retried and saved: it is the open row now, and stays.
  failing = false;
  act(() => button(lane("default").querySelector('[data-slot="inline-error"]'), "Retry")!.click());
  await settle();
  expect(lane("default").querySelector('[data-slot="inline-error"]') === null).toBe(true);
  expect(posts.at(-1)!.models.default.modelFallbacks[0]).toEqual({ model: "kilo/anthropic/claude-opus-5.5", reasoningEffort: "low" });
  expect([toggle("default").getAttribute("aria-expanded"), toggle("worker").getAttribute("aria-expanded")]).toEqual(["true", "false"]);
});

test("with no default model yet the Default route row starts open on Choose a model; with one, every row starts closed", async () => {
  const cfg = config({ fallbacks: [] });
  cfg.models.default = { model: "", reasoningEffort: "provider-default", modelFallbacks: [] };
  await render(cfg);
  expect(toggle("default").getAttribute("aria-expanded")).toBe("true");
  expect(cardText("default")).toEqual(["First choiceChoose a modeldefault effort"]);
  expect(summary("default")).toBe("No model yet");
  await render();
  expect(toggle("default").getAttribute("aria-expanded")).toBe("false");
});

test("closing a row while a step's editor is open takes the editor with it", async () => {
  await render();
  await openLane("default");
  await openCard("default", 0);
  expect(editor() === null).toBe(false);
  // As a pointer does it: the press focuses the row's toggle (and dismisses
  // the editor as a press outside it), the click closes the row.
  act(() => {
    toggle("default").focus();
    toggle("default").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  act(() => toggle("default").click());
  await settle();
  expect(editor() === null).toBe(true);
  expect(toggle("default").getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement === toggle("default")).toBe(true);
  // From the keyboard: Enter on the toggle closes the row, focus stays on it.
  await openLane("default");
  await openCard("default", 0);
  act(() => toggle("default").focus());
  act(() => toggle("default").click());
  await settle();
  expect(editor() === null).toBe(true);
  expect(document.activeElement === toggle("default")).toBe(true);
});

test("every routing search hit lands on its lane's row", async () => {
  await render();
  const titles: Record<string, string> = {
    default: "Default route", personal: "Personal agent", manager: "Managers", worker: "Workers", subagent: "Subagents", page: "Page updates",
    dream: "Dream", skillReview: "Skill review", extraction: "Memory extraction", decisions: "Decisions", managerRequestCheck: "Manager request check",
    managerStopCheck: "Manager stop check", memoryRepeatCheck: "Memory repeat check",
    toolReviewScreen: "Tool-call review: screen", toolReviewSecondLook: "Tool-call review: second look"
  };
  const entries = SETTINGS_SEARCH_INDEX.filter((entry) => entry.section === "routing");
  expect([...new Set(entries.map((entry) => entry.group))].sort()).toEqual(Object.values(titles).sort());
  for (const [route, title] of Object.entries(titles)) {
    for (const entry of entries.filter((e) => e.group === title)) {
      // The row: the part of the lane the jump's flash shows on.
      expect(document.getElementById(`setting-${entry.anchor}`) === lane(route).querySelector('[data-slot="section-header"]')).toBe(true);
    }
  }
  expect(entries.filter((entry) => entry.group === "Default route").map((entry) => [entry.label, entry.anchor])).toEqual([
    ["Model", "route-default"], ["Reasoning effort", "route-default"], ["Fallbacks", "route-default"]
  ]);
});
