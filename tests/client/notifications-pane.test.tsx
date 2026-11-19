import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@/lib/api-paths";
import { NotificationsPane } from "@/routes/settings/NotificationsPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { NotificationsSettings, SettingsConfigResponse } from "@shared/settings";
import { onCleanup } from "../helpers/cleanup.js";
import { jsonResponse, withFetch } from "../helpers/fetch.js";
import { mount, settleRounds, settleUntil, typeInto } from "../helpers/mount.js";

// Settings › Notifications: this device's own notifications, the channels
// (Telegram in this build), and the address phone links open.

function setFor<T extends object>(target: T, key: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  onCleanup(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

const PHONE = { id: "nch_phone", kind: "telegram", name: "Phone", enabled: true, includeText: true, values: { chatId: "424242", botName: "@mandate_example_bot" }, secretsSaved: ["botToken"] };

function config(notifications: Partial<NotificationsSettings> = {}): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    models: { providers: {} },
    agent: { personalAgentName: "" },
    notifications: { linkBase: "", desktopApp: false, channels: [], ...notifications }
  } as unknown as SettingsConfigResponse;
}

type Post = { url: string; body: Record<string, unknown> };

async function withPane(
  start: SettingsConfigResponse,
  run: (host: HTMLElement, posts: Post[]) => Promise<void>,
  answers: { test?: unknown; connect?: unknown; saveError?: string; holdFirstSave?: Promise<void> } = {}
) {
  const posts: Post[] = [];
  let saved = start;
  let held = false;
  await withFetch(
    async (call) => {
      const method = call.init?.method ?? "GET";
      if (method === "POST") posts.push({ url: call.url, body: JSON.parse(String(call.init!.body)) });
      if (call.url === api.settingsConfig && method === "POST") {
        if (answers.holdFirstSave && !held) {
          held = true;
          await answers.holdFirstSave;
        }
        if (answers.saveError) return jsonResponse({ error: answers.saveError }, 400);
        const patch = (posts.at(-1)!.body.notifications ?? {}) as Record<string, unknown>;
        const current = saved.notifications;
        const upsert = (patch.upsert ?? []) as Array<Record<string, unknown>>;
        let channels = current.channels.filter((c) => !((patch.remove as string[] | undefined) ?? []).includes(c.id));
        for (const entry of upsert) {
          const values = Object.fromEntries(Object.entries(entry.values as Record<string, string>).filter(([key]) => key !== "botToken"));
          const next = { ...PHONE, ...entry, id: (entry.id as string | undefined) ?? "nch_new", values } as typeof PHONE;
          channels = channels.some((c) => c.id === next.id) ? channels.map((c) => (c.id === next.id ? next : c)) : [...channels, next];
        }
        saved = config({
          linkBase: "linkBase" in patch ? (patch.linkBase as string | null) ?? "" : current.linkBase,
          desktopApp: "desktopApp" in patch ? Boolean(patch.desktopApp) : current.desktopApp,
          channels
        });
        return jsonResponse(saved);
      }
      if (call.url === api.settingsConfig) return jsonResponse(saved);
      if (call.url === api.notificationsTest) return jsonResponse(answers.test ?? { ok: true, sentAt: "2026-11-02T10:04:00.000Z" });
      if (call.url === api.notificationsTelegramConnect) return jsonResponse(answers.connect ?? { ok: true, chatId: "424242", botName: "@mandate_example_bot" });
      if (call.url.endsWith("/api/notifications/presence")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch: ${method} ${call.url}`);
    },
    async () => {
      const { host } = mount(<SettingsConfigProvider><NotificationsPane /></SettingsConfigProvider>);
      await settleRounds();
      await run(host, posts);
    }
  );
}

const buttonNamed = (root: ParentNode, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text) ?? null;
const switchNamed = (root: ParentNode, label: string) => root.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
test("the browser row shows Allowed, Allow notifications or why not, by support", async () => {
  const permission = { value: "default" as NotificationPermission };
  class FakeNotification {
    static get permission() { return permission.value; }
    static async requestPermission() { permission.value = "granted"; return "granted"; }
  }
  setFor(window, "Notification", FakeNotification);
  setFor(window, "isSecureContext", true);
  await withPane(config(), async (host) => {
    expect(host.textContent).toContain("This browser");
    expect(host.textContent).toContain("System notifications when this window isn't in use");
    const allow = buttonNamed(host, "Allow notifications")!;
    await act(async () => { allow.click(); });
    await settleUntil(() => host.textContent!.includes("Allowed"), "Allowed after the permission");
    expect(buttonNamed(host, "Allow notifications") === null).toBe(true);
  });
  permission.value = "denied";
  await withPane(config(), async (host) => {
    expect(host.textContent).toContain("Blocked in this browser's settings");
  });
  setFor(window, "isSecureContext", false);
  await withPane(config(), async (host) => {
    expect(host.textContent).toContain("Not available: this address isn't secure (https or localhost).");
    expect(buttonNamed(host, "Allow notifications") === null).toBe(true);
  });
  setFor(window, "isSecureContext", true);
  setFor(navigator, "userAgent", "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148");
  await withPane(config(), async (host) => {
    expect(host.textContent).toContain("Not available in this browser. Use a phone channel below.");
  });
});

test("the desktop app row is a switch that saves desktopApp", async () => {
  setFor(window, "__TAURI_INTERNALS__", {});
  await withPane(config(), async (host, posts) => {
    expect(host.textContent).toContain("Desktop app");
    expect(host.textContent).not.toContain("This browser");
    const toggle = switchNamed(host, "Desktop app notifications")!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle.click(); });
    await settleUntil(() => posts.some((p) => p.url === api.settingsConfig), "the save");
    expect(posts.find((p) => p.url === api.settingsConfig)!.body).toMatchObject({ notifications: { desktopApp: true } });
  });
});

test("a channel row tests and shows the result under it", async () => {
  await withPane(config({ channels: [PHONE] }), async (host, posts) => {
    expect(host.textContent).toContain("Telegram · @mandate_example_bot");
    await act(async () => { buttonNamed(host, "Send test")!.click(); });
    await settleUntil(() => /Sent at \d\d:\d\d\. Check your phone\./.test(host.textContent!), "the test result");
    expect(posts.find((p) => p.url === api.notificationsTest)!.body).toEqual({ channelId: "nch_phone" });
  }, {});
  await withPane(config({ channels: [PHONE] }), async (host) => {
    await act(async () => { buttonNamed(host, "Send test")!.click(); });
    await settleUntil(() => host.textContent!.includes("Failed: Unauthorized."), "the failure");
  }, { test: { ok: false, error: "Unauthorized" } });
});

test("the switch saves the channel's enabled at once", async () => {
  await withPane(config({ channels: [PHONE] }), async (host, posts) => {
    const toggle = switchNamed(host, "Phone on")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => { toggle.click(); });
    await settleUntil(() => posts.some((p) => p.url === api.settingsConfig), "the save");
    const saved = posts.find((p) => p.url === api.settingsConfig)!.body as { notifications: { upsert: Array<Record<string, unknown>> } };
    expect(saved.notifications.upsert).toEqual([{ id: "nch_phone", kind: "telegram", name: "Phone", enabled: false, includeText: true, values: { chatId: "424242", botName: "@mandate_example_bot" } }]);
  });
});

test("the dialog connects, then saves the channel with its chat and name", async () => {
  await withPane(config(), async (host, posts) => {
    await act(async () => { buttonNamed(host, "Add channel")!.click(); });
    const box = dialog()!;
    expect(box.textContent).toContain("Telegram");
    expect(box.textContent).toContain("Send any message to your bot, then press Connect.");
    expect(box.textContent).toContain("Off: only the title leaves this computer.");
    expect(buttonNamed(box, "Save")!.disabled).toBe(true);
    await typeInto(box.querySelector<HTMLInputElement>('input[aria-label="Bot token"]')!, "000000:example-token");
    await act(async () => { buttonNamed(box, "Connect")!.click(); });
    await settleUntil(() => box.textContent!.includes("Connected to @mandate_example_bot."), "connected");
    expect(posts.find((p) => p.url === api.notificationsTelegramConnect)!.body).toEqual({ botToken: "000000:example-token" });
    await act(async () => { buttonNamed(box, "Save")!.click(); });
    await settleUntil(() => dialog() === null, "the dialog closes");
    const saved = posts.find((p) => p.url === api.settingsConfig)!.body as { notifications: { upsert: Array<Record<string, unknown>> } };
    expect(saved.notifications.upsert).toEqual([{ kind: "telegram", name: "Phone", enabled: true, includeText: true, values: { botToken: "000000:example-token", chatId: "424242", botName: "@mandate_example_bot" } }]);
    await settleUntil(() => host.textContent!.includes("Telegram · @mandate_example_bot"), "the new row");
  });
});

test("a blank token edits a channel without sending a token", async () => {
  await withPane(config({ channels: [PHONE] }), async (host, posts) => {
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Actions for Phone"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
    const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Edit"))!;
    await act(async () => { edit.click(); });
    const box = dialog()!;
    expect(box.textContent).toContain("Connected to @mandate_example_bot.");
    await typeInto(box.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, "My phone");
    await act(async () => { buttonNamed(box, "Connect")!.click(); });
    await settleUntil(() => posts.some((p) => p.url === api.notificationsTelegramConnect), "connect");
    expect(posts.find((p) => p.url === api.notificationsTelegramConnect)!.body).toEqual({ channelId: "nch_phone", botToken: "" });
    await act(async () => { buttonNamed(box, "Save")!.click(); });
    await settleUntil(() => posts.some((p) => p.url === api.settingsConfig), "the save");
    const saved = posts.find((p) => p.url === api.settingsConfig)!.body as { notifications: { upsert: Array<{ id: string; name: string; values: Record<string, string> }> } };
    expect(saved.notifications.upsert[0]!.id).toBe("nch_phone");
    expect(saved.notifications.upsert[0]!.name).toBe("My phone");
    expect(saved.notifications.upsert[0]!.values.botToken).toBe("");
  });
});

test("Open links at saves with its section, and a refused address says why", async () => {
  await withPane(config(), async (host, posts) => {
    expect(host.textContent).toContain("The address your other devices open Mandate at");
    expect(host.textContent).toContain("Unset, phone notifications carry no link.");
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Open links at"]')!, "http://mac.example.net:8080");
    await act(async () => { buttonNamed(host, "Save")!.click(); });
    await settleUntil(() => posts.some((p) => p.url === api.settingsConfig), "the save");
    expect(posts.find((p) => p.url === api.settingsConfig)!.body).toEqual({ notifications: { linkBase: "http://mac.example.net:8080" } });
  });
  await withPane(config(), async (host) => {
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Open links at"]')!, "ftp://x");
    await act(async () => { buttonNamed(host, "Save")!.click(); });
    await settleUntil(() => host.textContent!.includes("Open links at must be an http or https address"), "the error");
  }, { saveError: "Open links at must be an http or https address" });
});

test("while a save is on its way, the switches wait for it", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await withPane(config({ channels: [PHONE] }), async (host, posts) => {
    const toggle = () => switchNamed(host, "Phone on")!;
    await act(async () => { toggle().click(); });
    expect(toggle().disabled).toBe(true);
    await act(async () => { toggle().click(); });
    release();
    await settleUntil(() => !toggle().disabled, "the switch back once saved");
    expect(posts.filter((p) => p.url === api.settingsConfig)).toHaveLength(1);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  }, { holdFirstSave: hold });
});

test("a channel of a kind this build lacks is left out of switch saves and offers only Remove", async () => {
  const pager = { id: "nch_pager", kind: "pager", name: "Pager", enabled: true, includeText: true, values: {}, secretsSaved: [] };
  await withPane(config({ channels: [PHONE, pager] }), async (host, posts) => {
    expect(switchNamed(host, "Pager on") === null).toBe(true);
    expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Send test")).toHaveLength(1);
    await act(async () => { switchNamed(host, "Phone on")!.click(); });
    await settleUntil(() => posts.some((p) => p.url === api.settingsConfig), "the save");
    const saved = posts.find((p) => p.url === api.settingsConfig)!.body as { notifications: { upsert: Array<{ id: string }> } };
    expect(saved.notifications.upsert.map((c) => c.id)).toEqual(["nch_phone"]);
  });
});

test("typing a new token asks to connect again", async () => {
  await withPane(config({ channels: [PHONE] }), async (host) => {
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Actions for Phone"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
    const edit = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.includes("Edit"))!;
    await act(async () => { edit.click(); });
    const box = dialog()!;
    expect(box.textContent).toContain("Connected to @mandate_example_bot.");
    expect(buttonNamed(box, "Save")!.disabled).toBe(false);
    await typeInto(box.querySelector<HTMLInputElement>('input[aria-label="Bot token"]')!, "000002:another-token");
    expect(box.textContent).not.toContain("Connected to @mandate_example_bot.");
    expect(buttonNamed(box, "Save")!.disabled).toBe(true);
  });
});
