import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { api } from "@/lib/api-paths";
import { SettingsPage } from "@/routes/settings/SettingsPage";
import { SkillsPane } from "@/routes/settings/SkillsPane";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchHandler } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

afterEach(() => runCleanups());

/** Only the fields the shell and the General pane read. */
const CONFIG = {
  ok: true,
  restartRequired: false,
  models: {
    default: { model: "openai/gpt-5", reasoningEffort: "medium", modelFallbacks: [] },
    prices: { autoUpdate: true },
    providers: { openai: { type: "openai", baseURL: "https://api.openai.com/v1", models: [{ id: "gpt-5", input: ["text"] }], apiKeyConfigured: true } }
  },
  agent: {
    preferences: "", compressionThresholdTokens: 200000, logRequests: "metadata",
    modelOverrides: { manager: false, worker: false, global: false },
    managerModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, managerModelFallbacks: [],
    workerModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, workerModelFallbacks: [], globalModel: { model: "openai/gpt-5", reasoningEffort: "medium" }, globalModelFallbacks: [],
    globalAgentName: ""
  }
} as unknown as SettingsConfigResponse;

async function render(entry: string, handler: FetchHandler) {
  mockFetch(handler);
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={[entry]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <SettingsPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle(10);
  return host;
}
const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const retryIn = (el: Element) => [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
const failure = (host: ParentNode) => host.querySelector('[data-slot="inline-error"]')!;
const occurrences = (text: string, part: string) => text.split(part).length - 1;
/** The red card errors used to be: its own class, not the substring every
 *  Button carries for an invalid state. */
const redCard = (host: ParentNode) => [...host.querySelectorAll("*")].some((el) => el.classList.contains("border-destructive/40"));

test("while the settings load, the pane region is one Loading… line, not blank panes", async () => {
  const host = await render("/settings", ({ url }) => url === api.settingsConfig ? new Promise<Response>(() => {}) : jsonResponse({ ok: true, models: [] }));
  expect(host.querySelector('[data-slot="loading-line"]')!.textContent).toBe("Loading…");
  expect(host.textContent).not.toContain("Appearance");
});

test("settings that fail to load are the inline error, said once — not a red card, not again in the pane", async () => {
  let reads = 0;
  const host = await render("/settings?tab=providers", ({ url }) => {
    if (url !== api.settingsConfig) return jsonResponse({ ok: true, models: [] });
    reads += 1;
    return reads === 1 ? jsonResponse({ ok: false, error: "config unreadable" }, 500) : jsonResponse(CONFIG);
  });
  expect(failure(host).textContent).toContain("Couldn't load settings.");
  expect(failure(host).querySelector("p")!.textContent).toBe("config unreadable");
  expect(occurrences(host.textContent!, "config unreadable")).toBe(1);
  expect(redCard(host)).toBe(false);
  // No pane while the shell has no settings at all.
  expect(host.textContent).not.toContain("Add provider");
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  expect(reads).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("Add provider");
});

test("a refresh that fails keeps the panes and says they show the last loaded settings", async () => {
  let reads = 0;
  const host = await render("/settings", ({ url }) => {
    if (url !== api.settingsConfig) return jsonResponse({ ok: true, models: [] });
    reads += 1;
    return reads === 1 ? jsonResponse(CONFIG) : jsonResponse({ ok: false, error: "config unreadable" }, 500);
  });
  expect(host.textContent).toContain("Appearance");
  const refresh = host.querySelector('button[aria-label="Refresh settings"]') as HTMLButtonElement;
  await act(async () => { refresh.click(); });
  await settle(10);
  expect(failure(host).textContent).toContain("Couldn't refresh settings. Showing the last loaded ones.");
  expect(failure(host).querySelector("p")!.textContent).toBe("config unreadable");
  expect(host.textContent).toContain("Appearance");
});

test("skills that fail to load are the inline error; Retry reads them again", async () => {
  let reads = 0;
  mockFetch(() => {
    reads += 1;
    return reads === 1 ? jsonResponse({ error: "registry unreadable" }, 500) : jsonResponse({ skills: [] });
  });
  const { host } = await mountAsync(<SkillsPane />);
  await settle(10);
  expect(failure(host).textContent).toContain("Couldn't load skills.");
  expect(redCard(host)).toBe(false);
  await act(async () => { retryIn(failure(host)).click(); });
  await settle(10);
  expect(reads).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("No skills loaded.");
});

// A skill's source badge is a word, not the registry's identifier
// ("builtin").
test("a skill's source badge reads as a word", async () => {
  mockFetch(() => jsonResponse({ skills: [
    { name: "canvas-artifact", description: "How to design a report.", scope: ["manager"], source: "builtin", sourcePath: "/x" },
    { name: "mine", description: "Mine.", scope: ["worker"], source: "user", sourcePath: "/y" },
    { name: "theirs", description: "Theirs.", scope: ["worker"], source: "extra", sourcePath: "/z" }
  ] }));
  const { host } = await mountAsync(<SkillsPane />);
  await settle();
  const badges = [...host.querySelectorAll("[data-slot=skill-source]")].map((b) => b.textContent);
  expect(badges).toEqual(["Built-in", "User", "Extra"]);
});
