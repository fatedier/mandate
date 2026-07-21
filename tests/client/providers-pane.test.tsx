import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "@/lib/api-paths";
import { ProvidersPane } from "@/routes/settings/ProvidersPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@/routes/settings/types";

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

/** Let in-flight promises resolve, zero-delay timers fire, and React flush the results. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

type FetchCall = { url: string; init?: RequestInit };

let fetchCalls: FetchCall[] = [];

async function withFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init };
    const index = fetchCalls.length;
    fetchCalls.push(call);
    return handler(call, index);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

type ProviderFixture = Record<string, unknown>;

/** Only the fields the pane reads; cast keeps the fixtures small. */
function mockConfig(providers: Record<string, ProviderFixture>): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    models: { providers }
  } as unknown as SettingsConfigResponse;
}

function openaiFixture(baseURL = "https://api.openai.com/v1"): ProviderFixture {
  return {
    type: "openai",
    baseURL,
    models: [{ id: "gpt-5", input: ["text"] }],
    apiKeyConfigured: true
  };
}

function anthropicFixture(): ProviderFixture {
  return {
    type: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    models: [{ id: "claude-opus-4", input: ["text", "image"] }],
    apiKeyConfigured: true
  };
}

function codexFixture(): ProviderFixture {
  return {
    type: "codex",
    baseURL: "",
    serviceTier: "",
    models: [{ id: "gpt-5.5", input: ["text"] }],
    apiKeyConfigured: false,
    auth: {
      status: "authenticated",
      configured: true,
      accountId: "acc",
      email: "dev@example.com",
      profileId: "p"
    }
  };
}

function emptyCatalog(): Record<string, unknown> {
  return {
    ok: true,
    providerName: "openai",
    providerType: "openai",
    source: "configured",
    cached: false,
    models: []
  };
}

function cardSections(): HTMLElement[] {
  return Array.from(container!.getElementsByTagName("section")) as unknown as HTMLElement[];
}

function buttonsOf(scope: HTMLElement | Document): HTMLButtonElement[] {
  return Array.from(scope.getElementsByTagName("button")) as unknown as HTMLButtonElement[];
}

function inputsOf(scope: HTMLElement): HTMLInputElement[] {
  return Array.from(scope.getElementsByTagName("input")) as unknown as HTMLInputElement[];
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
}

function click(button: HTMLElement): void {
  act(() => {
    button.click();
  });
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    setInputValue(input, value);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe("ProvidersPane", () => {
  test("renders both provider cards with status labels; editing a name dirties only that card", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) {
          return jsonResponse(mockConfig({ openai: openaiFixture(), codex: codexFixture() }));
        }
        return jsonResponse(emptyCatalog());
      },
      async () => {
        render(
          <SettingsConfigProvider>
            <ProvidersPane />
          </SettingsConfigProvider>
        );
        await settle();

        const sections = cardSections();
        expect(sections.length).toBe(2);
        expect(sections[0]!.textContent).toContain("openai");
        expect(sections[0]!.textContent).toContain("Connected");
        expect(sections[1]!.textContent).toContain("codex");
        expect(sections[1]!.textContent).toContain("Signed in");
        // Collapsed by default: no card body fields anywhere.
        expect(container!.textContent).not.toContain("Base URL");

        // Expand the openai card via its header toggle.
        const header = buttonsOf(sections[0]!)[0]!;
        click(header);
        await settle();
        const openaiCard = cardSections()[0]!;
        expect(openaiCard.textContent).toContain("Base URL");
        expect(openaiCard.textContent).not.toContain("Unsaved changes");

        // Edit its name: footer appears on this card only.
        const nameInput = inputsOf(openaiCard).find((el) => el.value === "openai");
        expect(nameInput).toBeDefined();
        changeInput(nameInput!, "openai-main");

        const after = cardSections();
        expect(after[0]!.textContent).toContain("Unsaved changes");
        expect(after[1]!.textContent).not.toContain("Unsaved changes");
      }
    );
  });

  test("per-card save posts the whole provider set (other cards as baselines) and lands clean", async () => {
    let postBody: {
      models: { providers: Record<string, { baseURL?: string; previousName?: string }> };
    } | null = null;
    await withFetch(
      (call) => {
        if (call.url !== api.settingsConfig) return jsonResponse(emptyCatalog());
        if ((call.init?.method ?? "GET") === "GET") {
          return jsonResponse(
            mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() })
          );
        }
        postBody = JSON.parse(String(call.init!.body)) as typeof postBody;
        return jsonResponse(
          mockConfig({
            openai: openaiFixture("https://alt.example/v1"),
            anthropic: anthropicFixture()
          })
        );
      },
      async () => {
        render(
          <SettingsConfigProvider>
            <ProvidersPane />
          </SettingsConfigProvider>
        );
        await settle();

        const header = buttonsOf(cardSections()[0]!)[0]!;
        click(header);
        await settle();

        const urlInput = inputsOf(cardSections()[0]!).find(
          (el) => el.value === "https://api.openai.com/v1"
        )!;
        changeInput(urlInput, "https://alt.example/v1");
        expect(cardSections()[0]!.textContent).toContain("Unsaved changes");

        const saveButton = buttonsOf(cardSections()[0]!).find((el) => el.textContent === "Save")!;
        click(saveButton);
        await settle();

        const providers = postBody!.models.providers;
        expect(Object.keys(providers).sort()).toEqual(["anthropic", "openai"]);
        expect(providers.openai!.baseURL).toBe("https://alt.example/v1");
        // The untouched card contributed its baseline, not a dirty form.
        expect(providers.anthropic!.baseURL).toBe("https://api.anthropic.com/v1");

        const after = cardSections()[0]!;
        expect(after.textContent).toContain("Saved");
        expect(after.textContent).not.toContain("Unsaved changes");
      }
    );
  });

  test("added provider mounts expanded and dirty; saving promotes its baseline without duplication", async () => {
    let postBody: {
      models: { providers: Record<string, { previousName?: string }> };
    } | null = null;
    await withFetch(
      (call) => {
        if (call.url !== api.settingsConfig) return jsonResponse(emptyCatalog());
        if ((call.init?.method ?? "GET") === "GET") {
          return jsonResponse(mockConfig({ openai: openaiFixture() }));
        }
        postBody = JSON.parse(String(call.init!.body)) as typeof postBody;
        return jsonResponse(
          mockConfig({
            openai: openaiFixture(),
            provider: {
              type: "openai-compatible",
              baseURL: "",
              models: [],
              apiKeyConfigured: false
            }
          })
        );
      },
      async () => {
        render(
          <SettingsConfigProvider>
            <ProvidersPane />
          </SettingsConfigProvider>
        );
        await settle();
        expect(cardSections().length).toBe(1);

        const addButton = buttonsOf(container!).find((el) =>
          (el.textContent ?? "").includes("Add provider")
        )!;
        click(addButton);
        await settle();

        // Template picker dialog renders in a portal on document.body.
        const templateButton = buttonsOf(document).find((el) =>
          (el.textContent ?? "").includes("OpenAI compatible")
        )!;
        click(templateButton);
        await settle();

        const sections = cardSections();
        expect(sections.length).toBe(2);
        const fresh = sections[1]!;
        // New card mounts expanded and dirty (baseline null).
        expect(fresh.textContent).toContain("Base URL");
        expect(fresh.textContent).toContain("Unsaved changes");

        const saveButton = buttonsOf(fresh).find((el) => el.textContent === "Save")!;
        click(saveButton);
        await settle();

        const providers = postBody!.models.providers;
        expect(Object.keys(providers).sort()).toEqual(["openai", "provider"]);
        expect(providers.provider!.previousName).toBeUndefined();

        // Baseline promotion: the config refresh matches the just-saved card
        // instead of appending a duplicate, and the card lands clean.
        const after = cardSections();
        expect(after.length).toBe(2);
        expect(container!.textContent).not.toContain("Unsaved changes");
        expect(after[1]!.textContent).toContain("Saved");
      }
    );
  });

  test("while one card's save is in flight, every other save/delete entry point is locked", async () => {
    let resolveFirstPost: ((response: Response) => void) | null = null;
    const postBodies: Array<{
      models: { providers: Record<string, { baseURL?: string }> };
    }> = [];
    await withFetch(
      (call) => {
        if (call.url !== api.settingsConfig) return jsonResponse(emptyCatalog());
        if ((call.init?.method ?? "GET") === "GET") {
          return jsonResponse(
            mockConfig({ openai: openaiFixture(), anthropic: anthropicFixture() })
          );
        }
        postBodies.push(JSON.parse(String(call.init!.body)) as (typeof postBodies)[number]);
        if (postBodies.length === 1) {
          // Card A's save: held in flight until the test resolves it.
          return new Promise<Response>((resolve) => {
            resolveFirstPost = resolve;
          });
        }
        return jsonResponse(
          mockConfig({
            openai: openaiFixture("https://alt-a.example/v1"),
            anthropic: { ...anthropicFixture(), baseURL: "https://alt-b.example/v1" }
          })
        );
      },
      async () => {
        render(
          <SettingsConfigProvider>
            <ProvidersPane />
          </SettingsConfigProvider>
        );
        await settle();

        // Expand and dirty both cards.
        click(buttonsOf(cardSections()[0]!)[0]!);
        click(buttonsOf(cardSections()[1]!)[0]!);
        await settle();
        const openaiUrl = inputsOf(cardSections()[0]!).find(
          (el) => el.value === "https://api.openai.com/v1"
        )!;
        changeInput(openaiUrl, "https://alt-a.example/v1");
        const anthropicUrl = inputsOf(cardSections()[1]!).find(
          (el) => el.value === "https://api.anthropic.com/v1"
        )!;
        changeInput(anthropicUrl, "https://alt-b.example/v1");

        // Queued-click race: dispatch A's Save AND B's Save inside the SAME
        // synchronous flush. Both clicks land before the busy re-render
        // commits, so React still sees props.disabled === false on B and B's
        // onSave genuinely fires — only saveCard's busyRef entry guard stands
        // between it and a second interleaved POST. (A's POST stays
        // unresolved.)
        const aSave = buttonsOf(cardSections()[0]!).find((el) => el.textContent === "Save")!;
        const bSaveRaced = buttonsOf(cardSections()[1]!).find((el) => el.textContent === "Save")!;
        expect(bSaveRaced.disabled).toBe(false);
        act(() => {
          aSave.click();
          bSaveRaced.click();
        });
        await settle();
        expect(postBodies.length).toBe(1);

        // In flight: A reads Saving…; B's Save keeps its label but is disabled;
        // delete entry points on both cards are disabled too.
        const inFlight = cardSections();
        const aButton = buttonsOf(inFlight[0]!).find((el) => el.textContent === "Saving…")!;
        expect(aButton.disabled).toBe(true);
        const bSave = buttonsOf(inFlight[1]!).find((el) => el.textContent === "Save")!;
        expect(bSave.disabled).toBe(true);
        for (const section of inFlight) {
          const remove = buttonsOf(section).find((el) =>
            (el.textContent ?? "").includes("Remove provider")
          )!;
          expect(remove.disabled).toBe(true);
        }

        // A's save lands: the pane unlocks and B saves against A's fresh baseline.
        await act(async () => {
          resolveFirstPost!(
            jsonResponse(
              mockConfig({
                openai: openaiFixture("https://alt-a.example/v1"),
                anthropic: anthropicFixture()
              })
            )
          );
        });
        await settle();
        expect(cardSections()[0]!.textContent).toContain("Saved");

        const bSaveAfter = buttonsOf(cardSections()[1]!).find(
          (el) => el.textContent === "Save"
        )!;
        expect(bSaveAfter.disabled).toBe(false);
        click(bSaveAfter);
        await settle();
        expect(postBodies.length).toBe(2);
        // Serialized, B's patch was built AFTER A's reconcile: A's saved URL
        // survives instead of being reverted by A's stale pre-save baseline.
        expect(postBodies[1]!.models.providers.openai!.baseURL).toBe("https://alt-a.example/v1");
        expect(postBodies[1]!.models.providers.anthropic!.baseURL).toBe("https://alt-b.example/v1");
        expect(cardSections()[1]!.textContent).toContain("Saved");
      }
    );
  });

  test("saving another card after a new provider's save keeps the new provider in the patch", async () => {
    const postBodies: Array<{
      models: { providers: Record<string, { baseURL?: string }> };
    }> = [];
    await withFetch(
      (call) => {
        if (call.url !== api.settingsConfig) return jsonResponse(emptyCatalog());
        if ((call.init?.method ?? "GET") === "GET") {
          return jsonResponse(mockConfig({ openai: openaiFixture() }));
        }
        postBodies.push(JSON.parse(String(call.init!.body)) as (typeof postBodies)[number]);
        const provider: ProviderFixture = {
          type: "openai-compatible",
          baseURL: "",
          models: [],
          apiKeyConfigured: false
        };
        if (postBodies.length === 1) {
          return jsonResponse(mockConfig({ openai: openaiFixture(), provider }));
        }
        return jsonResponse(
          mockConfig({ openai: openaiFixture("https://alt.example/v1"), provider })
        );
      },
      async () => {
        render(
          <SettingsConfigProvider>
            <ProvidersPane />
          </SettingsConfigProvider>
        );
        await settle();

        // Add a new provider via the setup dialog and save it (POST 1).
        const addButton = buttonsOf(container!).find((el) =>
          (el.textContent ?? "").includes("Add provider")
        )!;
        click(addButton);
        await settle();
        const templateButton = buttonsOf(document).find((el) =>
          (el.textContent ?? "").includes("OpenAI compatible")
        )!;
        click(templateButton);
        await settle();
        const freshSave = buttonsOf(cardSections()[1]!).find((el) => el.textContent === "Save")!;
        click(freshSave);
        await settle();
        expect(postBodies.length).toBe(1);

        // Edit and save ANOTHER card (POST 2).
        click(buttonsOf(cardSections()[0]!)[0]!);
        await settle();
        const urlInput = inputsOf(cardSections()[0]!).find(
          (el) => el.value === "https://api.openai.com/v1"
        )!;
        changeInput(urlInput, "https://alt.example/v1");
        const saveButton = buttonsOf(cardSections()[0]!).find((el) => el.textContent === "Save")!;
        click(saveButton);
        await settle();

        // The whole-record patch still carries the just-saved new provider:
        // baseline promotion turned the baseline-null card into a baseline
        // contributor, so the server-side REPLACE cannot drop it.
        expect(postBodies.length).toBe(2);
        const providers = postBodies[1]!.models.providers;
        expect(Object.keys(providers).sort()).toEqual(["openai", "provider"]);
        expect(providers.provider).toBeDefined();
        expect(providers.openai!.baseURL).toBe("https://alt.example/v1");
        // And promotion left no duplicate card or phantom dirty state behind.
        expect(cardSections().length).toBe(2);
        expect(container!.textContent).not.toContain("Unsaved changes");
      }
    );
  });
});
