import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { api } from "@/lib/api-paths";
import { RoutingPane } from "@/routes/settings/RoutingPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

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
      globalModel: sel(first, "xhigh"),
      globalModelFallbacks: fallbacks,
      dreamModel: sel(first, "xhigh"),
      dreamModelFallbacks: fallbacks,
      extractionModel: sel(first, "xhigh"),
      extractionModelFallbacks: fallbacks,
      subagentModel: sel(first, "xhigh"),
      subagentModelFallbacks: fallbacks,
      pageModel: sel(first, "xhigh"),
      pageModelFallbacks: fallbacks
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
    for (const route of ["manager", "worker", "global", "subagent", "page", "dream", "extraction"]) {
      if (next.agent.modelOverrides?.[route]) continue;
      next.agent[`${route}Model`] = { model: next.models.default.model, reasoningEffort: next.models.default.reasoningEffort };
      next.agent[`${route}ModelFallbacks`] = next.models.default.modelFallbacks;
    }
  }
  for (const route of ["manager", "worker", "global", "subagent", "page", "dream", "extraction"]) {
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

const lane = (route: string) => host.querySelector<HTMLElement>(`[data-route="${route}"]`)!;
const cards = (route: string) => Array.from(lane(route).querySelectorAll<HTMLButtonElement>("[data-step]"));
const cardText = (route: string) => cards(route).map((card) => card.textContent);
const editor = () => document.querySelector<HTMLElement>('[data-slot="step-editor"]');
const button = (scope: ParentNode | null, text: string) =>
  Array.from(scope?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent?.trim() === text);
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
const titlesOf = (route: string) => cards(route).map((c) => c.getAttribute("title"));

test("each route is drawn as its chain: first choice, then each fallback, with its provider and effort", async () => {
  await render();
  expect(cardText("default")).toEqual([
    "First choiceAclaude-opus-5-5provider-1 · XHigh",
    "ThenAclaude-opus-5.5kilo · XHigh",
    "ThenXgrok-4.7kilo · High"
  ]);
  expect(cards("default")[0]!.getAttribute("aria-label")).toBe("First choice: provider-1/anthropic/claude-opus-5-5, XHigh");
  expect(lane("default").querySelectorAll('[data-slot="step-arrow"]').length).toBe(2);
  expect(cardText("worker")).toEqual(["First choiceOgpt-6.1-solcodex · High", "ThenOgpt-6.1-solprovider-1 · High"]);
  // Following the default: one line naming that chain, no cards.
  expect(cards("manager").length).toBe(0);
  expect(lane("manager").querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default:claude-opus-5-5claude-opus-5.5grok-4.7");
});

test("a card opens its editor: a model picked from the menu takes the step's place and the effort is set, each saved as it is made", async () => {
  await render();
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
  expect(Array.from(editor()!.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual(["Default", "None", "Minimal", "Low", "Medium", "High", "XHigh", "Max"]);
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

test("Earlier and Later move a step; Remove drops it, the next one becoming first when it was the first", async () => {
  await render();
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
  const add = lane("default").querySelector<HTMLButtonElement>('[aria-label="Add a step"]')!;
  expect(add.disabled).toBe(true);
  const hint = lane("default").querySelector("[data-slot=fallback-hint]");
  expect(hint?.textContent).toBe("No other model to fall back to. Add one in Providers.");
  expect(hint?.querySelector("a")?.getAttribute("href")).toBe("/settings?tab=providers");
});

test("with another model to add, + is live and there is no hint", async () => {
  await render(config({ models: { openai: ["gpt-5.5", "gpt-5.5-mini"] }, fallbacks: [] }));
  expect(lane("default").querySelector<HTMLButtonElement>('[aria-label="Add a step"]')!.disabled).toBe(false);
  expect(lane("default").querySelector("[data-slot=fallback-hint]") === null).toBe(true);
});

test("a route with four fallbacks or more says a long chain waits longer; three say nothing", async () => {
  const models = { p: ["m1", "m2", "m3", "m4", "m5"] };
  await render(config({ models, fallbacks: ["p/m2", "p/m3", "p/m4", "p/m5"].map((m) => sel(m)) }));
  expect(lane("default").querySelector('[data-slot="route-long"]')?.textContent).toBe("Each step is tried in turn, so a long chain waits longer before a call gives up.");
  await render(config({ models, fallbacks: ["p/m2", "p/m3", "p/m4"].map((m) => sel(m)) }));
  expect(lane("default").querySelector('[data-slot="route-long"]') === null).toBe(true);
});

test("turning on a route of its own draws the chain it starts from and waits for the route's Save; switched back, nothing is left to save", async () => {
  await render();
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
  act(() => removeButtons("worker")[0]!.click());
  await settle();
  expect(confirmDialog()!.textContent).toContain("Remove codex/gpt-6.1-sol from the workers' route? The next step becomes the first choice.");
});

test("a route switched on and not saved yet keeps the changes to its steps for its Save", async () => {
  await render();
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
  act(() => lane("manager").querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  await settle();
  await openCard("manager", 0);
  effort("Low");
  act(() => button(editor(), "Done")!.click());
  await settle();
  await openCard("default", 0);
  effort("Low");
  await settle();
  effort("Medium");
  await settle();
  act(() => button(editor(), "Done")!.click());
  await settle();
  expect(cardText("manager")[0]).toBe("First choiceAclaude-opus-5-5provider-1 · Low");
  act(() => button(lane("manager"), "Save")!.click());
  await settle();
  expect(posts.at(-1)!.agent.managerModel).toEqual(sel("provider-1/anthropic/claude-opus-5-5", "low"));
});

test("a change made while a Retry is on its way is saved after it, and stays", async () => {
  await render();
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

test("settings search lands on the default route: its first choice, that choice's effort, its chain", async () => {
  await render();
  expect(document.getElementById("setting-route-model") === cards("default")[0]!).toBe(true);
  for (const id of ["setting-route-model", "setting-route-effort", "setting-route-fallbacks"]) expect(document.querySelectorAll(`#${id}`).length).toBe(1);
  expect(document.getElementById("setting-route-effort")?.textContent?.trim()).toBe("provider-1 · XHigh");
  expect(cards("default")[0]!.contains(document.getElementById("setting-route-effort"))).toBe(true);
  expect(document.getElementById("setting-route-fallbacks")?.contains(cards("default")[2]!)).toBe(true);
  expect(lane("worker").querySelector("[id^=setting-]") === null).toBe(true);
});

test("a route with no model yet asks for one, and a route following it says only that", async () => {
  const cfg = config({ fallbacks: [] });
  cfg.models.default = { model: "", reasoningEffort: "provider-default", modelFallbacks: [] };
  await render(cfg);
  expect(cardText("default")).toEqual(["First choiceChoose a modeldefault effort"]);
  expect(cards("default")[0]!.getAttribute("aria-label")).toBe("First choice: no model, default effort");
  expect(lane("manager").querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default.");
  await openCard("default", 0);
  expect(editor()!.querySelector('[aria-label="Model"]')!.textContent).toBe("Choose a model");
});

test("a card dragged across the one being edited leaves the editor on its step", async () => {
  await render();
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

test("Your agent has a lane of its own, after the default and before managers; it follows the default until given its own", async () => {
  await render();
  const lanes = Array.from(host.querySelectorAll<HTMLElement>("[data-route]"));
  expect(lanes.map((l) => l.getAttribute("data-route"))).toEqual(["default", "global", "manager", "worker", "subagent", "page", "dream", "extraction", "decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck"]);
  expect(lanes.map((l) => l.querySelector("h2, h3")?.textContent)).toStrictEqual(["Default route", "Your agent", "Managers", "Workers", "Subagents", "Page updates", "Dream", "Memory extraction", "Decisions", "Manager request check", "Manager stop check", "Memory repeat check"]);
  // Memory work has routes of its own now.
  expect(lane("global").textContent).toContain("Your agent, with its compaction.");
  expect(lane("manager").textContent).toContain("Every thread's manager, with its compaction.");
  expect(host.textContent).not.toContain("memory work");
  expect(lane("global").querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default:claude-opus-5-5claude-opus-5.5grok-4.7");
  // Its own route: it starts from the default's chain and saves as its own.
  const own = lane("global").querySelector<HTMLElement>('[aria-label="Own route for Your agent"]')!;
  act(() => own.click());
  await settle();
  expect(cards("global").map((c) => c.getAttribute("title"))).toEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5", "kilo/x-ai/grok-4.7"]);
  expect(posts).toStrictEqual([]);
  act(() => button(lane("global"), "Save")!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ agent: {
    globalModel: sel("provider-1/anthropic/claude-opus-5-5", "xhigh"),
    globalModelFallbacks: [sel("kilo/anthropic/claude-opus-5.5", "xhigh"), sel("kilo/x-ai/grok-4.7", "high")]
  } });
  // The managers' lane is untouched by it.
  expect(lane("manager").querySelector('[data-slot="route-follows"]')).not.toBeNull();
});

test("a saved route of Your agent's own is drawn as its chain, apart from the managers'", async () => {
  const cfg = config();
  const agent = (cfg as unknown as { agent: Record<string, unknown> }).agent;
  agent.modelOverrides = { manager: false, worker: true, global: true };
  agent.globalModel = sel("codex/gpt-6.1-sol", "low");
  agent.globalModelFallbacks = [];
  await render(cfg);
  expect(cardText("global")).toEqual(["First choiceOgpt-6.1-solcodex · Low"]);
  expect(lane("manager").querySelector('[data-slot="route-follows"]')).not.toBeNull();
});

test("the dream and memory extraction have lanes of their own after the workers; each follows the default until given its own", async () => {
  await render();
  expect(lane("dream").querySelector("h2, h3")?.textContent).toBe("Dream");
  expect(lane("dream").textContent).toContain("The background pass that reviews, merges and prunes memories, and writes the briefs agents read first.");
  expect(lane("extraction").querySelector("h2, h3")?.textContent).toBe("Memory extraction");
  expect(lane("extraction").textContent).toContain("Picks what to remember from conversations as they leave context.");
  for (const route of ["dream", "extraction"]) {
    expect(lane(route).querySelector('[data-slot="route-follows"]')?.textContent).toBe("Follows the default:claude-opus-5-5claude-opus-5.5grok-4.7");
  }
  // The dream's own route: it starts from the default's chain and saves as its own.
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
  expect(lane("extraction").querySelector('[data-slot="route-follows"]')).not.toBeNull();
  expect(lane("extraction").querySelector('[aria-label="Own route for memory extraction"]')).not.toBeNull();
});

test("a saved memory extraction route of its own is drawn as its chain, apart from the dream's", async () => {
  const cfg = config();
  const agent = (cfg as unknown as { agent: Record<string, unknown> }).agent;
  agent.modelOverrides = { manager: false, worker: true, global: false, dream: false, extraction: true };
  agent.extractionModel = sel("codex/gpt-6.1-sol", "medium");
  agent.extractionModelFallbacks = [];
  await render(cfg);
  expect(cardText("extraction")).toEqual(["First choiceOgpt-6.1-solcodex · Medium"]);
  expect(lane("dream").querySelector('[data-slot="route-follows"]')).not.toBeNull();
});

test("the subagents have a lane after the workers; unset it says a subagent uses the asking agent's model, not the default's", async () => {
  await render();
  expect(lane("subagent").querySelector("h2, h3")?.textContent).toBe("Subagents");
  expect(lane("subagent").textContent).toContain("The subagents an agent starts for a self-contained job, with their compaction.");
  expect(lane("subagent").querySelector('[data-slot="route-unset"]')?.textContent).toBe("Not set: uses the model of the agent that asks.");
  // Not the default's chain, which a lane off shows elsewhere.
  expect(lane("subagent").querySelector('[data-slot="route-follows"]') !== null).toBe(false);
  expect(lane("dream").querySelector('[data-slot="route-follows"]') !== null).toBe(true);
  // Its own route: it starts from the default's chain and saves as its own.
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
  expect(lane("dream").querySelector('[data-slot="route-follows"]') !== null).toBe(true);
});

test("a saved subagent route is drawn as its chain; switched off and saved, it sends null for both and says it is unset again", async () => {
  const cfg = config();
  const agent = (cfg as unknown as { agent: Record<string, unknown> }).agent;
  agent.modelOverrides = { manager: false, worker: true, global: false, dream: false, extraction: false, subagent: true };
  agent.subagentModel = sel("codex/gpt-6.1-sol", "medium");
  agent.subagentModelFallbacks = [];
  await render(cfg);
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
  expect(lane("page").querySelector("h2, h3")?.textContent).toBe("Page updates");
  expect(lane("page").textContent).toContain("The subagents that change Your agent's page.");
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
  expect(lane("subagent").querySelector('[data-slot="route-unset"]')?.textContent).toBe("Not set: uses the model of the agent that asks.");
});
