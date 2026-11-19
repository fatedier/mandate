import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { api } from "@/lib/api-paths";
import { RoutingPane } from "@/routes/settings/RoutingPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@shared/settings";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { routingPage } from "../helpers/routing-page.js";

// Settings › Routing: Decisions, the models Mandate asks for quick
// judgements, with an On switch; and Manager request check, which runs on Decisions
// unless it has its own route. Decision models are offered only here.

const sel = (model: string, reasoningEffort = "provider-default") => ({ model, reasoningEffort });
const FLASH = "provider-1/deepseek/deepseek-flash";
const LUNA = "provider-1/openai/gpt-6-luna";
const JUDGE = "provider-1/vendor/judge-1";
const ROUTES = ["manager", "worker", "personal", "subagent", "page", "dream", "skillReview", "extraction"];

function config(over: { decisionsEnabled?: boolean; decisions?: ReturnType<typeof sel>[]; managerStopCheckEnabled?: boolean; memoryRepeatCheckEnabled?: boolean } = {}): SettingsConfigResponse {
  const [first, ...rest] = over.decisions ?? [sel(JUDGE), sel(LUNA, "low")];
  return {
    ok: true,
    restartRequired: false,
    models: {
      default: { model: FLASH, reasoningEffort: "high", modelFallbacks: [] },
      providers: {
        "provider-1": {
          type: "openai-compatible", baseURL: "", apiKeyConfigured: true,
          models: [{ id: "deepseek/deepseek-flash", input: ["text"] }, { id: "openai/gpt-6-luna", input: ["text"] }, { id: "vendor/judge-1", input: ["text"], kind: "decision" }]
        }
      }
    },
    agent: {
      modelOverrides: { ...Object.fromEntries(ROUTES.map((route) => [route, false])), managerRequestCheck: false, managerStopCheck: false, memoryRepeatCheck: false },
      ...Object.fromEntries(ROUTES.flatMap((route) => [[`${route}Model`, sel(FLASH, "high")], [`${route}ModelFallbacks`, []]])),
      decisionsEnabled: over.decisionsEnabled ?? true,
      decisionsModel: first ?? sel(""),
      decisionsModelFallbacks: rest,
      managerRequestCheckModel: sel(""),
      managerRequestCheckModelFallbacks: [],
      managerRequestCheckEnabled: true,
      managerStopCheckEnabled: over.managerStopCheckEnabled ?? false,
      managerStopCheckModel: sel(""),
      managerStopCheckModelFallbacks: [],
      memoryRepeatCheckEnabled: over.memoryRepeatCheckEnabled ?? false,
      memoryRepeatCheckModel: sel(""),
      memoryRepeatCheckModelFallbacks: []
    }
  } as unknown as SettingsConfigResponse;
}

/** The config with a patch applied, as the server keeps it. */
function applied(cfg: SettingsConfigResponse, patch: { agent?: Record<string, unknown> }): SettingsConfigResponse {
  const next = structuredClone(cfg) as unknown as { agent: Record<string, unknown> & { modelOverrides: Record<string, boolean> } };
  const agent = patch.agent ?? {};
  for (const key of ["decisionsEnabled", "decisionsModel", "decisionsModelFallbacks", "managerRequestCheckEnabled", "managerStopCheckEnabled", "memoryRepeatCheckEnabled"]) {
    if (key in agent) next.agent[key] = agent[key];
  }
  for (const route of ["managerRequestCheck", "managerStopCheck", "memoryRepeatCheck"]) {
    if (!(`${route}Model` in agent)) continue;
    const own = agent[`${route}Model`] !== null;
    next.agent.modelOverrides = { ...next.agent.modelOverrides, [route]: own };
    next.agent[`${route}Model`] = own ? agent[`${route}Model`] : sel("");
    next.agent[`${route}ModelFallbacks`] = own ? agent[`${route}ModelFallbacks`] : [];
  }
  return next as unknown as SettingsConfigResponse;
}

let host: HTMLElement;
let posts: Array<Record<string, unknown>> = [];
/** Whether the next saves fail. */
let failing = false;

async function render(cfg = config()): Promise<void> {
  posts = [];
  failing = false;
  let current = cfg;
  mockFetch((call: FetchCall) => {
    if (call.url === api.settingsConfig && (call.init?.method ?? "GET") !== "GET") {
      const patch = JSON.parse(String(call.init!.body)) as Record<string, unknown>;
      posts.push(patch);
      if (failing) return jsonResponse({ ok: false, error: "settings file is read-only" }, 500);
      current = applied(current, patch);
      return jsonResponse(current);
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

const { lane, cards, titlesOf, editor, button, openLane, summary, summarySteps } = routingPage(() => host);
const sublines = (route: string) => cards(route).map((card) => card.lastElementChild?.textContent);
const unset = (route: string) => lane(route).querySelector('[data-slot="route-unset"]')?.textContent ?? null;
const decisionsSwitch = () => lane("decisions").querySelector<HTMLButtonElement>('[role="switch"][aria-label="Decisions on"]')!;
const ownRoute = () => lane("managerRequestCheck").querySelector<HTMLButtonElement>('[role="switch"][aria-label="Own route for manager request check"]')!;
const onSwitch = (route: string, label: string) => lane(route).querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
const click = async (el: HTMLElement) => {
  act(() => el.click());
  await settle();
};
async function addMenu(route: string): Promise<string[]> {
  const add = lane(route).querySelector<HTMLButtonElement>('[aria-label="Add a step"]')!;
  act(() => { add.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  const refs = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) => item.getAttribute("data-ref") ?? "");
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  return refs;
}

test("Decisions follows memory extraction, says what it is, and draws its chain; a decision model's card says so, with no effort", async () => {
  await render();
  const routes = Array.from(host.querySelectorAll("[data-route]")).map((el) => el.getAttribute("data-route"));
  expect(routes.slice(-7)).toEqual(["extraction", "decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck", "toolReviewScreen", "toolReviewSecondLook"]);
  await openLane("decisions");
  expect(lane("decisions").querySelector('[data-slot="section-title"]')?.textContent).toBe("Decisions");
  expect(lane("decisions").textContent).toContain("The models Mandate asks for quick judgements. Each use below runs on them unless it has its own.");
  expect([decisionsSwitch().getAttribute("aria-checked"), decisionsSwitch().closest("label")?.textContent]).toEqual(["true", "On"]);
  expect(titlesOf("decisions")).toEqual([JUDGE, LUNA]);
  expect(sublines("decisions")).toStrictEqual(["provider-1 · Decision model", "provider-1 · Low"]);
  expect(cards("decisions")[0]!.getAttribute("aria-label")).toBe(`First choice: ${JUDGE}, decision model`);
});

test("the tool-call review's two lanes: unset, the screen uses Decisions and the second look its chat models only", async () => {
  await render();
  await openLane("toolReviewScreen");
  expect(lane("toolReviewScreen").querySelector('[data-slot="section-title"]')?.textContent).toBe("Tool-call review: screen");
  expect(lane("toolReviewScreen").textContent).toContain("Picks the commands that need a second look. A fast decision model suits it.");
  expect(unset("toolReviewScreen")).toBe("Not set: uses Decisions.");
  await openLane("toolReviewSecondLook");
  expect(lane("toolReviewSecondLook").textContent).toContain("Decides whether a flagged command is held back, and writes the reason the agent reads.");
  expect(unset("toolReviewSecondLook")).toBe("Not set: uses the chat models in Decisions.");
  // Given a route of its own, each starts from what it ran on: the screen
  // from Decisions' chain, the second look from its chat models alone.
  await openLane("toolReviewScreen");
  await click(onSwitch("toolReviewScreen", "Own route for the tool-call review screen"));
  await openLane("toolReviewSecondLook");
  await click(onSwitch("toolReviewSecondLook", "Own route for the tool-call review second look"));
  await openLane("toolReviewScreen");
  expect(titlesOf("toolReviewScreen")).toEqual([JUDGE, LUNA]);
  await openLane("toolReviewSecondLook");
  expect(titlesOf("toolReviewSecondLook")).toEqual([LUNA]);
});

test("with Decisions off, the review's screen says every reviewed command gets a second look", async () => {
  await render(config({ decisionsEnabled: false }));
  await openLane("toolReviewScreen");
  expect(unset("toolReviewScreen")).toBe("Off: every reviewed command gets a second look.");
});

test("Decisions whose first step has no model still runs on its fallback: the screen says it uses Decisions", async () => {
  await render(config({ decisions: [sel(""), sel(LUNA, "low")] }));
  await openLane("toolReviewScreen");
  expect(unset("toolReviewScreen")).toBe("Not set: uses Decisions.");
});

test("a Decisions model whose provider was removed runs nothing: the screen says every reviewed command gets a second look", async () => {
  await render(config({ decisions: [sel("gone/vendor/judge-1")] }));
  await openLane("toolReviewScreen");
  expect(unset("toolReviewScreen")).toBe("Off: every reviewed command gets a second look.");
});

test("with no chat model in Decisions to run on, the second look says the review needs one", async () => {
  for (const cfg of [config({ decisionsEnabled: false }), config({ decisions: [sel(JUDGE)] })]) {
    await render(cfg);
    await openLane("toolReviewSecondLook");
    expect(unset("toolReviewSecondLook")).toBe("Off: the tool-call review needs a chat model here or in Decisions.");
  }
});

test("a saved second-look route shows only its chat models, which are what runs", async () => {
  const cfg = structuredClone(config()) as unknown as { agent: Record<string, unknown> & { modelOverrides: Record<string, boolean> } };
  cfg.agent.modelOverrides = { ...cfg.agent.modelOverrides, toolReviewSecondLook: true };
  cfg.agent.toolReviewSecondLookModel = sel(JUDGE);
  cfg.agent.toolReviewSecondLookModelFallbacks = [sel(LUNA, "low")];
  await render(cfg as unknown as SettingsConfigResponse);
  await openLane("toolReviewSecondLook");
  expect(titlesOf("toolReviewSecondLook")).toEqual([LUNA]);
});

test("a decision step's editor has no effort, a chat step's has; Decisions' menu lists decision models, an agent route's does not", async () => {
  await render();
  await openLane("decisions");
  await click(cards("decisions")[0]!);
  expect(editor()?.textContent?.includes("Reasoning effort")).toBe(false);
  await click(button(editor(), "Done")!);
  await click(cards("decisions")[1]!);
  expect(editor()?.textContent?.includes("Reasoning effort")).toBe(true);
  await click(button(editor(), "Done")!);
  expect(await addMenu("decisions")).toEqual([FLASH, LUNA, JUDGE]);
  await openLane("default");
  expect(await addMenu("default")).toEqual([FLASH, LUNA]);
});

test("the On switch saves Decisions on or off at once, and its chain stays", async () => {
  await render();
  await openLane("decisions");
  await click(decisionsSwitch());
  expect(posts.at(-1)).toEqual({ agent: { decisionsEnabled: false, decisionsModel: sel(JUDGE), decisionsModelFallbacks: [sel(LUNA, "low")] } });
  expect([decisionsSwitch().getAttribute("aria-checked"), titlesOf("decisions").length]).toEqual(["false", 2]);
  await click(decisionsSwitch());
  expect(posts.at(-1)).toEqual({ agent: { decisionsEnabled: true, decisionsModel: sel(JUDGE), decisionsModelFallbacks: [sel(LUNA, "low")] } });
});

test("Decisions on with no model yet runs nothing: Manager request check says it is off", async () => {
  await render(config({ decisions: [] }));
  await openLane("managerRequestCheck");
  expect(unset("managerRequestCheck")).toBe("Off: the personal agent hears when the whole thread stops.");
});

test("a fresh Decisions asks for a model, and its On switch alone sends only the switch", async () => {
  await render(config({ decisionsEnabled: false, decisions: [] }));
  await openLane("decisions");
  expect(cards("decisions").map((card) => card.textContent?.includes("Choose a model"))).toEqual([true]);
  await click(decisionsSwitch());
  expect(posts.at(-1)).toEqual({ agent: { decisionsEnabled: true } });
});

test("a model added to a Decisions chain with no model yet becomes its first choice and is saved", async () => {
  await render(config({ decisionsEnabled: false, decisions: [] }));
  await openLane("decisions");
  const add = lane("decisions").querySelector<HTMLButtonElement>('[aria-label="Add a step"]')!;
  act(() => { add.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  await click(document.querySelector<HTMLElement>(`[role="menuitem"][data-ref="${LUNA}"]`)!);
  expect(posts.at(-1)).toEqual({ agent: { decisionsEnabled: false, decisionsModel: sel(LUNA), decisionsModelFallbacks: [] } });
  expect(titlesOf("decisions")).toEqual([LUNA]);
});

test("a switch the settings file refuses stays as moved, says why and offers Retry, as every change saved at once does", async () => {
  await render();
  failing = true;
  await openLane("decisions");
  await click(decisionsSwitch());
  expect(decisionsSwitch().getAttribute("aria-checked")).toBe("false");
  expect(lane("decisions").querySelector('[data-slot="inline-error"]')?.textContent).toContain("Retry");
  // What runs is still as saved.
  await openLane("managerRequestCheck");
  expect(unset("managerRequestCheck")).toBe("Not set: uses Decisions.");
  failing = false;
  await openLane("decisions");
  await click(button(lane("decisions"), "Retry")!);
  await openLane("managerRequestCheck");
  expect([posts.at(-1), unset("managerRequestCheck")]).toEqual([{ agent: { decisionsEnabled: false, decisionsModel: sel(JUDGE), decisionsModelFallbacks: [sel(LUNA, "low")] } }, "Off: the personal agent hears when the whole thread stops."]);
});

test("Manager request check's own route starts from Decisions' chain, lists decision models, and saves as its own", async () => {
  await render();
  await openLane("managerRequestCheck");
  await click(ownRoute());
  expect([titlesOf("managerRequestCheck"), unset("managerRequestCheck"), posts]).toEqual([[JUDGE, LUNA], null, []]);
  expect(await addMenu("managerRequestCheck")).toEqual([FLASH, LUNA, JUDGE]);
  await click(button(lane("managerRequestCheck"), "Save")!);
  expect(posts.at(-1)).toEqual({ agent: { managerRequestCheckModel: sel(JUDGE), managerRequestCheckModelFallbacks: [sel(LUNA, "low")] } });
  expect([ownRoute().getAttribute("aria-checked"), titlesOf("managerRequestCheck")]).toEqual(["true", [JUDGE, LUNA]]);
  // Decisions is untouched by it.
  expect(posts.some((patch) => "decisionsEnabled" in ((patch.agent ?? {}) as object))).toBe(false);
});

test("with no Decisions model, a model added with + to Manager request check's own route becomes its first choice and saves", async () => {
  await render(config({ decisions: [] }));
  await openLane("managerRequestCheck");
  await click(ownRoute());
  const add = lane("managerRequestCheck").querySelector<HTMLButtonElement>('[aria-label="Add a step"]')!;
  act(() => { add.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await settle();
  await click(document.querySelector<HTMLElement>(`[role="menuitem"][data-ref="${LUNA}"]`)!);
  await click(button(lane("managerRequestCheck"), "Save")!);
  expect(posts.at(-1)).toEqual({ agent: { managerRequestCheckModel: sel(LUNA), managerRequestCheckModelFallbacks: [] } });
  expect(titlesOf("managerRequestCheck")).toEqual([LUNA]);
});

// Each use of Decisions has an On of its own, saved at once as Decisions' is.
test("Manager request check says what it does and uses Decisions; its On switch is on by default and saves at once", async () => {
  await render();
  await openLane("managerRequestCheck");
  expect(lane("managerRequestCheck").querySelector('[data-slot="section-title"]')?.textContent).toBe("Manager request check");
  expect(lane("managerRequestCheck").textContent).toContain("While a manager thread works on, tells the personal agent when a request it sent there is done.");
  expect([unset("managerRequestCheck"), cards("managerRequestCheck").length]).toEqual(["Not set: uses Decisions.", 0]);
  const on = onSwitch("managerRequestCheck", "Manager request check on");
  expect([on.getAttribute("aria-checked"), on.closest("label")?.textContent]).toEqual(["true", "On"]);
  await click(on);
  expect(posts.at(-1)).toEqual({ agent: { managerRequestCheckEnabled: false } });
  expect([on.getAttribute("aria-checked"), unset("managerRequestCheck")]).toEqual(["false", "Off: the personal agent hears when the whole thread stops."]);
});

test("Manager stop check says what it does and is off until switched on; its On switch saves at once", async () => {
  await render();
  await openLane("managerStopCheck");
  expect(lane("managerStopCheck").querySelector('[data-slot="section-title"]')?.textContent).toBe("Manager stop check");
  expect(lane("managerStopCheck").textContent).toContain("When a manager thread stops, sorts what its last reply leaves for you: a decision, a result to read, or nothing.");
  expect([onSwitch("managerStopCheck", "Manager stop check on").getAttribute("aria-checked"), unset("managerStopCheck")]).toEqual(["false", "Off: no thread turns blue."]);
  await click(onSwitch("managerStopCheck", "Manager stop check on"));
  expect(posts.at(-1)).toEqual({ agent: { managerStopCheckEnabled: true } });
  expect([onSwitch("managerStopCheck", "Manager stop check on").getAttribute("aria-checked"), unset("managerStopCheck")]).toEqual(["true", "Not set: uses Decisions."]);
  // With Decisions off it has nothing to run on.
  await openLane("decisions");
  await click(decisionsSwitch());
  await openLane("managerStopCheck");
  expect(unset("managerStopCheck")).toBe("Off: no thread turns blue.");
});

test("Manager stop check's own route starts from Decisions' chain, lists decision models, and saves as its own", async () => {
  await render(config({ managerStopCheckEnabled: true }));
  await openLane("managerStopCheck");
  await click(onSwitch("managerStopCheck", "Own route for manager stop check"));
  expect(titlesOf("managerStopCheck")).toEqual([JUDGE, LUNA]);
  expect(await addMenu("managerStopCheck")).toEqual([FLASH, LUNA, JUDGE]);
  await click(button(lane("managerStopCheck"), "Save")!);
  expect(posts.at(-1)).toEqual({ agent: { managerStopCheckModel: sel(JUDGE), managerStopCheckModelFallbacks: [sel(LUNA, "low")] } });
});

test("Memory repeat check says what it does and is off until switched on; its On switch saves at once", async () => {
  await render();
  await openLane("memoryRepeatCheck");
  expect(lane("memoryRepeatCheck").querySelector('[data-slot="section-title"]')?.textContent).toBe("Memory repeat check");
  expect(lane("memoryRepeatCheck").textContent).toContain("Before memory extraction stores a memory, reads the stored ones most like it, and leaves it out when one already says it.");
  expect([onSwitch("memoryRepeatCheck", "Memory repeat check on").getAttribute("aria-checked"), unset("memoryRepeatCheck")]).toEqual(["false", "Off: memory extraction stores every memory it picks."]);
  await click(onSwitch("memoryRepeatCheck", "Memory repeat check on"));
  expect(posts.at(-1)).toEqual({ agent: { memoryRepeatCheckEnabled: true } });
  expect([onSwitch("memoryRepeatCheck", "Memory repeat check on").getAttribute("aria-checked"), unset("memoryRepeatCheck")]).toEqual(["true", "Not set: uses Decisions."]);
  await openLane("decisions");
  await click(decisionsSwitch());
  await openLane("memoryRepeatCheck");
  expect(unset("memoryRepeatCheck")).toBe("Off: memory extraction stores every memory it picks.");
});

test("Memory repeat check's own route starts from Decisions' chain, lists decision models, and saves as its own", async () => {
  await render(config({ memoryRepeatCheckEnabled: true }));
  await openLane("memoryRepeatCheck");
  await click(onSwitch("memoryRepeatCheck", "Own route for memory repeat check"));
  expect(titlesOf("memoryRepeatCheck")).toEqual([JUDGE, LUNA]);
  expect(await addMenu("memoryRepeatCheck")).toEqual([FLASH, LUNA, JUDGE]);
  await click(button(lane("memoryRepeatCheck"), "Save")!);
  expect(posts.at(-1)).toEqual({ agent: { memoryRepeatCheckModel: sel(JUDGE), memoryRepeatCheckModelFallbacks: [sel(LUNA, "low")] } });
});

test("Decisions and its uses: each row says what runs", async () => {
  await render();
  expect(summarySteps("decisions")).toEqual([[JUDGE, ""], [LUNA, "Low"]]);
  expect(summary("managerRequestCheck")).toBe("Decisions");
  expect(summary("managerStopCheck")).toBe("Off");
  expect(summary("memoryRepeatCheck")).toBe("Off");
  expect(summary("toolReviewScreen")).toBe("Decisions");
  expect(summary("toolReviewSecondLook")).toBe("Decisions' chat models");
});

test("with Decisions off, Decisions and every use without a route of its own read Off", async () => {
  await render(config({ decisionsEnabled: false, managerStopCheckEnabled: true, memoryRepeatCheckEnabled: true }));
  for (const route of ["decisions", "managerRequestCheck", "managerStopCheck", "memoryRepeatCheck", "toolReviewScreen", "toolReviewSecondLook"]) {
    expect(summary(route)).toBe("Off");
  }
});

test("a use with a route of its own reads its chain; switched off, Off", async () => {
  const own = (enabled: boolean) => {
    const cfg = config();
    const agent = cfg.agent as unknown as Record<string, unknown>;
    agent.modelOverrides = { ...(agent.modelOverrides as object), managerRequestCheck: true };
    agent.managerRequestCheckModel = sel(LUNA, "low");
    agent.managerRequestCheckEnabled = enabled;
    return cfg;
  };
  await render(own(true));
  expect(summarySteps("managerRequestCheck")).toEqual([[LUNA, "Low"]]);
  await render(own(false));
  expect(summary("managerRequestCheck")).toBe("Off");
});
