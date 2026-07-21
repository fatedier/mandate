import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { api } from "@/lib/api-paths";
import { SettingsPage } from "@/routes/settings/SettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function tick(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) await tick();
}
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let round = 0; round < 50; round++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function mockConfig() {
  return {
    ok: true,
    restartRequired: false,
    models: {
      default: { model: "claude/claude-opus-4-7", reasoningEffort: "medium", modelFallbacks: [] },
      providers: {
        claude: {
          type: "anthropic",
          baseURL: "https://api.anthropic.com",
          models: [{ id: "claude-opus-4-7", input: ["text", "image"], supportsReasoning: true }],
          apiKeyConfigured: true
        }
      }
    },
    agent: {
      preferences: "",
      logRequests: "metadata",
      modelOverrides: { manager: false, worker: false },
      managerModel: { model: "claude/claude-opus-4-7", reasoningEffort: "medium" },
      managerModelFallbacks: [],
      workerModel: { model: "claude/claude-opus-4-7", reasoningEffort: "medium" },
      workerModelFallbacks: []
    }
  };
}

function catalogPayload(source = "live") {
  return {
    ok: true,
    providerName: "claude",
    providerType: "anthropic",
    source,
    cached: false,
    models: [
      { id: "claude-opus-4-7", name: "claude-opus-4-7", input: ["text", "image"], supportsReasoning: true, contextLength: null, outputModalities: [], supportedParameters: [] },
      { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", input: ["text"], contextLength: null, outputModalities: [], supportedParameters: [] }
    ]
  };
}

async function withProvidersPane(
  run: () => Promise<void>,
  opts: { source?: string } = {}
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(api.settingsProviderModels("claude"))) {
      return jsonResponse(catalogPayload(opts.source));
    }
    if (url === api.settingsConfig) return jsonResponse(mockConfig());
    return jsonResponse({ ok: true, models: [] });
  }) as typeof fetch;
  try {
    render(
      <MemoryRouter initialEntries={["/settings?tab=providers"]}>
        <SettingsPage />
      </MemoryRouter>
    );
    await waitFor(() => !!findButtonByText("claude"), "providers pane");
    act(() => findButtonByText("claude")!.click());
    await settle();
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container!.getElementsByTagName("button"));
}
function findButtonByText(text: string): HTMLButtonElement | undefined {
  return buttons().find((b) => (b.textContent ?? "").trim() === text || (b.textContent ?? "").includes(text));
}
function chipFor(id: string): HTMLElement | undefined {
  return Array.from(container!.querySelectorAll("[data-model-chip]")).find(
    (el) => el.getAttribute("data-model-chip") === id
  ) as HTMLElement | undefined;
}

test("enabled models render as chips; the catalog picker adds one with a checkbox", async () => {
  await withProvidersPane(async () => {
    expect(chipFor("claude-opus-4-7")).toBeTruthy();

    act(() => findButtonByText("Add model")!.click());
    await waitFor(() => !!container!.querySelector("[data-catalog-item='claude-sonnet-4-6']"), "catalog list");

    const sonnetToggle = container!.querySelector(
      "[data-catalog-item='claude-sonnet-4-6'] input[type='checkbox']"
    ) as HTMLInputElement;
    const opusToggle = container!.querySelector(
      "[data-catalog-item='claude-opus-4-7'] input[type='checkbox']"
    ) as HTMLInputElement;
    expect(opusToggle.checked).toBe(true);
    expect(sonnetToggle.checked).toBe(false);

    act(() => sonnetToggle.click());
    await settle();
    expect(chipFor("claude-sonnet-4-6")).toBeTruthy();
    // Dirty: the card offers Save.
    expect(findButtonByText("Save")).toBeTruthy();
  });
});

test("a custom model id is added from the picker's free-type row", async () => {
  await withProvidersPane(async () => {
    act(() => findButtonByText("Add model")!.click());
    await settle();
    const custom = container!.querySelector("input[data-custom-model]") as HTMLInputElement;
    expect(custom).toBeTruthy();
    act(() => {
      // React tracks the input's value internally; write through the native
      // setter so the change event isn't swallowed as a no-op.
      const setValue = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(custom),
        "value"
      )!.set!;
      setValue.call(custom, "my-gateway-model");
      // Construct the event in the element's own realm — happy-dom rejects
      // an Event built from bun's global constructor.
      const win = custom.ownerDocument.defaultView as unknown as { Event: typeof Event };
      custom.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    const addBtn = buttons().find((b) => b.getAttribute("aria-label") === "Add custom model");
    act(() => addBtn!.click());
    await settle();
    expect(chipFor("my-gateway-model")).toBeTruthy();
  });
});

test("a chip's remove button drops the model", async () => {
  await withProvidersPane(async () => {
    expect(chipFor("claude-opus-4-7")).toBeTruthy();
    const remove = buttons().find((b) => b.getAttribute("aria-label") === "Remove claude-opus-4-7");
    expect(remove).toBeTruthy();
    act(() => remove!.click());
    await settle();
    expect(chipFor("claude-opus-4-7")).toBeFalsy();
  });
});

test("clicking a chip opens its capability editor (image input + reasoning)", async () => {
  await withProvidersPane(async () => {
    act(() => chipFor("claude-opus-4-7")!.click());
    await settle();
    const image = container!.querySelector("input[data-cap-image]") as HTMLInputElement;
    expect(image).toBeTruthy();
    expect(image.checked).toBe(true);
    act(() => image.click());
    await settle();
    expect((container!.querySelector("input[data-cap-image]") as HTMLInputElement).checked).toBe(false);
    expect(findButtonByText("Save")).toBeTruthy();
  });
});

test("when the live listing is unavailable the picker says so and keeps the custom row", async () => {
  await withProvidersPane(
    async () => {
      act(() => findButtonByText("Add model")!.click());
      await settle();
      expect(container!.textContent).toContain("Live list unavailable");
      expect(container!.querySelector("input[data-custom-model]")).toBeTruthy();
    },
    { source: "configured" }
  );
});

test("a failed catalog fetch retries on the next expand instead of pinning empty", async () => {
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(api.settingsProviderModels("claude"))) {
      modelCalls += 1;
      if (modelCalls === 1) throw new Error("backend restarting");
      return jsonResponse(catalogPayload());
    }
    if (url === api.settingsConfig) return jsonResponse(mockConfig());
    return jsonResponse({ ok: true, models: [] });
  }) as typeof fetch;
  try {
    render(
      <MemoryRouter initialEntries={["/settings?tab=providers"]}>
        <SettingsPage />
      </MemoryRouter>
    );
    await waitFor(() => !!findButtonByText("claude"), "providers pane");
    act(() => findButtonByText("claude")!.click());
    await settle();
    expect(modelCalls).toBe(1);
    // Collapse and re-expand: the failed fetch must be retried.
    act(() => findButtonByText("claude")!.click());
    await settle();
    act(() => findButtonByText("claude")!.click());
    await settle();
    expect(modelCalls).toBe(2);
    act(() => findButtonByText("Add model")!.click());
    await waitFor(() => !!container!.querySelector("[data-catalog-item='claude-sonnet-4-6']"), "catalog list after retry");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
