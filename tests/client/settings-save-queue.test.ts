import { expect, test } from "bun:test";
import { onSettingsSaveLanded, queueSettingsSave, resetSettingsSaveQueue, settingsSaving, settingsSavesSettled } from "@/routes/settings/settings-save-queue";
import type { SettingsConfigResponse } from "@/routes/settings/types";

const config = (preferences: string) => ({ ok: true, restartRequired: false, agent: { preferences } }) as unknown as SettingsConfigResponse;

// What tests/setup.ts does after each test: a save left on its way then
// neither holds up the next save, nor reaches the next listeners, nor counts.
test("after a reset, a save from before it neither holds up the next one, nor reaches its listeners, nor counts as saving", async () => {
  let letGo!: () => void;
  const old = queueSettingsSave(() => new Promise<SettingsConfigResponse>((resolve) => { letGo = () => resolve(config("old")); }));
  expect(settingsSaving()).toBe(true);
  resetSettingsSaveQueue();
  expect(settingsSaving()).toBe(false);
  const told: string[] = [];
  const stop = onSettingsSaveLanded((payload) => told.push(payload.agent.preferences));
  await queueSettingsSave(async () => config("new"));
  await settingsSavesSettled();
  letGo();
  await old;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect([told, settingsSaving()]).toEqual([["new"], false]);
  // A save on its way after that counts as one.
  let release!: () => void;
  const next = queueSettingsSave(() => new Promise<SettingsConfigResponse>((resolve) => { release = () => resolve(config("again")); }));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(settingsSaving()).toBe(true);
  release();
  await next;
  await settingsSavesSettled();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(settingsSaving()).toBe(false);
  stop();
});
