import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api-paths";
import { readJson } from "./settings-api";
import { SettingsConfigContext, type SettingsConfigStore } from "./settings-config";
import type { SettingsConfigResponse, SettingsConfigUpdate } from "./types";

export function SettingsConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SettingsConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [restartReasons, setRestartReasons] = useState<string[]>([]);
  // Monotonic save counter guarding reload against response reordering: a GET
  // requested before a save's POST can resolve after it, carrying a pre-save
  // snapshot. Applying that snapshot would regress config — ProvidersPane's
  // reconcile would then drop a just-saved new/renamed card, and the next
  // whole-set save would silently delete that provider server-side. savePatch
  // bumps the epoch when it applies its response; a reload applies its
  // response only if the epoch is unchanged since its fetch started, and
  // otherwise refetches once.
  const saveEpochRef = useRef(0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
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
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const savePatch = useCallback(
    async (patch: SettingsConfigUpdate, restartReason?: string) => {
      // Errors from readJson propagate to the caller — units render them.
      const res = await fetch(api.settingsConfig, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
      });
      const payload = await readJson<SettingsConfigResponse>(res);
      saveEpochRef.current += 1;
      setConfig(payload);
      if (payload.restartRequired && restartReason) {
        setRestartReasons((prev) =>
          prev.includes(restartReason) ? prev : [...prev, restartReason]
        );
      }
    },
    []
  );

  const clearRestartReasons = useCallback(() => setRestartReasons([]), []);

  const value = useMemo<SettingsConfigStore>(
    () => ({ config, loading, loadError, reload, savePatch, restartReasons, clearRestartReasons }),
    [config, loading, loadError, reload, savePatch, restartReasons, clearRestartReasons]
  );

  return <SettingsConfigContext.Provider value={value}>{children}</SettingsConfigContext.Provider>;
}
