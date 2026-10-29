import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { Sidebar } from "@/shell/Sidebar";
import { SettingsPage } from "@/routes/settings/SettingsPage";
import { useUIStore } from "@/store/ui";
import { useSettingsSearchStore } from "@/store/settings-search";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { onCleanup, runCleanups } from "./helpers/cleanup.js";
import { jsonResponse, withFetch } from "./helpers/fetch.js";
import { mount, type Mounted, settleRounds } from "./helpers/mount.js";

let view: Mounted | null = null;
const initialUiState = useUIStore.getState();

afterEach(() => {
  // Unmount before the UI store the sidebar reads is reset under it.
  runCleanups();
  useUIStore.setState(initialUiState, true);
});

function render(node: ReactNode, path = "/settings"): HTMLElement {
  view = mount(node, { path });
  return view.host;
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
  await withFetch(() => (status === 200 ? jsonResponse(mockConfig()) : jsonResponse({ ok: false }, status)), run);
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

// While a search shows its matches, which span sections, no section is
// current: it read "General" beside matches from four.
test("Sidebar on /settings marks no section while a search is open", () => {
  act(() => useSettingsSearchStore.setState({ query: "model" }));
  onCleanup(() => useSettingsSearchStore.setState({ query: "" }));
  const el = render(<Sidebar />, "/settings?tab=general");
  expect(sectionLinks(el).some((a) => a.getAttribute("aria-current") === "page")).toBe(false);
});

test("Sidebar off /settings keeps the main nav and no section links", () => {
  const el = render(<Sidebar />, "/activity");
  const labels = Array.from(el.querySelectorAll("a")).map((a) => a.textContent?.trim());
  // New thread is the main nav's first row (Home has no row of its own).
  expect(labels).toContain("New thread");
  expect(labels).toContain("Projects");
  expect(sectionLinks(el).length).toBe(0);
});

test("Settings frame width is identical across form and wide sections", async () => {
  await withConfigFetch(async () => {
    const a = render(<SettingsPage />, "/settings?tab=general");
    await settleRounds();
    const widthA = (a.querySelector("div.mx-auto") as HTMLElement | undefined)?.style.maxWidth;
    view!.unmount();
    const b = render(<SettingsPage />, "/settings?tab=providers");
    await settleRounds();
    const widthB = (b.querySelector("div.mx-auto") as HTMLElement | undefined)?.style.maxWidth;
    expect(widthA).toBeTruthy();
    expect(widthA).toBe(widthB!);
  }, 500);
});
