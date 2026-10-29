import { describe, expect, test } from "bun:test";
import { act } from "react";
import { useLocation, useNavigate, type NavigateFunction } from "react-router";
import { api } from "@/lib/api-paths";
import { ProvidersPane } from "@/routes/settings/ProvidersPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import { useSettingsConfig } from "@/routes/settings/settings-config";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { jsonResponse, withFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settleRounds } from "../helpers/mount.js";

// Settings › Providers: a list of providers, each opening a page of its own
// (?provider=<name>), with its check, its connection and its models; each
// provider saves on its own and a save sends the whole providers record.
// What is done to a saved provider's models is saved at once; its
// connection waits for the page's Save.

let container: HTMLElement | null = null;
let search = "";
let navigate: NavigateFunction = () => {};

function Where() {
  search = useLocation().search;
  navigate = useNavigate();
  return null;
}

let reloadSettings: () => Promise<void> = async () => {};

/** Settings' Refresh, which lives in the page header. */
function Reloader() {
  reloadSettings = useSettingsConfig().reload;
  return null;
}

function render(path = "/settings?tab=providers"): void {
  container = mount(
    <>
      <SettingsConfigProvider>
        <ProvidersPane />
        <Reloader />
      </SettingsConfigProvider>
      <Where />
    </>,
    { path }
  ).host;
}

type ProviderFixture = Record<string, unknown>;

/** Only the fields the pane reads; the cast keeps the fixtures small. */
function mockConfig(providers: Record<string, ProviderFixture>, defaultModel = "", embeddingModel = ""): SettingsConfigResponse {
  const selection = { model: defaultModel, reasoningEffort: "provider-default" };
  return {
    ok: true,
    restartRequired: false,
    models: { default: { ...selection, modelFallbacks: [] }, prices: { autoUpdate: true }, providers },
    memory: { embedding: { model: embeddingModel } },
    agent: {
      modelOverrides: { manager: false, worker: false, global: false },
      managerModel: selection,
      managerModelFallbacks: [],
      workerModel: selection,
      workerModelFallbacks: [], globalModel: selection, globalModelFallbacks: []
    }
  } as unknown as SettingsConfigResponse;
}

function openaiFixture(baseURL = "https://api.openai.com/v1"): ProviderFixture {
  return { type: "openai", baseURL, models: [{ id: "gpt-5", input: ["text"] }], apiKeyConfigured: true };
}

function anthropicFixture(): ProviderFixture {
  return { type: "anthropic", baseURL: "https://api.anthropic.com/v1", models: [{ id: "claude-opus-4", input: ["text", "image"] }], apiKeyConfigured: true };
}

function proxyFixture(apiKeyConfigured = false): ProviderFixture {
  return {
    type: "openai-compatible",
    baseURL: "http://127.0.0.1:9/v1",
    models: [{ id: "model-a", input: ["text"] }, { id: "model-b", input: ["text"] }],
    apiKeyConfigured
  };
}

function codexFixture(): ProviderFixture {
  return {
    type: "codex",
    baseURL: "",
    serviceTier: "",
    models: [{ id: "gpt-5.5", input: ["text"] }],
    apiKeyConfigured: false,
    auth: { status: "authenticated", configured: true, accountId: "acc", email: "dev@example.com", profileId: "p" }
  };
}

function emptyCatalog(): Record<string, unknown> {
  return { ok: true, providerName: "openai", providerType: "openai", source: "configured", cached: false, models: [] };
}

const READY = { ok: true, result: "ready", modelCount: 3, checkedAt: "2026-01-01T00:00:00.000Z" };

/** Every request the pane makes besides the config: checks answer ready, catalogs empty. */
function others(call: FetchCall): Response {
  if (call.url.endsWith("/check")) return jsonResponse({ ...READY, providerName: decodeURIComponent(call.url.split("/").at(-2)!) });
  return jsonResponse(emptyCatalog());
}

const isConfig = (call: FetchCall) => call.url === api.settingsConfig;
const isPost = (call: FetchCall) => (call.init?.method ?? "GET") !== "GET";
const checksIn = (calls: FetchCall[]) =>
  calls.filter((c) => c.url.endsWith("/check")).map((c) => [decodeURIComponent(c.url.split("/").at(-2)!), JSON.parse(String(c.init!.body)).maxAgeMs]);

const rows = () => Array.from(container!.querySelectorAll<HTMLElement>("[data-provider-row]"));
const row = (name: string) => container!.querySelector<HTMLElement>(`[data-provider-row="${name}"]`);
const page = () => container!.querySelector<HTMLElement>('[data-slot="provider-page"]');
const saveBar = () => container!.querySelector<HTMLElement>('[data-slot="provider-save-bar"]');
const buttonsOf = (scope: ParentNode) => Array.from(scope.querySelectorAll<HTMLButtonElement>("button"));
const button = (scope: ParentNode, text: string) => buttonsOf(scope).find((el) => el.textContent?.trim() === text);
const input = (scope: ParentNode, label: string) => scope.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const inputWithValue = (scope: ParentNode, value: string) => Array.from(scope.querySelectorAll("input")).find((el) => el.value === value);

function click(el: HTMLElement): void {
  act(() => el.click());
}

function changeInput(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
  });
}

async function open(name: string): Promise<HTMLElement> {
  click(row(name)!);
  await settleRounds();
  return page()!;
}

async function back(): Promise<void> {
  click(button(page()!, "Providers")!);
  await settleRounds();
}

async function addProvider(title = "OpenAI compatible"): Promise<void> {
  click(buttonsOf(container!).find((el) => (el.textContent ?? "").includes("Add provider"))!);
  await settleRounds();
  const dialog = document.querySelector('[role="dialog"]')!;
  click(buttonsOf(dialog).find((el) => (el.textContent ?? "").includes(title))!);
  await settleRounds();
}

async function openMenu(): Promise<void> {
  const trigger = page()!.querySelector<HTMLButtonElement>('[aria-label="Provider actions"]')!;
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await settleRounds();
}

async function openModelMenu(modelId: string): Promise<void> {
  const trigger = page()!.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${modelId}"]`)!;
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await settleRounds();
}

const menuItem = (text: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent?.trim() === text);

/** The InlineError a page's save bar shows: its sentence and the small line below. */
function footerError(scope: HTMLElement | null): { message: string; detail: string | null } | null {
  const el = scope?.querySelector('[data-slot="inline-error"]');
  if (!el) return null;
  return { message: el.querySelector("span")?.textContent ?? "", detail: el.querySelector("p")?.textContent ?? null };
}

describe("the Providers list", () => {
  test("one row per provider: its type in words, its models, its use in Routing and its status; no form", async () => {
    await withFetch(
      (call) => isConfig(call)
        ? jsonResponse(mockConfig({ openai: openaiFixture(), codex: codexFixture(), proxy: proxyFixture() }, "proxy/model-a"))
        : others(call),
      async () => {
        render();
        await settleRounds();
        expect(rows().map((el) => el.dataset.providerRow)).toStrictEqual(["openai", "codex", "proxy"]);
        const text = (name: string) => row(name)!.textContent;
        expect(text("openai")).toContain("OpenAI API · 1 model");
        expect(text("openai")).toContain("Ready");
        expect(text("codex")).toContain("OpenAI Codex · 1 model");
        expect(text("codex")).toContain("Signed in");
        expect(text("proxy")).toContain("OpenAI compatible · 2 models · default model");
        expect(text("proxy")).toContain("No key");
        expect(container!.textContent).not.toContain("Base URL");
        expect(page() === null).toBe(true);
      }
    );
  });

  test("opening the list checks each saved provider with a key, at most an hour old; none for Codex or one without a key", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture(), codex: codexFixture(), proxy: proxyFixture() })) : others(call),
      async (calls) => {
        render();
        await settleRounds();
        expect(checksIn(calls)).toEqual([["openai", 3_600_000]]);
      }
    );
  });

  test("a row opens the provider's page in the URL; Providers goes back to the list", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() })) : others(call),
      async () => {
        render();
        await settleRounds();
        const opened = await open("openai");
        expect(new URLSearchParams(search).get("provider")).toBe("openai");
        expect(opened.querySelector('[data-slot="provider-title"]')?.textContent).toBe("openai");
        expect(opened.textContent).toContain("Connection");
        expect(opened.textContent).toContain("Models");
        expect(rows().length).toBe(0);
        await back();
        expect(new URLSearchParams(search).get("provider")).toBeNull();
        expect(rows().length).toBe(2);
      }
    );
  });

  test("the device's Back from a provider's page returns to the list", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture() })) : others(call),
      async () => {
        render();
        await settleRounds();
        await open("openai");
        act(() => { void navigate(-1); });
        await settleRounds();
        expect(page() === null).toBe(true);
        expect(new URLSearchParams(search).get("provider")).toBeNull();
        expect(rows().length).toBe(1);
      }
    );
  });

  test("a link to a provider that does not exist shows the list, and the link goes", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture() })) : others(call),
      async () => {
        render("/settings?tab=providers&provider=nobody");
        await settleRounds();
        expect(page() === null).toBe(true);
        expect(rows().length).toBe(1);
        expect(new URLSearchParams(search).get("provider")).toBeNull();
        expect(new URLSearchParams(search).get("tab")).toBe("providers");
      }
    );
  });

  // Made elsewhere (another tab, the config file) and read by Refresh: the
  // list does not open it by itself.
  test("a provider made later under a link's name does not open from that link", async () => {
    let made = false;
    await withFetch(
      (call) => isConfig(call)
        ? jsonResponse(mockConfig(made ? { openai: openaiFixture(), later: openaiFixture() } : { openai: openaiFixture() }))
        : others(call),
      async () => {
        render("/settings?tab=providers&provider=later");
        await settleRounds();
        made = true;
        await act(async () => { await reloadSettings(); });
        await settleRounds();
        expect(page() === null).toBe(true);
        expect(rows().length).toBe(2);
      }
    );
  });

  test("a link to a provider that did not exist leaves no way back to one that does later", async () => {
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        return jsonResponse(mockConfig({ openai: openaiFixture(), provider: { type: "openai-compatible", baseURL: "", models: [], apiKeyConfigured: false } }));
      },
      async () => {
        render("/settings?tab=providers&provider=provider");
        await settleRounds();
        await addProvider();
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(new URLSearchParams(search).get("provider")).toBe("provider");
        await back();
        expect(page() === null).toBe(true);
        expect(new URLSearchParams(search).get("provider")).toBeNull();
      }
    );
  });

  test("a saved provider opened by its link shows its page", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture() })) : others(call),
      async () => {
        render("/settings?tab=providers&provider=openai");
        await settleRounds();
        expect(page()?.querySelector('[data-slot="provider-title"]')?.textContent).toBe("openai");
        // Opened directly, Providers still leads to the list.
        await back();
        expect(rows().length).toBe(1);
      }
    );
  });
});

describe("a provider's page", () => {
  test("Check asks for a fresh check; it waits for a save while the connection has unsaved changes", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture() })) : others(call),
      async (calls) => {
        render();
        await settleRounds();
        const opened = await open("openai");
        click(button(opened, "Check")!);
        await settleRounds();
        expect(checksIn(calls).at(-1)).toEqual(["openai", 0]);
        expect(opened.textContent).toContain("Ready — the key works and 3 models are listed.");
        // Waiting for a save, the button says so itself: a title on a
        // disabled button shows to no pointer and no touch. Each connection
        // edit makes it wait; undone, Check is back.
        const waiting = () => {
          const check = buttonsOf(page()!).find((el) => ["Check", "Save to check"].includes(el.textContent?.trim() ?? ""))!;
          return [check.textContent?.trim(), check.disabled, check.hasAttribute("title")];
        };
        const address = inputWithValue(page()!, "https://api.openai.com/v1")!;
        changeInput(address, "https://proxy.example/v1");
        expect(waiting()).toEqual(["Save to check", true, false]);
        changeInput(address, "https://api.openai.com/v1");
        expect(waiting()).toEqual(["Check", false, false]);
        click(button(page()!, "Replace")!);
        changeInput(input(page()!, "API key")!, "sk-new");
        expect(waiting()).toEqual(["Save to check", true, false]);
        click(button(page()!, "Cancel")!);
        expect(waiting()).toEqual(["Check", false, false]);
        click(button(page()!, "Remove")!);
        expect(waiting()).toEqual(["Save to check", true, false]);
        click(button(page()!, "Undo")!);
        expect(waiting()).toEqual(["Check", false, false]);
      }
    );
  });

  test("a Kilo provider's Organization ID is part of what a check reads: edited, Check waits for a save", async () => {
    await withFetch(
      (call) => isConfig(call)
        ? jsonResponse(mockConfig({ kilo: { type: "kilo", baseURL: "", organizationId: "org-1", models: [{ id: "kilo-auto", input: ["text"] }], apiKeyConfigured: true } }))
        : others(call),
      async () => {
        render();
        await settleRounds();
        const opened = await open("kilo");
        changeInput(input(opened, "Organization ID")!, "org-2");
        expect(button(page()!, "Save to check")?.disabled).toBe(true);
      }
    );
  });

  // A check run for a provider with no key comes back unchecked, and the
  // page showed nothing: Check looked like it did nothing.
  test("Check on a provider with no key saved says it was not checked, and why", async () => {
    await withFetch(
      (call) => {
        if (isConfig(call)) return jsonResponse(mockConfig({ proxy: proxyFixture(false) }));
        if (call.url.endsWith("/check")) return jsonResponse({ ok: true, providerName: "proxy", result: "unchecked", reason: "no-key" });
        return others(call);
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("proxy");
        click(button(opened, "Check")!);
        await settleRounds();
        const line = page()!.querySelector('[data-slot="provider-check"]');
        expect(line?.textContent).toBe("Not checked — no API key is saved.");
      }
    );
  });

  test("a provider whose saved address changed elsewhere is checked again, and the old answer is not shown for it", async () => {
    let baseURL = "https://api.openai.com/v1";
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture(baseURL) })) : others(call),
      async (calls) => {
        render();
        await settleRounds();
        expect(checksIn(calls)).toEqual([["openai", 3_600_000]]);
        // Another tab saved a new address; Settings' Refresh reads it.
        baseURL = "https://moved.example/v1";
        await act(async () => { await reloadSettings(); });
        await settleRounds();
        expect(checksIn(calls)).toEqual([["openai", 3_600_000], ["openai", 3_600_000]]);
        const opened = await open("openai");
        expect(opened.querySelector('[data-slot="provider-check"]')?.textContent).toContain("Ready");
        // Changed again while its page is open: the old answer goes.
        baseURL = "https://moved-again.example/v1";
        await act(async () => { await reloadSettings(); });
        await settleRounds();
        expect(inputWithValue(page()!, "https://moved-again.example/v1")).toBeDefined();
        expect(page()!.querySelector('[data-slot="provider-check"]') === null).toBe(true);
      }
    );
  });

  test("a failed check says why under the header", async () => {
    await withFetch(
      (call) => {
        if (isConfig(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        if (call.url.endsWith("/check")) {
          return jsonResponse({ ok: true, providerName: "openai", result: "failed", httpStatus: 401, message: "401 Unauthorized: bad key", checkedAt: READY.checkedAt });
        }
        return others(call);
      },
      async () => {
        render();
        await settleRounds();
        expect(row("openai")!.textContent).toContain("Check failed");
        const opened = await open("openai");
        expect(opened.textContent).toContain("Check failed — 401 Unauthorized: bad key. Checked");
      }
    );
  });

  test("Codex has no Check: its status is its sign-in", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ codex: codexFixture() })) : others(call),
      async () => {
        render();
        await settleRounds();
        const opened = await open("codex");
        expect(button(opened, "Check") === undefined).toBe(true);
        expect(opened.textContent).toContain("dev@example.com");
        expect(button(opened, "Sign out")).toBeDefined();
      }
    );
  });

  test("a saved name is fixed; an edit brings the save bar, which sticks, and marks that provider in the list", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() })) : others(call),
      async () => {
        render();
        await settleRounds();
        const opened = await open("openai");
        expect(input(opened, "Provider name") === null).toBe(true);
        expect(saveBar() === null).toBe(true);
        changeInput(inputWithValue(opened, "https://api.openai.com/v1")!, "https://proxy.example/v1");
        expect(saveBar()!.textContent).toContain("Unsaved changes");
        expect(saveBar()!.className.split(/\s+/)).toContain("sticky");
        await back();
        expect(row("openai")!.querySelector("[data-unsaved]")).not.toBeNull();
        expect(row("anthropic")!.querySelector("[data-unsaved]") === null).toBe(true);
      }
    );
  });

  test("a save posts the whole set (the others as saved), lands clean, and checks the provider again", async () => {
    let postBody: { models: { providers: Record<string, { baseURL?: string }> } } | null = null;
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() }));
        postBody = JSON.parse(String(call.init!.body)) as typeof postBody;
        return jsonResponse(mockConfig({ openai: openaiFixture("https://alt.example/v1"), anthropic: anthropicFixture() }));
      },
      async (calls) => {
        render();
        await settleRounds();
        const opened = await open("openai");
        changeInput(inputWithValue(opened, "https://api.openai.com/v1")!, "https://alt.example/v1");
        const before = checksIn(calls).length;
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        const providers = postBody!.models.providers;
        expect(Object.keys(providers).sort()).toEqual(["anthropic", "openai"]);
        expect(providers.openai!.baseURL).toBe("https://alt.example/v1");
        expect(providers.anthropic!.baseURL).toBe("https://api.anthropic.com/v1");
        expect(saveBar()!.textContent).toContain("Saved");
        expect(saveBar()!.textContent).not.toContain("Unsaved changes");
        expect(checksIn(calls).slice(before)).toEqual([["openai", 0]]);
        // Its answer is for the settings just saved, so it shows.
        expect(page()!.querySelector('[data-slot="provider-check"]')?.textContent).toContain("Ready — the key works");
      }
    );
  });

  // The server trims an address (and fills an empty one with the default):
  // the check run after the save was tagged with the address as typed, and
  // once the page took the saved one the answer was not shown for it.
  test("a save the server normalises shows the address saved, stays clean, and shows its check", async () => {
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        return jsonResponse(mockConfig({ openai: openaiFixture("https://alt.example/v1") }));
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("openai");
        changeInput(inputWithValue(opened, "https://api.openai.com/v1")!, "https://alt.example/v1  ");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(inputWithValue(page()!, "https://alt.example/v1")).toBeDefined();
        expect(saveBar()?.textContent ?? "").not.toContain("Unsaved changes");
        expect(button(page()!, "Check")?.disabled).toBe(false);
        expect(page()!.querySelector('[data-slot="provider-check"]')?.textContent).toContain("Ready — the key works");
      }
    );
  });

  test("a Kilo Organization ID the server trims shows as saved, leaves the page clean, and shows its check", async () => {
    const kilo = (organizationId: string) => ({ kilo: { type: "kilo", baseURL: "", organizationId, models: [{ id: "kilo-auto", input: ["text"] }], apiKeyConfigured: true } });
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        return jsonResponse(mockConfig(kilo(isPost(call) ? "org-2" : "org-1")));
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("kilo");
        changeInput(input(opened, "Organization ID")!, " org-2 ");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(input(page()!, "Organization ID")?.value).toBe("org-2");
        expect(saveBar()?.textContent ?? "").not.toContain("Unsaved changes");
        expect(button(page()!, "Check")?.disabled).toBe(false);
        expect(page()!.querySelector('[data-slot="provider-check"]')?.textContent).toContain("Ready — the key works");
      }
    );
  });

  test("an address edited while its save is on the way stays as edited, and unsaved", async () => {
    let answer: (() => void) | null = null;
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        return new Promise<Response>((resolve) => {
          answer = () => resolve(jsonResponse(mockConfig({ openai: openaiFixture("https://alt.example/v1") })));
        });
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("openai");
        changeInput(inputWithValue(opened, "https://api.openai.com/v1")!, "https://alt.example/v1  ");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        changeInput(inputWithValue(page()!, "https://alt.example/v1  ")!, "https://third.example/v1");
        answer!();
        await settleRounds();
        expect(inputWithValue(page()!, "https://third.example/v1")).toBeDefined();
        expect(saveBar()?.textContent ?? "").toContain("Unsaved changes");
      }
    );
  });

  test("a Refresh that fails while the first list is on its way leaves Add models asking no longer", async () => {
    let answerFirst: (() => void) | null = null;
    const lists = (calls: FetchCall[]) =>
      calls.filter((c) => c.url.includes("/models")).map((c) => (c.url.includes("refresh=1") ? "refresh" : "first"));
    await withFetch(
      (call) => {
        if (isConfig(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        if (call.url.endsWith("/check")) return others(call);
        if (call.url.includes("refresh=1")) return jsonResponse({ ok: false, error: "upstream unreachable" }, 502);
        return new Promise<Response>((resolve) => { answerFirst = () => resolve(jsonResponse(emptyCatalog())); });
      },
      async (calls) => {
        render();
        await settleRounds();
        await open("openai");
        click(button(page()!, "Add models")!);
        await settleRounds();
        const dialog = () => document.querySelector('[role="dialog"]')!;
        expect(dialog().textContent).toContain("Asking openai for its models…");
        click(button(dialog(), "Refresh")!);
        await settleRounds();
        answerFirst!();
        await settleRounds();
        expect(dialog().textContent).not.toContain("Asking openai");
        expect(dialog().textContent).toContain("openai didn't list its models — add one by id.");
        // Opened again, the page asks for the list again.
        click(button(dialog(), "Cancel")!);
        await back();
        await open("openai");
        expect(lists(calls)).toEqual(["first", "refresh", "first"]);
      }
    );
  });

  test("a Refresh that fails keeps the list shown", async () => {
    await withFetch(
      (call) => {
        if (isConfig(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        if (call.url.endsWith("/check")) return others(call);
        if (call.url.includes("refresh=1")) return jsonResponse({ ok: false, error: "upstream unreachable" }, 502);
        return jsonResponse({ ...emptyCatalog(), source: "live", models: [{ id: "gpt-6", input: ["text"] }] });
      },
      async () => {
        render();
        await settleRounds();
        await open("openai");
        click(button(page()!, "Add models")!);
        await settleRounds();
        const dialog = () => document.querySelector('[role="dialog"]')!;
        click(button(dialog(), "Refresh")!);
        await settleRounds();
        expect(dialog().textContent).toContain("Listed by openai.");
        expect(dialog().textContent).toContain("gpt-6");
      }
    );
  });

  test("a Refresh that fails after a newer one was asked for leaves the newer one's wait", async () => {
    const refreshes: Array<(ok: boolean) => void> = [];
    await withFetch(
      (call) => {
        if (isConfig(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        if (call.url.endsWith("/check")) return others(call);
        return new Promise<Response>((resolve) => {
          const answer = (ok: boolean) => resolve(ok ? jsonResponse({ ...emptyCatalog(), source: "live", models: [{ id: "gpt-6", input: ["text"] }] }) : jsonResponse({ ok: false, error: "upstream unreachable" }, 502));
          if (call.url.includes("refresh=1")) refreshes.push(answer);
        });
      },
      async () => {
        render();
        await settleRounds();
        await open("openai");
        click(button(page()!, "Add models")!);
        await settleRounds();
        const dialog = () => document.querySelector('[role="dialog"]')!;
        click(button(dialog(), "Refresh")!);
        click(button(dialog(), "Refresh")!);
        await settleRounds();
        refreshes[0]!(false);
        await settleRounds();
        expect(dialog().textContent).toContain("Asking openai for its models…");
        refreshes[1]!(true);
        await settleRounds();
        expect(dialog().textContent).toContain("Listed by openai.");
      }
    );
  });

  test("Add models on a provider not saved yet says to save it, not that it listed nothing", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture() })) : others(call),
      async () => {
        render();
        await settleRounds();
        await addProvider();
        click(button(page()!, "Add models")!);
        await settleRounds();
        const dialog = document.querySelector('[role="dialog"]')!;
        expect(dialog.textContent).toContain("Save this provider to see the models it lists — or add one by id.");
        expect(dialog.textContent).not.toContain("didn't list");
      }
    );
  });

  test("a model's dialog saves that model at once, with the whole set; the page stays clean", async () => {
    let postBody: { models: { providers: Record<string, { models: Array<{ id: string; protocol?: string }> }> } } | null = null;
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        const saved = { ...proxyFixture(true), models: [{ id: "model-a", input: ["text"], protocol: "messages" }, { id: "model-b", input: ["text"] }] };
        if (!isPost(call)) return jsonResponse(mockConfig({ proxy: proxyFixture(true), openai: openaiFixture() }));
        postBody = JSON.parse(String(call.init!.body)) as typeof postBody;
        return jsonResponse(mockConfig({ proxy: saved, openai: openaiFixture() }));
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("proxy");
        click(opened.querySelector<HTMLElement>('[data-model-row="model-a"] button')!);
        await settleRounds();
        const dialog = () => document.querySelector('[role="dialog"]');
        click(Array.from(dialog()!.querySelectorAll<HTMLElement>('[role="radio"]')).find((el) => el.textContent?.includes("Messages"))!);
        click(button(dialog()!, "Save")!);
        await settleRounds();
        expect(Object.keys(postBody!.models.providers).sort()).toEqual(["openai", "proxy"]);
        expect(postBody!.models.providers.proxy!.models.map((m) => [m.id, m.protocol ?? null])).toEqual([["model-a", "messages"], ["model-b", null]]);
        expect(dialog() === null).toBe(true);
        expect(saveBar() === null).toBe(true);
        expect(opened.querySelector('[data-model-row="model-a"]')!.textContent).toContain("Messages");
        await back();
        expect(row("proxy")!.querySelector("[data-unsaved]") === null).toBe(true);
      }
    );
  });

  test("a model saved while the connection has unsaved edits sends the connection as saved; the edits keep the save bar", async () => {
    const postBodies: Array<{ models: { providers: Record<string, { baseURL: string; models: Array<{ id: string }> }> } }> = [];
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ proxy: proxyFixture(true) }));
        const body = JSON.parse(String(call.init!.body)) as (typeof postBodies)[number];
        postBodies.push(body);
        const sent = body.models.providers.proxy!;
        return jsonResponse(mockConfig({ proxy: { ...proxyFixture(true), baseURL: sent.baseURL, models: sent.models.map((m) => ({ id: m.id, input: ["text"] })) } }));
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("proxy");
        changeInput(inputWithValue(opened, "http://127.0.0.1:9/v1")!, "http://127.0.0.1:10/v1");
        await openModelMenu("model-b");
        click(menuItem("Remove")!);
        await settleRounds();
        expect(postBodies.map((body) => [body.models.providers.proxy!.baseURL, body.models.providers.proxy!.models.map((m) => m.id)]))
          .toStrictEqual([["http://127.0.0.1:9/v1", ["model-a"]]]);
        expect(opened.querySelector('[data-model-row="model-b"]') === null).toBe(true);
        expect(inputWithValue(opened, "http://127.0.0.1:10/v1")).toBeDefined();
        expect(saveBar()!.textContent).toContain("Unsaved changes");
        // The page's Save then sends the address, with the models as they now stand.
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(postBodies.slice(1).map((body) => [body.models.providers.proxy!.baseURL, body.models.providers.proxy!.models.map((m) => m.id)]))
          .toStrictEqual([["http://127.0.0.1:10/v1", ["model-a"]]]);
      }
    );
  });

  test("a provider found in use while its removal is being confirmed is not removed: the dialog says why", async () => {
    let inUse = false;
    const posts: unknown[] = [];
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (isPost(call)) {
          posts.push(JSON.parse(String(call.init!.body)));
          return jsonResponse(mockConfig({}));
        }
        return jsonResponse(inUse ? mockConfig({ proxy: proxyFixture(true) }, "proxy/model-a") : mockConfig({ proxy: proxyFixture(true) }));
      },
      async () => {
        render();
        await settleRounds();
        await open("proxy");
        await openMenu();
        click(menuItem("Remove provider…")!);
        await settleRounds();
        // Settings read again (another tab set a route to it).
        inUse = true;
        await act(async () => { await reloadSettings(); });
        await settleRounds();
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.querySelector('[data-slot="remove-blocked"]')?.textContent).toBe("In use by Routing (default model). Change that first.");
        const remove = button(dialog, "Remove")!;
        expect(remove.disabled).toBe(true);
        click(remove);
        await settleRounds();
        expect(posts).toStrictEqual([]);
        expect(page()).not.toBeNull();
      }
    );
  });

  test("settings read again bring a provider's saved models even while its connection has edits; a model action builds on them", async () => {
    let elsewhere = false;
    const posts: Array<{ models: { providers: Record<string, { baseURL: string; models: Array<{ id: string }> }> } }> = [];
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (isPost(call)) {
          const body = JSON.parse(String(call.init!.body)) as (typeof posts)[number];
          posts.push(body);
          const sent = body.models.providers.proxy!;
          return jsonResponse(mockConfig({ proxy: { ...proxyFixture(true), models: sent.models.map((m) => ({ id: m.id, input: ["text"] })) } }, "proxy/model-c"));
        }
        // Another tab added model-c and made it the default.
        return jsonResponse(elsewhere
          ? mockConfig({ proxy: { ...proxyFixture(true), models: [...(proxyFixture(true).models as object[]), { id: "model-c", input: ["text"] }] } }, "proxy/model-c")
          : mockConfig({ proxy: proxyFixture(true) }));
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("proxy");
        changeInput(inputWithValue(opened, "http://127.0.0.1:9/v1")!, "http://127.0.0.1:10/v1");
        elsewhere = true;
        await act(async () => { await reloadSettings(); });
        await settleRounds();
        expect(Array.from(opened.querySelectorAll<HTMLElement>("[data-model-row]")).map((el) => el.dataset.modelRow)).toStrictEqual(["model-a", "model-b", "model-c"]);
        expect(inputWithValue(opened, "http://127.0.0.1:10/v1")).toBeDefined();
        await openModelMenu("model-b");
        click(menuItem("Remove")!);
        await settleRounds();
        expect(posts.map((body) => body.models.providers.proxy!.models.map((m) => m.id))).toStrictEqual([["model-a", "model-c"]]);
        expect(saveBar()!.textContent).toContain("Unsaved changes");
      }
    );
  });

  test("a provider whose models are in use cannot be removed: its menu says what uses them", async () => {
    await withFetch(
      (call) => isConfig(call) ? jsonResponse(mockConfig({ proxy: proxyFixture(true) }, "proxy/model-a", "proxy/model-b")) : others(call),
      async () => {
        render();
        await settleRounds();
        await open("proxy");
        await openMenu();
        expect(menuItem("Remove provider…")!.getAttribute("data-disabled")).not.toBeNull();
        expect(document.querySelector('[data-slot="remove-blocked"]')?.textContent)
          .toBe("In use by Routing (default model) and Memory embeddings. Change those first.");
      }
    );
  });

  test("Remove provider… is in the page's menu, asks first, and leaves for the list", async () => {
    let postBody: { models: { providers: Record<string, unknown> } } | null = null;
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() }));
        postBody = JSON.parse(String(call.init!.body)) as typeof postBody;
        return jsonResponse(mockConfig({ anthropic: anthropicFixture() }));
      },
      async () => {
        render();
        await settleRounds();
        await open("openai");
        expect(button(page()!, "Remove provider") === undefined).toBe(true);
        await openMenu();
        click(menuItem("Remove provider…")!);
        await settleRounds();
        click(button(document.querySelector('[role="dialog"]')!, "Remove")!);
        await settleRounds();
        expect(Object.keys(postBody!.models.providers)).toEqual(["anthropic"]);
        expect(page() === null).toBe(true);
        expect(new URLSearchParams(search).get("provider")).toBeNull();
        expect(rows().map((el) => el.dataset.providerRow)).toStrictEqual(["anthropic"]);
      }
    );
  });
});

describe("new providers", () => {
  test("a new provider opens on its page, dirty, its name editable; saving keeps one card and fixes the name", async () => {
    let postBody: { models: { providers: Record<string, object> } } | null = null;
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        postBody = JSON.parse(String(call.init!.body)) as typeof postBody;
        return jsonResponse(mockConfig({ openai: openaiFixture(), provider: { type: "openai-compatible", baseURL: "", models: [], apiKeyConfigured: false } }));
      },
      async () => {
        render();
        await settleRounds();
        await addProvider();
        expect(new URLSearchParams(search).get("provider")?.startsWith("~")).toBe(true);
        expect(input(page()!, "Provider name")?.value).toBe("provider");
        expect(saveBar()!.textContent).toContain("Unsaved changes");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(Object.keys(postBody!.models.providers).sort()).toEqual(["openai", "provider"]);
        // The URL now names the saved provider; its name is fixed.
        expect(new URLSearchParams(search).get("provider")).toBe("provider");
        expect(page()!.querySelector('[data-slot="provider-title"]')?.textContent).toBe("provider");
        expect(input(page()!, "Provider name") === null).toBe(true);
        expect(container!.textContent).not.toContain("Unsaved changes");
        await back();
        expect(rows().map((el) => el.dataset.providerRow)).toStrictEqual(["openai", "provider"]);
      }
    );
  });

  test("a new provider's model changes wait for its first Save, which sends them", async () => {
    const posts: Array<{ models: { providers: Record<string, { models: unknown[] }> } }> = [];
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (isPost(call)) posts.push(JSON.parse(String(call.init!.body)) as (typeof posts)[number]);
        return jsonResponse(mockConfig({ openai: openaiFixture() }));
      },
      async () => {
        render();
        await settleRounds();
        await addProvider("Anthropic");
        const first = page()!.querySelector<HTMLElement>("[data-model-row]")!.dataset.modelRow!;
        await openModelMenu(first);
        click(menuItem("Remove")!);
        await settleRounds();
        expect(posts).toStrictEqual([]);
        expect(page()!.querySelector("[data-model-row]") === null).toBe(true);
        expect(page()!.querySelector('[data-slot="inline-error"]') === null).toBe(true);
        expect(saveBar()!.textContent).toContain("Unsaved changes");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(posts.map((body) => body.models.providers.anthropic?.models)).toStrictEqual([[]]);
      }
    );
  });

  test("two unsaved providers each open their own page; saving one keeps the other, unsaved", async () => {
    let postBody: { models: { providers: Record<string, object> } } | null = null;
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        postBody = JSON.parse(String(call.init!.body)) as typeof postBody;
        return jsonResponse(mockConfig({ openai: openaiFixture(), "provider-2": { type: "openai-compatible", baseURL: "", models: [], apiKeyConfigured: false } }));
      },
      async () => {
        render();
        await settleRounds();
        await addProvider();
        const first = new URLSearchParams(search).get("provider");
        await back();
        expect(row("provider")!.textContent).toContain("Not saved");
        await addProvider();
        const second = new URLSearchParams(search).get("provider");
        expect(second).not.toBe(first);
        expect(input(page()!, "Provider name")?.value).toBe("provider-2");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(Object.keys(postBody!.models.providers).sort()).toEqual(["openai", "provider-2"]);
        await back();
        expect(rows().map((el) => el.dataset.providerRow)).toStrictEqual(["openai", "provider", "provider-2"]);
        expect(row("provider")!.textContent).toContain("Not saved");
        await open("provider");
        expect(input(page()!, "Provider name")?.value).toBe("provider");
      }
    );
  });

  // A name typed while the first save is on its way never took effect: the
  // provider is the one saved under the submitted name, and its later saves
  // and Codex sign-in go by that name.
  test("a name changed while a new provider's first save is in flight gives way to the saved name", async () => {
    let resolveFirstPost: ((response: Response) => void) | null = null;
    const postBodies: Array<{ models: { providers: Record<string, { baseURL?: string }> } }> = [];
    const saved = { type: "openai-compatible", baseURL: "https://proxy.example/v1", models: [], apiKeyConfigured: false };
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        postBodies.push(JSON.parse(String(call.init!.body)) as (typeof postBodies)[number]);
        if (postBodies.length === 1) return new Promise<Response>((resolve) => { resolveFirstPost = resolve; });
        return jsonResponse(mockConfig({ openai: openaiFixture(), provider: { ...saved, baseURL: "https://moved.example/v1" } }));
      },
      async () => {
        render();
        await settleRounds();
        await addProvider();
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        changeInput(input(page()!, "Provider name")!, "renamed-meanwhile");
        await act(async () => { resolveFirstPost!(jsonResponse(mockConfig({ openai: openaiFixture(), provider: saved }))); });
        await settleRounds();
        expect(page()!.querySelector('[data-slot="provider-title"]')?.textContent).toBe("provider");
        expect(postBodies.length).toBe(1);

        changeInput(input(page()!, "Base URL")!, "https://moved.example/v1");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(Object.keys(postBodies[1]!.models.providers).sort()).toEqual(["openai", "provider"]);
        expect(page()!.querySelector('[data-slot="provider-title"]')?.textContent).toBe("provider");
        expect(inputWithValue(page()!, "https://moved.example/v1")).toBeDefined();
      }
    );
  });

  test("saving another provider after a new provider's save keeps the new one in the patch", async () => {
    const postBodies: Array<{ models: { providers: Record<string, { baseURL?: string }> } }> = [];
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        postBodies.push(JSON.parse(String(call.init!.body)) as (typeof postBodies)[number]);
        const provider: ProviderFixture = { type: "openai-compatible", baseURL: "", models: [], apiKeyConfigured: false };
        return jsonResponse(mockConfig({ openai: openaiFixture(postBodies.length === 1 ? undefined : "https://alt.example/v1"), provider }));
      },
      async () => {
        render();
        await settleRounds();
        await addProvider();
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        await back();
        const opened = await open("openai");
        changeInput(inputWithValue(opened, "https://api.openai.com/v1")!, "https://alt.example/v1");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(postBodies.length).toBe(2);
        expect(Object.keys(postBodies[1]!.models.providers).sort()).toEqual(["openai", "provider"]);
        expect(postBodies[1]!.models.providers.openai!.baseURL).toBe("https://alt.example/v1");
        await back();
        expect(rows().length).toBe(2);
        expect(container!.querySelector("[data-unsaved]") === null).toBe(true);
      }
    );
  });
});

describe("one write at a time", () => {
  test("while one provider's save is in flight, another's Save and Remove are locked; after it, the other saves on the fresh baseline", async () => {
    let resolveFirstPost: ((response: Response) => void) | null = null;
    const postBodies: Array<{ models: { providers: Record<string, { baseURL?: string }> } }> = [];
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() }));
        postBodies.push(JSON.parse(String(call.init!.body)) as (typeof postBodies)[number]);
        if (postBodies.length === 1) return new Promise<Response>((resolve) => { resolveFirstPost = resolve; });
        return jsonResponse(mockConfig({ openai: openaiFixture("https://alt-a.example/v1"), anthropic: { ...anthropicFixture(), baseURL: "https://alt-b.example/v1" } }));
      },
      async () => {
        render();
        await settleRounds();
        const a = await open("openai");
        changeInput(inputWithValue(a, "https://api.openai.com/v1")!, "https://alt-a.example/v1");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(button(saveBar()!, "Saving…")!.disabled).toBe(true);
        await back();
        const b = await open("anthropic");
        changeInput(inputWithValue(b, "https://api.anthropic.com/v1")!, "https://alt-b.example/v1");
        expect(button(saveBar()!, "Save")!.disabled).toBe(true);
        await openMenu();
        expect(menuItem("Remove provider…")!.getAttribute("data-disabled")).not.toBeNull();
        act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
        await settleRounds();

        await act(async () => {
          resolveFirstPost!(jsonResponse(mockConfig({ openai: openaiFixture("https://alt-a.example/v1"), anthropic: anthropicFixture() })));
        });
        await settleRounds();
        const bSave = button(saveBar()!, "Save")!;
        expect(bSave.disabled).toBe(false);
        click(bSave);
        await settleRounds();
        expect(postBodies.length).toBe(2);
        expect(postBodies[1]!.models.providers.openai!.baseURL).toBe("https://alt-a.example/v1");
        expect(postBodies[1]!.models.providers.anthropic!.baseURL).toBe("https://alt-b.example/v1");
      }
    );
  });
});

describe("errors", () => {
  test("a save the server refuses reads Couldn't save., the server's text below", async () => {
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture() }));
        return jsonResponse({ ok: false, error: "EACCES: permission denied, open 'config.json'" }, 500);
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("openai");
        changeInput(inputWithValue(opened, "https://api.openai.com/v1")!, "https://alt.example/v1");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(footerError(saveBar())).toEqual({ message: "Couldn't save.", detail: "EACCES: permission denied, open 'config.json'" });
      }
    );
  });

  test("a new provider's name that fails the check before sending is its own sentence, and nothing is sent", async () => {
    const posts: string[] = [];
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (isPost(call)) posts.push(String(call.init!.body));
        return jsonResponse(mockConfig({ openai: openaiFixture() }));
      },
      async () => {
        render();
        await settleRounds();
        await addProvider();
        changeInput(input(page()!, "Provider name")!, "my proxy");
        click(button(saveBar()!, "Save")!);
        await settleRounds();
        expect(posts).toStrictEqual([]);
        expect(footerError(saveBar())).toEqual({ message: "Provider names may use letters, numbers, dot, underscore, and hyphen.", detail: null });
      }
    );
  });

  test("a failed Codex sign-in reads Couldn't sign in., the reason below", async () => {
    const signedOut = { ...codexFixture(), auth: { status: "missing", configured: false } };
    await withFetch(
      (call) => {
        if (call.url === api.codexAuthStart) return jsonResponse({ ok: false, error: "OpenAI Codex login callback port 1455 is not available: EADDRINUSE" }, 500);
        return isConfig(call) ? jsonResponse(mockConfig({ codex: signedOut })) : others(call);
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("codex");
        click(button(opened, "Sign in")!);
        await settleRounds();
        expect(footerError(saveBar())).toEqual({ message: "Couldn't sign in.", detail: "OpenAI Codex login callback port 1455 is not available: EADDRINUSE" });
      }
    );
  });

  test("a failed Codex sign-out reads Couldn't sign out., the reason below", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.codexAuthLogout) return jsonResponse({ ok: false, error: "auth profile is locked" }, 500);
        return isConfig(call) ? jsonResponse(mockConfig({ codex: codexFixture() })) : others(call);
      },
      async () => {
        render();
        await settleRounds();
        const opened = await open("codex");
        click(button(opened, "Sign out")!);
        await settleRounds();
        expect(footerError(saveBar())).toEqual({ message: "Couldn't sign out.", detail: "auth profile is locked" });
      }
    );
  });

  test("a removal the server refuses reads Couldn't remove this provider., the server's text below, and stays on the page", async () => {
    await withFetch(
      (call) => {
        if (!isConfig(call)) return others(call);
        if (!isPost(call)) return jsonResponse(mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() }));
        return jsonResponse({ ok: false, error: "HTTP 500" }, 500);
      },
      async () => {
        render();
        await settleRounds();
        await open("openai");
        await openMenu();
        click(menuItem("Remove provider…")!);
        await settleRounds();
        click(button(document.querySelector('[role="dialog"]')!, "Remove")!);
        await settleRounds();
        expect(page()?.querySelector('[data-slot="provider-title"]')?.textContent).toBe("openai");
        expect(footerError(saveBar())).toEqual({ message: "Couldn't remove this provider.", detail: "HTTP 500" });
      }
    );
  });
});

// The Add provider cards: opened with a pointer, the first card
// took the focus ring the dialog's autofocus gave it and looked chosen; the
// ring is for keyboard focus only. A card's last line said what it starts
// with as a raw reference ("codex/gpt-5.6-sol", one of four Codex models, and
// a name the new provider may not even get); it says it in words.
test("the Add provider cards ring only for the keyboard, and say which models each starts with", async () => {
  await withFetch(
    (call) => isConfig(call) ? jsonResponse(mockConfig({ openai: openaiFixture() })) : others(call),
    async () => {
      render();
      await settleRounds();
      click(buttonsOf(container!).find((el) => (el.textContent ?? "").includes("Add provider"))!);
      await settleRounds();
      const card = (title: string) => buttonsOf(document).find((el) => el.querySelector("div")?.textContent === title)!;
      const tokens = card("OpenAI Codex").className.split(/\s+/);
      expect(tokens).toContain("focus-visible:ring-[3px]");
      expect(tokens.some((t) => t.startsWith("focus:ring"))).toBe(false);
      const startsWith = (title: string) => card(title).querySelector("[data-slot=template-models]")?.textContent ?? null;
      expect(startsWith("OpenAI Codex")).toBe("Starts with gpt-5.6-sol and 3 more");
      expect(startsWith("OpenAI API")).toBe("Starts with gpt-4.1-mini");
      expect(startsWith("OpenAI compatible")).toBe(null);
    }
  );
});
