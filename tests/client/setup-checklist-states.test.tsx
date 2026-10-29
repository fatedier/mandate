import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { SetupStatusResponse } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";
import { SetupChecklist } from "@/routes/projects/SetupChecklist";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchHandler } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { fakeClock, realClock } from "../helpers/fake-clock.js";

const SESSION_KEY = "mandate.setup.active";
beforeEach(() => window.sessionStorage.removeItem(SESSION_KEY));
afterEach(() => {
  runCleanups();
  window.sessionStorage.removeItem(SESSION_KEY);
});

/** A first run: nothing set up yet. */
const STATUS: SetupStatusResponse = {
  ok: true, firstRun: true, ready: false,
  models: { providerCount: 1, defaultModel: "openai/gpt-4.1-mini", defaultModelReady: false, managerModelReady: false, workerModelReady: false, ready: false },
  terminal: { tmuxAvailable: true, error: null, ready: true },
  projects: { count: 0, ready: false },
  agent: { preferencesReady: false }
};

const config = (providers: Record<string, unknown>, model: string) => ({
  ok: true, restartRequired: false,
  models: { default: { model, reasoningEffort: "medium", modelFallbacks: [] }, providers },
  agent: {
    preferences: "", compressionThresholdTokens: 200000, logRequests: "metadata",
    modelOverrides: { manager: false, worker: false, global: false },
    managerModel: { model, reasoningEffort: "medium" }, managerModelFallbacks: [],
    workerModel: { model, reasoningEffort: "medium" }, workerModelFallbacks: [], globalModel: { model, reasoningEffort: "medium" }, globalModelFallbacks: []
  }
}) as unknown as SettingsConfigResponse;
const OPENAI = config({ openai: { type: "openai", baseURL: "", models: [{ id: "gpt-4.1-mini", input: ["text"] }], apiKeyConfigured: true } }, "openai/gpt-4.1-mini");
const CODEX = config({ codex: { type: "codex", models: [{ id: "gpt-5.6-sol", input: ["text"] }] } }, "codex/gpt-5.6-sol");

const RAW = "request failed (502): upstream connect error";

async function render(handler: FetchHandler, hasProjects = false) {
  mockFetch(handler);
  const { host } = await mountAsync(<MemoryRouter><SetupChecklist hasProjects={hasProjects} /></MemoryRouter>);
  await settle(10);
  return host;
}
const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const failure = (host: ParentNode) => host.querySelector('[data-slot="inline-error"]')!;
const button = (host: ParentNode, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
/** The red card failures used to be: its own class, not the substring every
 *  Button carries for an invalid state. */
const framed = (host: ParentNode) => [...host.querySelectorAll("*")].some((el) => el.classList.contains("border-destructive/40") || el.classList.contains("border-phase-done/35"));

test("a first check that fails while setting up: one sentence with Retry, no \"Checking setup…\", no steps to click", async () => {
  window.sessionStorage.setItem(SESSION_KEY, "true");
  let reads = 0;
  const host = await render(({ url }) => {
    if (url === api.setupStatus) {
      reads += 1;
      return reads === 1 ? jsonResponse({ error: RAW }, 502) : jsonResponse(STATUS);
    }
    return jsonResponse(OPENAI);
  });
  expect(failure(host).textContent).toContain("Couldn't check your setup.");
  expect(failure(host).querySelector("p")!.textContent).toBe(RAW);
  expect(host.textContent).not.toContain("Checking setup");
  expect(button(host, "Models") === undefined).toBe(true);
  expect(framed(host)).toBe(false);
  await act(async () => { button(failure(host), "Retry")!.click(); });
  await settle(10);
  expect(reads).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(button(host, "Models") === undefined).toBe(false);
});

test("a first check that fails for someone not setting up shows no setup card at all", async () => {
  const host = await render(({ url }) => url === api.setupStatus ? jsonResponse({ error: RAW }, 502) : jsonResponse(OPENAI));
  expect(host.textContent).toBe("");
});

test("a refresh that fails keeps the step on screen and says it shows the last result", async () => {
  let reads = 0;
  const host = await render(({ url }) => {
    if (url === api.setupStatus) {
      reads += 1;
      return reads === 1 ? jsonResponse(STATUS) : jsonResponse({ error: RAW }, 502);
    }
    return jsonResponse(OPENAI);
  });
  expect(host.textContent).toContain("Choose the provider Mandate should use");
  await act(async () => { button(host, "Refresh setup status")!.click(); });
  await settle(10);
  expect(failure(host).textContent).toContain("Couldn't refresh the setup check. Showing the last result.");
  expect(failure(host).querySelector("p")!.textContent).toBe(RAW);
  expect(button(failure(host), "Retry") === undefined).toBe(false);
  expect(host.textContent).toContain("Choose the provider Mandate should use");
  expect(framed(host)).toBe(false);
});

test("a provider that fails to save says which step failed, the server's words below, and no Retry beside Next", async () => {
  const host = await render(({ url, init }) => {
    if (url === api.setupStatus) return jsonResponse(STATUS);
    if (init?.method === "POST") return jsonResponse({ error: "config write failed: EACCES" }, 500);
    return jsonResponse(OPENAI);
  });
  await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Next"))!.click(); });
  await settle(10);
  expect(failure(host).textContent).toContain("Couldn't save the provider.");
  expect(failure(host).querySelector("p")!.textContent).toBe("config write failed: EACCES");
  expect(button(failure(host), "Retry") === undefined).toBe(true);
  expect(framed(host)).toBe(false);
  // Next did not move on past the step that failed.
  expect(host.querySelector(".label-micro")!.textContent).toBe("Models");
});

test("a form left incomplete is the sentence itself, with nothing below it", async () => {
  const host = await render(({ url }) => url === api.setupStatus ? jsonResponse(STATUS) : jsonResponse(OPENAI));
  const model = [...host.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Default model"))!.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(model, "");
    model.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Next"))!.click(); });
  await settle(10);
  expect(failure(host).textContent).toBe("Default model is required.");
  expect(failure(host).querySelector("p") === null).toBe(true);
});

test("a sign-in notice is a quiet line with a check, not a framed box", async () => {
  const host = await render(({ url }) => {
    if (url === api.setupStatus) return jsonResponse(STATUS);
    if (url === api.codexAuthStart) return jsonResponse({ ok: true, opened: true, url: "https://auth.openai.com/x", requestId: "req1" });
    if (url.includes("req1")) return new Promise<Response>(() => {});
    return jsonResponse(CODEX);
  });
  await act(async () => { button(host, "Sign in")!.click(); });
  await settle(10);
  const notice = host.querySelector('[data-slot="setup-notice"]')!;
  expect(notice.textContent).toBe("Browser sign-in opened.");
  expect(notice.querySelector("svg") === null).toBe(false);
  expect(framed(host)).toBe(false);
});

/** A Codex sign-in whose status poll (made 1.5s after the browser opens) answers `result`. */
async function signIn(result: Record<string, unknown>) {
  const host = await render(({ url }) => {
    if (url === api.setupStatus) return jsonResponse(STATUS);
    if (url === api.codexAuthStart) return jsonResponse({ ok: true, opened: true, url: "https://auth.openai.com/x", requestId: "req1" });
    if (url.includes("req1")) return jsonResponse(result);
    return jsonResponse(CODEX);
  });
  // The sign-in is asked after 1.5 s, by the clock: faked here and moved on.
  fakeClock();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  await act(async () => { button(host, "Sign in")!.click(); await flush(); });
  await act(async () => { jest.advanceTimersByTime(1700); await flush(); });
  realClock();
  await settle(10);
  return host;
}

test("a sign-in that does not finish takes its notice with it", async () => {
  const host = await signIn({ ok: true, status: "failed", providerName: "codex", error: "access denied" });
  expect(has(host, '[data-slot="setup-notice"]')).toBe(false);
  expect(failure(host).textContent).toContain("Codex sign-in didn't finish.");
  expect(failure(host).querySelector("p")!.textContent).toBe("access denied");
});

test("a sign-in that finishes says so", async () => {
  const host = await signIn({ ok: true, status: "authenticated", providerName: "codex", email: "a@example.com", accountId: "acct" });
  expect(host.querySelector('[data-slot="setup-notice"]')!.textContent).toBe("Codex sign-in complete.");
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
});

test("agent preferences are optional: with a model, the terminal and a project ready, the set-up card is gone though none is written", async () => {
  window.sessionStorage.setItem(SESSION_KEY, "true");
  const ready: SetupStatusResponse = {
    ...STATUS, ready: true,
    models: { ...STATUS.models, defaultModelReady: true, managerModelReady: true, workerModelReady: true, ready: true },
    projects: { count: 1, ready: true }
  };
  expect(ready.agent.preferencesReady).toBe(false);
  const done = await render(({ url }) => (url.includes(api.setupStatus) ? jsonResponse(ready) : jsonResponse(OPENAI)), true);
  expect(done.textContent).not.toContain("Set up Mandate");

  // Still shown while something that is needed is missing, the step for the
  // preference among the others.
  runCleanups();
  window.sessionStorage.setItem(SESSION_KEY, "true");
  const missing = await render(({ url }) => (url.includes(api.setupStatus) ? jsonResponse({ ...ready, ready: false, projects: { count: 0, ready: false } }) : jsonResponse(OPENAI)), false);
  expect(missing.textContent).toContain("Set up Mandate");
  expect(missing.textContent).toContain("Agent preferences");
});
