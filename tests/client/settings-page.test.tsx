import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { api } from "@/lib/api-paths";
import { SettingsPage } from "@/routes/settings/SettingsPage";
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

/** One flush cycle: drain microtasks, fire zero-delay timers, let React commit. */
async function tick(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Let in-flight promises resolve, zero-delay timers fire, and React flush the results. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) await tick();
}

/**
 * Poll until `predicate` holds, flushing a cycle between checks. Router
 * navigation (setSearchParams) and pane-mount effects settle across several
 * async hops; a fixed round count races them under machine load, so wait on
 * the observable outcome instead. Bounded so a real failure still throws.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let round = 0; round < 50; round++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

type FetchCall = { url: string; init?: RequestInit };

async function withFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler({ url, init }, calls++);
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

/** Only the fields the shell + Providers/Routing/General panes read. */
function mockConfig(): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    models: {
      default: {
        model: "openai/gpt-5",
        reasoningEffort: "medium",
        modelFallbacks: []
      },
      providers: {
        openai: {
          type: "openai",
          baseURL: "https://api.openai.com/v1",
          models: [{ id: "gpt-5", input: ["text"] }],
          apiKeyConfigured: true
        }
      }
    },
    agent: {
      preferences: "",
      compressionThresholdTokens: 200000,
      logRequests: "metadata",
      modelOverrides: { manager: false, worker: false },
      managerModel: { model: "openai/gpt-5", reasoningEffort: "medium" },
      managerModelFallbacks: [],
      workerModel: { model: "openai/gpt-5", reasoningEffort: "medium" },
      workerModelFallbacks: []
    }
  } as unknown as SettingsConfigResponse;
}

function buttonsOf(scope: HTMLElement): HTMLButtonElement[] {
  return Array.from(scope.getElementsByTagName("button")) as unknown as HTMLButtonElement[];
}

function currentNavItems(): Element[] {
  return Array.from(container!.querySelectorAll('[aria-current="page"]'));
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

describe("SettingsPage shell", () => {
  test("?tab=providers opens Providers; the tab strip marks it current; clicking Routing switches panes", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
        return jsonResponse({ ok: true, models: [] });
      },
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings?tab=providers"]}>
            <SettingsPage />
          </MemoryRouter>
        );
        // The requested section is the only pane in the tree.
        await waitFor(() => container!.textContent!.includes("Add provider"), "Providers pane");
        expect(container!.textContent).not.toContain("Default route");

        // The section rail moved into the app sidebar; inside the page only
        // the tab strip renders, and it marks Providers current.
        const current = currentNavItems();
        expect(current).toHaveLength(1);
        for (const el of current) expect(el.textContent).toBe("Providers");

        const routingButtons = buttonsOf(container!).filter(
          (el) => el.textContent === "Routing"
        );
        expect(routingButtons).toHaveLength(1);
        act(() => {
          routingButtons[0]!.click();
        });
        await waitFor(() => container!.textContent!.includes("Default route"), "Routing pane");

        expect(container!.textContent).not.toContain("Add provider");
        const afterCurrent = currentNavItems();
        expect(afterCurrent).toHaveLength(1);
        for (const el of afterCurrent) expect(el.textContent).toBe("Routing");
      }
    );
  });

  test("adaptive shell renders the tab strip under a @container wrapper", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
        return jsonResponse({ ok: true, models: [] });
      },
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings"]}>
            <SettingsPage />
          </MemoryRouter>
        );
        await settle();

        // happy-dom cannot evaluate container queries, so assert the structure:
        // one @container wrapper and the two nav renderings carrying the
        // complementary visibility classes.
        const wrapper = Array.from(container!.querySelectorAll("div")).find((el) =>
          el.className.split(" ").includes("@container")
        );
        expect(wrapper).toBeDefined();

        // The grouped rail lives in the app sidebar now (tests/settings-sidebar-nav);
        // the page carries only the flat strip, hidden at width by default.
        const navs = Array.from(container!.querySelectorAll("nav"));
        expect(navs).toHaveLength(1);
        const tabStrip = navs[0]!;
        expect(tabStrip.className).toContain("@[40rem]:hidden");
        expect(tabStrip.className).toContain("flex");
        expect(tabStrip.textContent).not.toContain("Workspace");

        // Default section (no ?tab): General current in the strip.
        const current = currentNavItems();
        expect(current).toHaveLength(1);
        for (const el of current) expect(el.textContent).toBe("General");
      }
    );
  });

  test("config load failure shows the destructive card; Retry recovers into the panes", async () => {
    // Counts settingsConfig calls specifically, not `index` (every fetch in
    // the test): General's Storage row fires its own independent GET on
    // mount, ahead of the config provider's — a child effect commits before
    // its ancestor's — so a global call-order index no longer lines up with
    // "first settingsConfig fetch vs. the retry".
    let settingsConfigCalls = 0;
    await withFetch(
      (call) => {
        if (call.url !== api.settingsConfig) return jsonResponse({ ok: true, models: [] });
        if (settingsConfigCalls++ === 0) {
          return jsonResponse({ ok: false, error: "config unreadable" }, 500);
        }
        return jsonResponse(mockConfig());
      },
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings"]}>
            <SettingsPage />
          </MemoryRouter>
        );
        await settle();

        expect(container!.textContent).toContain("config unreadable");
        // No pane content while the shell has no config at all.
        expect(container!.textContent).not.toContain("Appearance");

        const retry = buttonsOf(container!).find((el) => el.textContent === "Retry");
        expect(retry).toBeDefined();
        act(() => {
          retry!.click();
        });
        await settle();

        expect(container!.textContent).not.toContain("config unreadable");
        expect(container!.textContent).toContain("Appearance");
      }
    );
  });
});
