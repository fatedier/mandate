import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { api } from "@/lib/api-paths";
import { RestartBanner } from "@/routes/settings/RestartBanner";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import { useSettingsConfig } from "@/routes/settings/settings-config";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil } from "../helpers/mount.js";

// The Settings banner for a saved change that needs a restart. Only the
// desktop app restarts Mandate itself, through Tauri's restart_backend.

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  runCleanups();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

const config = (restartRequired: boolean) =>
  ({ ok: true, restartRequired, server: { host: "127.0.0.1", port: 4100 } }) as unknown as SettingsConfigResponse;

let savePatch: ReturnType<typeof useSettingsConfig>["savePatch"] | null = null;
function Saver() {
  savePatch = useSettingsConfig().savePatch;
  return null;
}

test("a restart that fails says Couldn't restart Mandate., the reason small below", async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {
    invoke: (cmd: string) => Promise.reject(new Error(`${cmd} failed: backend process not found`))
  };
  mockFetch((call) => jsonResponse(config((call.init?.method ?? "GET") !== "GET" && call.url === api.settingsConfig)));
  const { host } = await mountAsync(
    <SettingsConfigProvider>
      <RestartBanner />
      <Saver />
    </SettingsConfigProvider>
  );
  await settle();
  await act(async () => { await savePatch!({ server: { host: "0.0.0.0" } }, "Listen address"); });
  expect(host.textContent).toContain("Listen address changed");
  const restart = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Restart now")!;
  await act(async () => { restart.click(); });
  // The restart loads the Tauri module first: a few ms idle, more under a
  // parallel run, so wait for the error rather than a fixed time.
  await settleUntil(() => host.querySelector('[data-slot="inline-error"]') !== null, "the restart error", 500);
  const error = host.querySelector('[data-slot="inline-error"]');
  expect(error?.querySelector("span")?.textContent).toBe("Couldn't restart Mandate.");
  expect(error?.querySelector("p")?.textContent).toBe("restart_backend failed: backend process not found");
  // The reason stays: the change still needs a restart that worked.
  expect(host.textContent).toContain("Listen address changed");
});
