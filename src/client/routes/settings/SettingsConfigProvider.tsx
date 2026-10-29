import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api-paths";
import { readJson, saveSettingsConfig } from "./settings-api";
import { SettingsConfigContext, type SettingsConfigStore } from "./settings-config";
import { onSettingsSaveLanded, queueSettingsSave, settingsSavesSettled, takeUnclaimedRestartReasons, useSettingsSaving } from "./settings-save-queue";
import type { SettingsConfigResponse, SettingsConfigUpdate } from "./types";
import { errorText } from "@shared/error-text";

export function SettingsConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SettingsConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [restartReasons, setRestartReasons] = useState<string[]>([]);
  // Saves asked for and not yet answered, any section's and any visit's.
  const saving = useSettingsSaving();
  // Monotonic save counter guarding reload against response reordering: a GET
  // requested before a save's POST can resolve after it, carrying a pre-save
  // snapshot. Applying that snapshot would regress config — ProvidersPane's
  // reconcile would then drop a just-saved new/renamed card, and the next
  // whole-set save would silently delete that provider server-side. A save
  // landing bumps the epoch when it applies its response; a reload applies its
  // response only if the epoch is unchanged since its fetch started, and
  // otherwise refetches once.
  const saveEpochRef = useRef(0);

  // Every save as it lands, this visit's or one an earlier visit left on its
  // way: its answer is the config after it. Subscribed before the first read.
  useEffect(() => {
    const addReason = (reason: string) => setRestartReasons((prev) => (prev.includes(reason) ? prev : [...prev, reason]));
    for (const reason of takeUnclaimedRestartReasons()) addReason(reason);
    return onSettingsSaveLanded((payload, restartReason) => {
      saveEpochRef.current += 1;
      setConfig(payload);
      if (payload.restartRequired && restartReason) addReason(restartReason);
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // A save still on its way (an earlier visit's included) lands first: a
      // read before it would show the config from before it.
      await settingsSavesSettled();
      for (let attempt = 0; attempt < 2; attempt++) {
        const epoch = saveEpochRef.current;
        const res = await fetch(api.settingsConfig);
        const payload = await readJson<SettingsConfigResponse>(res);
        if (saveEpochRef.current !== epoch) continue; // stale — a save applied mid-flight
        setConfig(payload);
        setLoadError("");
        return;
      }
      // Both attempts raced a save; its response is the fresher config anyway.
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Saves go out one at a time, in the order they were asked for, whatever
  // visit asked (settings-save-queue): a section mounted again, or Settings
  // left and opened again, queues behind what is still on its way. Errors
  // from the save propagate to the caller — units render them.
  const savePatch = useCallback(
    (patch: SettingsConfigUpdate, restartReason?: string) => queueSettingsSave(() => saveSettingsConfig(patch), restartReason),
    []
  );

  const clearRestartReasons = useCallback(() => setRestartReasons([]), []);

  const value = useMemo<SettingsConfigStore>(
    () => ({ config, loading, loadError, reload, savePatch, saving, restartReasons, clearRestartReasons }),
    [config, loading, loadError, reload, savePatch, saving, restartReasons, clearRestartReasons]
  );

  return <SettingsConfigContext.Provider value={value}>{children}</SettingsConfigContext.Provider>;
}
