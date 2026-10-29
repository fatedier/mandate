import { expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { api } from "@/lib/api-paths";
import { SettingsPage } from "@/routes/settings/SettingsPage";
import { jsonResponse, withFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settleUntil, settleRounds } from "../helpers/mount.js";

// Adding models to a provider: its own list, searchable and grouped by
// vendor when it serves several, models already added ticked and locked,
// any id it doesn't list added by hand; Add saves the ticked ones to the
// provider at once.

let container: HTMLElement | null = null;

function render(node: ReactNode): void {
  container = mount(node).host;
}

function mockConfig() {
  return {
    ok: true,
    restartRequired: false,
    models: {
      default: { model: "claude/claude-opus-4-7", reasoningEffort: "medium", modelFallbacks: [] },
      prices: { autoUpdate: true },
      providers: {
        claude: {
          type: "anthropic",
          baseURL: "https://api.anthropic.com",
          models: [{ id: "claude-opus-4-7", input: ["text", "image"], supportsReasoning: true }],
          apiKeyConfigured: true
        }
      }
    },
    memory: { embedding: { model: "" } },
    agent: {
      preferences: "",
      logRequests: "metadata",
      modelOverrides: { manager: false, worker: false, global: false },
      managerModel: { model: "claude/claude-opus-4-7", reasoningEffort: "medium" },
      managerModelFallbacks: [],
      workerModel: { model: "claude/claude-opus-4-7", reasoningEffort: "medium" },
      workerModelFallbacks: [], globalModel: { model: "claude/claude-opus-4-7", reasoningEffort: "medium" }, globalModelFallbacks: []
    }
  };
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, input: ["text", "image"], contextLength: null, outputModalities: [], supportedParameters: [], ...extra
});

const LISTED = [
  item("claude-opus-4-7", { supportsReasoning: true }),
  item("claude-sonnet-4-6", { input: ["text"], declared: { image: false, reasoning: true } })
];

async function withProviderPage(
  run: (ctx: { saved: unknown[]; calls: FetchCall[] }) => Promise<void>,
  opts: { source?: string; models?: unknown[]; failFirstCatalog?: boolean; refreshedModels?: unknown[]; holdCatalog?: boolean } = {}
): Promise<void> {
  const saved: unknown[] = [];
  let catalogCalls = 0;
  // What the server holds: a save's models, as the real one answers with them.
  let current = mockConfig();
  await withFetch(({ url, init }) => {
    if (url.startsWith(api.settingsProviderModels("claude"))) {
      catalogCalls += 1;
      if (opts.failFirstCatalog && catalogCalls === 1) throw new Error("backend restarting");
      if (opts.holdCatalog) return new Promise<Response>(() => {});
      const refreshed = url.includes("refresh=1") && opts.refreshedModels;
      return jsonResponse({ ok: true, providerName: "claude", providerType: "anthropic", source: opts.source ?? "live", cached: false, models: refreshed || opts.models || LISTED });
    }
    if (url === api.settingsConfig && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { models: { providers: { claude: { models: unknown[] } } } };
      saved.push(body);
      current = { ...current, models: { ...current.models, providers: { claude: { ...current.models.providers.claude, models: body.models.providers.claude.models as typeof current.models.providers.claude.models } } } };
      return jsonResponse(current);
    }
    if (url === api.settingsConfig) return jsonResponse(current);
    if (url.endsWith("/check")) return jsonResponse({ ok: true, providerName: "claude", result: "ready", modelCount: 2, checkedAt: "2026-01-01T00:00:00.000Z" });
    return jsonResponse({ ok: true, models: [] });
  }, async (calls) => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=providers"]}>
        <SettingsPage />
      </MemoryRouter>
    );
    await settleUntil(() => !!container!.querySelector('[data-provider-row="claude"]'), "providers list");
    act(() => container!.querySelector<HTMLElement>('[data-provider-row="claude"]')!.click());
    await settleRounds(4);
    await run({ saved, calls });
  });
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (scope: ParentNode | null, text: string) =>
  Array.from(scope?.querySelectorAll<HTMLButtonElement>("button") ?? []).find((b) => b.textContent?.trim() === text);
const catalogIds = () => Array.from(dialog()?.querySelectorAll("[data-catalog-item]") ?? []).map((el) => el.getAttribute("data-catalog-item"));
const tick = (id: string) => act(() => dialog()!.querySelector<HTMLInputElement>(`[data-catalog-item="${id}"] input[type="checkbox"]`)!.click());
const modelRows = () => Array.from(container!.querySelectorAll("[data-model-row]")).map((el) => el.getAttribute("data-model-row"));

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  });
}

async function openAdd(): Promise<void> {
  act(() => button(container, "Add models")!.click());
  await settleRounds(4);
}

async function openEdit(id: string): Promise<HTMLElement> {
  act(() => container!.querySelector<HTMLElement>(`[data-model-row="${id}"] button`)!.click());
  await settleRounds(4);
  return dialog()!;
}

const switchOn = (scope: HTMLElement, label: string) =>
  scope.querySelector(`[role="switch"][aria-label="${label}"]`)!.getAttribute("aria-checked") === "true";

test("the provider's list, models already added ticked and locked; Add saves the ticked ones at once", async () => {
  await withProviderPage(async ({ saved }) => {
    await openAdd();
    expect(catalogIds()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
    const opus = dialog()!.querySelector<HTMLInputElement>('[data-catalog-item="claude-opus-4-7"] input')!;
    expect([opus.checked, opus.disabled]).toEqual([true, true]);
    expect(dialog()!.querySelector('[data-catalog-item="claude-opus-4-7"]')!.textContent).toContain("added");
    expect(button(dialog(), "Add models")!.disabled).toBe(true);
    tick("claude-sonnet-4-6");
    act(() => button(dialog(), "Add 1 model")!.click());
    await settleRounds(4);
    expect(dialog() === null).toBe(true);
    expect(modelRows()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
    expect((saved as Array<{ models: { providers: { claude: { models: Array<{ id: string }> } } } }>).map((patch) => patch.models.providers.claude.models.map((m) => m.id)))
      .toEqual([["claude-opus-4-7", "claude-sonnet-4-6"]]);
    expect(container!.querySelector('[data-slot="provider-save-bar"]') === null).toBe(true);
  });
});

test("a model its list declares text-only is added with Image input off, Reasoning on, and says the values came from the list", async () => {
  await withProviderPage(async () => {
    await openAdd();
    tick("claude-sonnet-4-6");
    act(() => button(dialog(), "Add 1 model")!.click());
    await settleRounds(4);
    const edit = await openEdit("claude-sonnet-4-6");
    expect([switchOn(edit, "Image input"), switchOn(edit, "Reasoning")]).toEqual([false, true]);
    expect(edit.querySelector("[data-cap-note]")?.textContent).toBe("From claude's model list");
  });
});

test("an id the provider doesn't list is added by hand, with image input and reasoning on; Enter adds it as Add does", async () => {
  await withProviderPage(async () => {
    await openAdd();
    const byId = dialog()!.querySelector<HTMLInputElement>("input[data-custom-model]")!;
    typeInto(byId, "my-gateway-model");
    act(() => button(dialog(), "Add")!.click());
    await settleRounds(4);
    expect(byId.value).toBe("");
    typeInto(byId, "my-other-model");
    act(() => { byId.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await settleRounds(4);
    expect(catalogIds().slice(0, 2)).toEqual(["my-gateway-model", "my-other-model"]);
    // An id already there cannot be added twice.
    typeInto(byId, "claude-opus-4-7");
    expect(button(dialog(), "Add")!.disabled).toBe(true);
    act(() => button(dialog(), "Add 2 models")!.click());
    await settleRounds(4);
    expect(modelRows()).toEqual(["claude-opus-4-7", "my-gateway-model", "my-other-model"]);
    const edit = await openEdit("my-gateway-model");
    expect([switchOn(edit, "Image input"), switchOn(edit, "Reasoning")]).toEqual([true, true]);
  });
});

test("with no list to go by (its fetch failed), an id already on the provider still cannot be added twice", async () => {
  await withProviderPage(async () => {
    await openAdd();
    expect(catalogIds()).toEqual([]);
    typeInto(dialog()!.querySelector<HTMLInputElement>("input[data-custom-model]")!, "claude-opus-4-7");
    expect(button(dialog(), "Add")!.disabled).toBe(true);
  }, { failFirstCatalog: true });
});

test("the search narrows the list to the ids that contain it, in any case", async () => {
  await withProviderPage(async () => {
    await openAdd();
    const search = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    expect(search.placeholder).toBe("Search 2 models");
    typeInto(search, "SONNET");
    await settleRounds(4);
    expect(catalogIds()).toEqual(["claude-sonnet-4-6"]);
  });
});

test("a list of several vendors is grouped under their names", async () => {
  await withProviderPage(async () => {
    await openAdd();
    expect(Array.from(dialog()!.querySelectorAll("[data-catalog-group]")).map((el) => el.textContent)).toEqual(["Anthropic2", "OpenAI1"]);
  }, { models: [item("anthropic/model-a"), item("openai/model-b"), item("anthropic/model-c")] });
});

test("one vendor's list has no group headings", async () => {
  await withProviderPage(async () => {
    await openAdd();
    expect(dialog()!.querySelectorAll("[data-catalog-group]").length).toBe(0);
  });
});

test("where the list came from, and Refresh asks the provider again", async () => {
  await withProviderPage(async ({ calls }) => {
    await openAdd();
    expect(dialog()!.textContent).toContain("Listed by claude.");
    act(() => button(dialog(), "Refresh")!.click());
    await settleRounds(4);
    expect(calls.some((c) => c.url === api.settingsProviderModels("claude", { refresh: true }))).toBe(true);
  });
});

test("a provider that didn't list its models says so", async () => {
  await withProviderPage(async () => {
    await openAdd();
    expect(dialog()!.textContent).toContain("claude didn't list its models — add one by id.");
  }, { source: "configured" });
});

// The line said "didn't list its models" for Codex's own list, which is
// not a listing, and while the first list was still on its way.
test("Codex's built-in list says what it is", async () => {
  await withProviderPage(async () => {
    await openAdd();
    expect(dialog()!.textContent).toContain("The models Codex offers.");
    expect(dialog()!.textContent).not.toContain("didn't list");
  }, { source: "builtin" });
});

test("while the provider's list is on its way, the line says it is being asked", async () => {
  await withProviderPage(async () => {
    await openAdd();
    expect(dialog()!.textContent).toContain("Asking claude for its models…");
    expect(dialog()!.textContent).not.toContain("didn't list");
  }, { holdCatalog: true });
});

test("a failed catalog fetch retries the next time the provider opens instead of pinning empty", async () => {
  await withProviderPage(async ({ calls }) => {
    const catalogCalls = () => calls.filter((c) => c.url.startsWith(api.settingsProviderModels("claude"))).length;
    expect(catalogCalls()).toBe(1);
    act(() => button(container, "Providers")!.click());
    await settleRounds(4);
    act(() => container!.querySelector<HTMLElement>('[data-provider-row="claude"]')!.click());
    await settleRounds(4);
    expect(catalogCalls()).toBe(2);
    await openAdd();
    expect(catalogIds()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  }, { failFirstCatalog: true });
});

test("Cancel adds nothing", async () => {
  await withProviderPage(async () => {
    await openAdd();
    tick("claude-sonnet-4-6");
    act(() => button(dialog(), "Cancel")!.click());
    await settleRounds(4);
    expect(modelRows()).toEqual(["claude-opus-4-7"]);
    expect(container!.querySelector('[data-slot="provider-save-bar"]') === null).toBe(true);
    // Opened again, it starts empty.
    await openAdd();
    expect(dialog()!.querySelector<HTMLInputElement>('[data-catalog-item="claude-sonnet-4-6"] input')!.checked).toBe(false);
  });
});

test("saving writes explicit capabilities, including reasoning turned off", async () => {
  await withProviderPage(async ({ saved }) => {
    const edit = await openEdit("claude-opus-4-7");
    act(() => edit.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Reasoning"]')!.click());
    act(() => button(edit, "Save")!.click());
    await settleUntil(() => saved.length > 0, "a saved patch");
    const patch = saved.at(-1) as { models: { providers: { claude: { models: unknown[] } } } };
    expect(patch.models.providers.claude.models).toEqual([{ id: "claude-opus-4-7", input: ["text", "image"], supportsReasoning: false }]);
  });
});

test("a picked model the refreshed list no longer has is not counted, and nothing is added for it", async () => {
  await withProviderPage(async () => {
    await openAdd();
    tick("claude-sonnet-4-6");
    expect(button(dialog(), "Add 1 model")).toBeDefined();
    act(() => button(dialog(), "Refresh")!.click());
    await settleRounds(4);
    expect(catalogIds()).toEqual(["claude-opus-4-7"]);
    expect(button(dialog(), "Add models")!.disabled).toBe(true);
  }, { refreshedModels: [LISTED[0]] });
});

test("an id added by hand that the list then shows is one model, ticked, added once", async () => {
  await withProviderPage(async () => {
    await openAdd();
    typeInto(dialog()!.querySelector<HTMLInputElement>("input[data-custom-model]")!, "claude-sonnet-4-6");
    act(() => button(dialog(), "Add")!.click());
    await settleRounds(4);
    act(() => button(dialog(), "Refresh")!.click());
    await settleRounds(4);
    expect(catalogIds()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
    expect(dialog()!.querySelector<HTMLInputElement>('[data-catalog-item="claude-sonnet-4-6"] input')!.checked).toBe(true);
    act(() => button(dialog(), "Add 1 model")!.click());
    await settleRounds(4);
    expect(modelRows()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
    // Taken from the list, it carries what the list declares.
    const edit = await openEdit("claude-sonnet-4-6");
    expect(switchOn(edit, "Image input")).toBe(false);
  }, { failFirstCatalog: true });
});

test("after a key is fixed and saved, Add models reads the provider's list again", async () => {
  let keyFixed = false;
  const saved: unknown[] = [];
  await withFetch(({ url, init }) => {
    if (url.startsWith(api.settingsProviderModels("claude"))) {
      return jsonResponse(keyFixed
        ? { ok: true, providerName: "claude", providerType: "anthropic", source: "live", cached: false, models: LISTED }
        : { ok: true, providerName: "claude", providerType: "anthropic", source: "configured", cached: false, models: [LISTED[0]] });
    }
    if (url === api.settingsConfig && init?.method === "POST") {
      saved.push(JSON.parse(String(init.body)));
      keyFixed = true;
      return jsonResponse(mockConfig());
    }
    if (url === api.settingsConfig) return jsonResponse(mockConfig());
    if (url.endsWith("/check")) return jsonResponse({ ok: true, providerName: "claude", result: "ready", modelCount: 2, checkedAt: "2026-01-01T00:00:00.000Z" });
    return jsonResponse({ ok: true, models: [] });
  }, async () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=providers&provider=claude"]}>
        <SettingsPage />
      </MemoryRouter>
    );
    await settleUntil(() => !!container!.querySelector('[data-slot="provider-page"]'), "provider page");
    await settleRounds(4);
    act(() => button(container, "Replace")!.click());
    typeInto(container!.querySelector<HTMLInputElement>('input[aria-label="API key"]')!, "sk-fixed");
    act(() => button(container!.querySelector('[data-slot="provider-save-bar"]'), "Save")!.click());
    await settleUntil(() => saved.length > 0, "the save");
    await settleRounds(4);
    await openAdd();
    expect(dialog()!.textContent).toContain("Listed by claude.");
    expect(catalogIds()).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });
});

test("two saves in a row: the list read for the earlier one, arriving last, does not replace the later one's", async () => {
  const held: Array<(models: unknown[]) => void> = [];
  let catalogCalls = 0;
  await withFetch(({ url, init }) => {
    if (url.startsWith(api.settingsProviderModels("claude"))) {
      catalogCalls += 1;
      if (catalogCalls === 1) return jsonResponse({ ok: true, providerName: "claude", providerType: "anthropic", source: "live", cached: false, models: [LISTED[0]] });
      return new Promise((resolve) => {
        held.push((models) => resolve(jsonResponse({ ok: true, providerName: "claude", providerType: "anthropic", source: "live", cached: false, models })));
      });
    }
    if (url === api.settingsConfig && init?.method === "POST") return jsonResponse(mockConfig());
    if (url === api.settingsConfig) return jsonResponse(mockConfig());
    if (url.endsWith("/check")) return jsonResponse({ ok: true, providerName: "claude", result: "ready", modelCount: 2, checkedAt: "2026-01-01T00:00:00.000Z" });
    return jsonResponse({ ok: true, models: [] });
  }, async () => {
    render(
      <MemoryRouter initialEntries={["/settings?tab=providers&provider=claude"]}>
        <SettingsPage />
      </MemoryRouter>
    );
    await settleUntil(() => !!container!.querySelector('[data-slot="provider-page"]'), "provider page");
    await settleRounds(4);
    const saveWith = async (address: string) => {
      typeInto(container!.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!, address);
      act(() => button(container!.querySelector('[data-slot="provider-save-bar"]'), "Save")!.click());
      await settleRounds(4);
    };
    await saveWith("https://first.example");
    await saveWith("https://second.example");
    expect(held.length).toBe(2);
    held[1]!([item("model-second")]);
    await settleRounds(4);
    held[0]!([item("model-first")]);
    await settleRounds(4);
    await openAdd();
    expect(catalogIds()).toEqual(["model-second"]);
  });
});
