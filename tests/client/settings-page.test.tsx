import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { api } from "@/lib/api-paths";
import { SettingsPage } from "@/routes/settings/SettingsPage";
import { useUIStore } from "@/store/ui";
import { useSettingsSearchStore } from "@/store/settings-search";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { searchSettings } from "@/routes/settings/settings-search";
import { paramForSection } from "@/routes/settings/settings-nav";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, withFetch } from "../helpers/fetch.js";
import { mount, settleUntil, settleRounds } from "../helpers/mount.js";

let container: HTMLElement | null = null;

function render(node: ReactNode): void {
  container = mount(node).host;
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
      prices: { autoUpdate: true },
      providers: {
        openai: {
          type: "openai",
          baseURL: "https://api.openai.com/v1",
          models: [{ id: "gpt-5", input: ["text"] }],
          apiKeyConfigured: true
        }
      }
    },
    memory: { embedding: { model: "" } },
    agent: {
      preferences: "",
      compressionThresholdTokens: 200000,
      logRequests: "metadata",
      modelOverrides: { manager: false, worker: false, global: false },
      managerModel: { model: "openai/gpt-5", reasoningEffort: "medium" },
      managerModelFallbacks: [],
      workerModel: { model: "openai/gpt-5", reasoningEffort: "medium" },
      workerModelFallbacks: [], globalModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, globalModelFallbacks: [],
      dreamModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, dreamModelFallbacks: [],
      extractionModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, extractionModelFallbacks: [],
      subagentModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, subagentModelFallbacks: [],
      pageModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, pageModelFallbacks: [],
      globalAgentName: ""
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
  // Unmount before the sidebar flag the page reads is reset under it.
  runCleanups();
  container = null;
  act(() => useUIStore.setState({ sidebarCollapsed: false }));
});

let search = "";
function LocationProbe() {
  search = useLocation().search;
  return null;
}

describe("SettingsPage shell", () => {
  // While a search shows its matches, which span sections, no section is
  // current, and choosing one leaves the search: it moved the
  // highlight and kept the matches, the highlight reading "General" beside
  // matches from four sections. The search never writes the URL.
  test("a search marks no section current, and choosing a section leaves it", async () => {
    act(() => useUIStore.setState({ sidebarCollapsed: true }));
    await withFetch(
      (call) => (call.url === api.settingsConfig ? jsonResponse(mockConfig()) : jsonResponse({ ok: true, models: [] })),
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings?tab=general"]}>
            <SettingsPage />
            <LocationProbe />
          </MemoryRouter>
        );
        await settleUntil(() => container!.textContent!.includes("Manager"), "General pane");
        const box = container!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, "model");
          box.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        });
        expect(container!.textContent).toContain("Matches");
        expect(currentNavItems()).toHaveLength(0);
        expect(search).toBe("?tab=general");

        act(() => { buttonsOf(container!).find((b) => b.textContent === "Providers")!.click(); });
        await settleUntil(() => container!.textContent!.includes("Add provider"), "Providers pane");
        expect(new URLSearchParams(search).get("tab")).toBe("providers");
        expect(box.value).toBe("");
        expect(container!.textContent).not.toContain("Matches");
        expect(currentNavItems().map((el) => el.textContent)).toEqual(["Providers"]);
      }
    );
  });

  // The box was once fed from ?q=: the router applies a URL in a transition,
  // so after each key React put the old value back and the next key landed
  // on it ("m", "o" read "o"). Every navigation leaves the search, the
  // current section's link included (its URL is the same one), and so does
  // leaving Settings.
  test("keys typed outside act all land; any navigation, or leaving Settings, clears the search", async () => {
    let goTo: (to: string) => void = () => {};
    function Nav() {
      goTo = useNavigate();
      return null;
    }
    await withFetch(
      (call) => (call.url === api.settingsConfig ? jsonResponse(mockConfig()) : jsonResponse({ ok: true, models: [] })),
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings?tab=general"]}>
            <SettingsPage />
            <LocationProbe />
            <Nav />
          </MemoryRouter>
        );
        await settleUntil(() => container!.textContent!.includes("Manager"), "General pane");
        const box = container!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
        const setValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!;
        const type = (key: string) => {
          setValue.call(box, box.value + key);
          box.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        };
        // Outside act, as a browser delivers them.
        const act_ = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
        act_.IS_REACT_ACT_ENVIRONMENT = false;
        try {
          type("m");
          type("o");
        } finally {
          act_.IS_REACT_ACT_ENVIRONMENT = true;
        }
        await settleRounds();
        expect(box.value).toBe("mo");
        expect(container!.textContent).toContain("Matches");

        await act(async () => goTo("/settings?tab=general"));
        await settleRounds();
        expect(search).toBe("?tab=general");
        expect(box.value).toBe("");
        expect(container!.textContent).not.toContain("Matches");

        await act(async () => type("key"));
        await act(async () => goTo("/settings?tab=routing"));
        await settleRounds();
        expect(box.value).toBe("");

        await act(async () => type("x"));
        expect(useSettingsSearchStore.getState().query).toBe("x");
        runCleanups();
        expect(useSettingsSearchStore.getState().query).toBe("");
      }
    );
  });

  // Keyboard hints say nothing on a touch screen (the chat composer hides its
  // "⏎ to send" there), and the no-match hint suggests what the index holds.
  test("the keyboard hints are for pointers only, and the no-match hint is true", async () => {
    await withFetch(
      (call) => (call.url === api.settingsConfig ? jsonResponse(mockConfig()) : jsonResponse({ ok: true, models: [] })),
      async () => {
        render(<MemoryRouter initialEntries={["/settings"]}><SettingsPage /></MemoryRouter>);
        await settleUntil(() => container!.querySelector("kbd") !== null, "the / hint");
        expect(container!.querySelector("kbd")!.className.split(/\s+/)).toContain("pointer-coarse:hidden");
        const box = container!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
        const search = async (text: string) => act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, text);
          box.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        });
        await search("model");
        const hint = container!.querySelector('[data-slot="search-keys"]')!;
        expect(hint.textContent).toBe("to choose · to open");
        expect(hint.className.split(/\s+/)).toContain("pointer-coarse:hidden");
        await search("zzzz");
        expect(container!.textContent).toContain("No setting matches");
        expect(container!.textContent).toContain("Try a shorter word, like “model” or “key”.");
      }
    );
  });

  // Enter opened only the first match: the others took the pointer or Tab.
  // The arrows move a mark through the matches while the keys stay in the
  // box (a combobox: the mark is the box's active descendant), and Enter
  // opens the one marked.
  test("the arrow keys move through the matches and Enter opens the one marked", async () => {
    await withFetch(
      (call) => (call.url === api.settingsConfig ? jsonResponse(mockConfig()) : jsonResponse({ ok: true, models: [] })),
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings"]}>
            <SettingsPage />
            <LocationProbe />
          </MemoryRouter>
        );
        await settleUntil(() => container!.querySelector('input[aria-label="Search settings"]') !== null, "the search box");
        const box = container!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, "model");
          box.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        });
        const expected = searchSettings("model", { desktop: false });
        // A match on another section's page, so opening it moves the URL.
        const target = expected.findIndex((result, index) => index > 0 && result.section !== "general");
        expect(target).toBeGreaterThan(0);
        const options = () => [...container!.querySelectorAll<HTMLElement>('[role="option"]')];
        const marked = () => options().findIndex((option) => option.getAttribute("aria-selected") === "true");
        const press = (key: string, times = 1) => act(() => {
          for (let i = 0; i < times; i++) box.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
        });
        expect(box.getAttribute("role")).toBe("combobox");
        expect(container!.querySelector(`#${box.getAttribute("aria-controls")}`)!.getAttribute("role")).toBe("listbox");
        expect(options().length).toBe(expected.length);
        expect(marked()).toBe(0);
        press("ArrowUp");
        expect(marked()).toBe(0);
        press("ArrowDown", target);
        expect(marked()).toBe(target);
        expect(box.getAttribute("aria-activedescendant")).toBe(options()[target]!.id);
        // The mark stops at the last match, and comes back up.
        press("ArrowDown", expected.length);
        expect(marked()).toBe(expected.length - 1);
        press("ArrowUp", expected.length - 1 - target);
        expect(marked()).toBe(target);
        press("Enter");
        await settleUntil(() => box.value === "", "the search to close");
        expect(new URLSearchParams(search).get("tab")).toBe(paramForSection(expected[target]!.section));
      }
    );
  });

  // Keys an input method uses to pick its candidates are not the search's:
  // they moved the mark, and Enter opened a match.
  test("keys pressed while an input method composes leave the matches alone", async () => {
    await withFetch(
      (call) => (call.url === api.settingsConfig ? jsonResponse(mockConfig()) : jsonResponse({ ok: true, models: [] })),
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings"]}>
            <SettingsPage />
            <LocationProbe />
          </MemoryRouter>
        );
        await settleUntil(() => container!.querySelector('input[aria-label="Search settings"]') !== null, "the search box");
        const box = container!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, "model");
          box.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        });
        const marked = () => [...container!.querySelectorAll('[role="option"]')].findIndex((o) => o.getAttribute("aria-selected") === "true");
        act(() => { box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, bubbles: true })); });
        expect(marked()).toBe(0);
        act(() => { box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })); });
        await settleRounds();
        expect(box.value).toBe("model");
        // Composition over, the keys are the search's again.
        act(() => { box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
        expect(marked()).toBe(1);
      }
    );
  });

  // The mark was kept for its query, so typing that query again (cleared and
  // retyped, or edited and back) brought back a match marked long before,
  // and Enter opened it.
  test("a new query, even one typed before, starts the mark at the first match", async () => {
    await withFetch(
      (call) => (call.url === api.settingsConfig ? jsonResponse(mockConfig()) : jsonResponse({ ok: true, models: [] })),
      async () => {
        render(<MemoryRouter initialEntries={["/settings"]}><SettingsPage /></MemoryRouter>);
        await settleUntil(() => container!.querySelector('input[aria-label="Search settings"]') !== null, "the search box");
        const box = container!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
        const type = (text: string) => act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, text);
          box.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        });
        const marked = () => [...container!.querySelectorAll('[role="option"]')].findIndex((o) => o.getAttribute("aria-selected") === "true");
        await type("model");
        act(() => { for (let i = 0; i < 2; i++) box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
        expect(marked()).toBe(2);
        await type("");
        await type("model");
        expect(marked()).toBe(0);
        act(() => { for (let i = 0; i < 2; i++) box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
        await type("mode");
        await type("model");
        expect(marked()).toBe(0);
      }
    );
  });

  // With the settings unread, the matches are not drawn (an error stands in
  // their place), so the box points at no match and the arrows move none.
  test("when the settings could not be read, the box lists no matches", async () => {
    await withFetch(
      (call) => (call.url === api.settingsConfig ? jsonResponse({ error: "boom" }, 500) : jsonResponse({ ok: true, models: [] })),
      async () => {
        render(<MemoryRouter initialEntries={["/settings"]}><SettingsPage /></MemoryRouter>);
        await settleUntil(() => container!.textContent!.includes("Couldn't load settings."), "the load error");
        const box = container!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, "model");
          box.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        });
        expect(container!.querySelector('[role="option"]') === null).toBe(true);
        expect([box.getAttribute("aria-expanded"), box.hasAttribute("aria-activedescendant")]).toEqual(["false", false]);
      }
    );
  });

  test("?tab=providers opens Providers; the tab strip marks it current; clicking Routing switches panes", async () => {
    // The strip only exists while the app sidebar's section nav is gone.
    act(() => useUIStore.setState({ sidebarCollapsed: true }));
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
        await settleUntil(() => container!.textContent!.includes("Add provider"), "Providers pane");
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
        await settleUntil(() => container!.textContent!.includes("Default route"), "Routing pane");

        expect(container!.textContent).not.toContain("Add provider");
        const afterCurrent = currentNavItems();
        expect(afterCurrent).toHaveLength(1);
        for (const el of afterCurrent) expect(el.textContent).toBe("Routing");
      }
    );
  });

  // A provider's page belongs to Providers: another section, or a search
  // hit, leaves it rather than carrying ?provider= along.
  test("from a provider's page, another section drops it, and a search hit lands on the Providers list", async () => {
    act(() => useUIStore.setState({ sidebarCollapsed: true }));
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
        return jsonResponse({ ok: true, models: [] });
      },
      async () => {
        render(
          <MemoryRouter initialEntries={["/settings?tab=providers&provider=openai"]}>
            <SettingsPage />
            <LocationProbe />
          </MemoryRouter>
        );
        await settleUntil(() => Boolean(container!.querySelector('[data-slot="provider-page"]')), "provider page");
        act(() => buttonsOf(container!).find((el) => el.textContent === "Routing")!.click());
        await settleUntil(() => container!.textContent!.includes("Default route"), "Routing pane");
        expect(new URLSearchParams(search).get("provider")).toBeNull();

        act(() => buttonsOf(container!).find((el) => el.textContent === "Providers")!.click());
        await settleUntil(() => Boolean(container!.querySelector("[data-provider-row]")), "Providers list");
        act(() => container!.querySelector<HTMLElement>('[data-provider-row="openai"]')!.click());
        await settleUntil(() => Boolean(container!.querySelector('[data-slot="provider-page"]')), "provider page again");
        act(() => useSettingsSearchStore.getState().setQuery("Base URL"));
        await settleRounds();
        act(() => buttonsOf(container!).find((el) => (el.textContent ?? "").startsWith("Base URL"))!.click());
        await settleUntil(() => Boolean(container!.querySelector("[data-provider-row]")), "Providers list after the search");
        expect(new URLSearchParams(search).get("provider")).toBeNull();
      }
    );
  });

  test("the in-page tab strip exists only while the sidebar's section nav is gone, and then it is pill tabs", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
        return jsonResponse({ ok: true, models: [] });
      },
      async () => {
        act(() => useUIStore.setState({ sidebarCollapsed: false }));
        render(
          <MemoryRouter initialEntries={["/settings"]}>
            <SettingsPage />
          </MemoryRouter>
        );
        await settleRounds();

        // The grouped rail lives in the app sidebar (tests/settings-sidebar-nav).
        // While it is visible the page must not repeat it — at the 50/50 split
        // the old width rule (<40rem) showed both.
        expect(container!.querySelector("nav") === null).toBe(true);

        // Sidebar collapsed: the strip takes over, as the shipped pill tabs,
        // never the old underline tabs.
        act(() => useUIStore.setState({ sidebarCollapsed: true }));
        await settleRounds();
        const strip = container!.querySelector('nav[data-slot="page-tabs"]')!;
        expect(strip === null).toBe(false);
        expect(strip.getAttribute("aria-label")).toBe("Settings sections");
        expect(strip.textContent).not.toContain("Workspace");
        expect(container!.innerHTML.includes("border-b-2")).toBe(false);
        expect(container!.innerHTML.includes("@[40rem]:hidden")).toBe(false);
        const current = currentNavItems();
        expect(current).toHaveLength(1);
        for (const el of current) expect(el.textContent).toBe("General");
        for (const t of ["h-7", "rounded-sm", "text-foreground"]) expect(current[0]!.className.split(/\s+/)).toContain(t);
        // Its fill is the strip's one sliding mark.
        expect(strip.querySelectorAll('[data-slot="tab-mark"]').length).toBe(1);
      }
    );
  });

});
