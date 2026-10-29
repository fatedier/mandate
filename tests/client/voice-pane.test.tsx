import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@/lib/api-paths";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { VoicePane } from "@/routes/settings/VoicePane";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

// The Voice pane's Codex sign-in and sign-out: a failure is said the way a
// provider card says it, as an InlineError.

function config(auth: Record<string, unknown>): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    voice: {
      provider: "codex", providerType: "codex", model: "", voice: "alloy", language: "", baseURL: "", deployment: "",
      idleTimeoutMs: 600_000, maxSessionMs: 1_800_000, contextMessageCount: 20, apiKeyConfigured: false, auth
    },
    models: { providers: { codex: { type: "codex", baseURL: "", models: [], apiKeyConfigured: false, auth } } }
  } as unknown as SettingsConfigResponse;
}

const SIGNED_IN = { status: "authenticated", configured: true, accountId: "acc", email: "dev@example.com", profileId: "p" };

async function pane(auth: Record<string, unknown>, failing: { url: string; error: string }) {
  mockFetch((call) => call.url === failing.url
    ? jsonResponse({ ok: false, error: failing.error }, 500)
    : jsonResponse(config(auth)));
  const { host } = await mountAsync(
    <SettingsConfigProvider>
      <VoicePane />
    </SettingsConfigProvider>
  );
  await settle();
  const press = async (label: string) => {
    const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label)!;
    await act(async () => { button.click(); });
    await settle(10);
  };
  const error = () => {
    const el = host.querySelector('[data-slot="inline-error"]');
    return el ? { message: el.querySelector("span")?.textContent, detail: el.querySelector("p")?.textContent ?? null } : null;
  };
  return { press, error };
}

test("a failed sign-out reads Couldn't sign out., the reason below", async () => {
  const p = await pane(SIGNED_IN, { url: api.codexAuthLogout, error: "auth profile is locked" });
  expect(p.error()).toBeNull();
  await p.press("Sign out");
  expect(p.error()).toEqual({ message: "Couldn't sign out.", detail: "auth profile is locked" });
});

test("a failed sign-in reads Couldn't sign in., the reason below", async () => {
  const p = await pane({ status: "missing", configured: false }, { url: api.codexAuthStart, error: "Login timed out." });
  await p.press("Sign in");
  expect(p.error()).toEqual({ message: "Couldn't sign in.", detail: "Login timed out." });
});

// The OpenAI fields that read as blank boxes say what blank means, and the
// context count says what it counts.
test("the base URL, deployment and context count say what they do", async () => {
  mockFetch(() => jsonResponse({
    ...config({ status: "missing", configured: false }),
    voice: {
      provider: "openai", providerType: "openai", model: "gpt-realtime-mini", voice: "marin", language: "", baseURL: "", deployment: "",
      idleTimeoutMs: 300_000, maxSessionMs: 1_500_000, contextMessageCount: 25, apiKeyConfigured: true, auth: null
    },
    models: { providers: { openai: { type: "openai", baseURL: "", models: [], apiKeyConfigured: true } } }
  }));
  const { host } = await mountAsync(
    <SettingsConfigProvider>
      <VoicePane />
    </SettingsConfigProvider>
  );
  await settle();
  const row = (anchor: string) => host.querySelector(`[data-setting-anchor="${anchor}"]`)!;
  expect(row("voice-base-url").textContent).toContain("Blank uses OpenAI. An Azure address switches to Azure's key and deployment.");
  expect(row("voice-base-url").querySelector("input")!.getAttribute("placeholder")).toBe("wss://api.openai.com/v1/realtime");
  expect(row("voice-deployment").textContent).toContain("Azure only. Blank uses the model name.");
  expect(host.querySelector("#setting-voice-context")!.textContent).toContain("Recent messages voice hears when it starts. 0 starts fresh.");
});
