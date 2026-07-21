import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Sidebar } from "@/shell/Sidebar";
import { SettingsPage } from "@/routes/settings/SettingsPage";
import { useUIStore } from "@/store/ui";
import type { SettingsConfigResponse } from "@/routes/settings/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const initialUiState = useUIStore.getState();

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  useUIStore.setState(initialUiState, true);
});

function render(node: ReactNode, path = "/settings"): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
  });
  return host;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** Only the fields the shell + panes read on mount. */
function mockConfig(): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    models: {
      default: { model: "openai/gpt-5", reasoningEffort: "medium", modelFallbacks: [] },
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
      logRequests: "metadata",
      modelOverrides: { manager: false, worker: false },
      managerModel: { model: "openai/gpt-5", reasoningEffort: "medium" },
      managerModelFallbacks: [],
      workerModel: { model: "openai/gpt-5", reasoningEffort: "medium" },
      workerModelFallbacks: []
    }
  } as unknown as SettingsConfigResponse;
}

async function withConfigFetch(run: () => Promise<void>, status = 200): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    status === 200 ? jsonResponse(mockConfig()) : jsonResponse({ ok: false }, status)) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sectionLinks(scope: HTMLElement): HTMLAnchorElement[] {
  return Array.from(scope.querySelectorAll("a[href*='tab=']"));
}

test("Sidebar on /settings shows the section groups with a back link", () => {
  const el = render(<Sidebar />, "/settings?tab=providers");
  const back = Array.from(el.querySelectorAll("a")).find((a) => /back/i.test(a.textContent ?? ""));
  expect(back).toBeTruthy();
  const links = sectionLinks(el);
  const labels = links.map((a) => a.textContent?.trim());
  expect(labels).toContain("General");
  expect(labels).toContain("Providers");
  expect(labels).toContain("Skills");
  const active = links.find((a) => a.getAttribute("aria-current") === "page");
  expect(active?.textContent?.trim()).toBe("Providers");
});

test("Sidebar off /settings keeps the main nav and no section links", () => {
  const el = render(<Sidebar />, "/activity");
  const labels = Array.from(el.querySelectorAll("a")).map((a) => a.textContent?.trim());
  expect(labels).toContain("Home");
  expect(sectionLinks(el).length).toBe(0);
});

test("Settings frame width is identical across form and wide sections", async () => {
  await withConfigFetch(async () => {
    const a = render(<SettingsPage />, "/settings?tab=general");
    await settle();
    const widthA = (a.querySelector("div.mx-auto") as HTMLElement | undefined)?.style.maxWidth;
    act(() => root!.unmount());
    host?.remove();
    const b = render(<SettingsPage />, "/settings?tab=providers");
    await settle();
    const widthB = (b.querySelector("div.mx-auto") as HTMLElement | undefined)?.style.maxWidth;
    expect(widthA).toBeTruthy();
    expect(widthA).toBe(widthB!);
  }, 500);
});

test("no pane narrows its own content — one width for every tab", async () => {
  await withConfigFetch(async () => {
    const a = render(<SettingsPage />, "/settings?tab=general");
    await settle();
    expect(a.querySelector("[data-pane-width]")).toBe(null);
    expect(a.querySelector("[class*='max-w-[680px]']")).toBe(null);
  });
});

test("the page keeps only the narrow-screen tab strip; the rail lives in the sidebar now", async () => {
  await withConfigFetch(async () => {
    const el = render(<SettingsPage />, "/settings?tab=general");
    await settle();
    expect(el.querySelectorAll("nav[aria-label='Settings sections']").length).toBe(1);
  });
});

test("the tab strip stays reachable when the sidebar is collapsed", async () => {
  await withConfigFetch(async () => {
    act(() => useUIStore.setState({ sidebarCollapsed: true }));
    const el = render(<SettingsPage />, "/settings?tab=general");
    await settle();
    // The tab strip specifically (it carries the border-b underline), not the
    // legacy rail that shares the aria-label until the rail is removed.
    const strip = Array.from(el.querySelectorAll("nav[aria-label='Settings sections']"))
      .find((n) => n.className.includes("border-b"));
    expect(strip).toBeTruthy();
    expect(strip!.className.includes("@[40rem]:hidden")).toBe(false);
  });
});
