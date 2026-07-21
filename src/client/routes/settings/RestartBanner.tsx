import { useState } from "react";
import { Button } from "@/components/ui/button";
import { restartBackendIfAvailable } from "@/lib/backend-restart";
import { isTauriRuntime } from "@/lib/runtime";
import { useSettingsConfig } from "./settings-config";

/**
 * Page-level restart notice: lists every saved change that needs a backend
 * restart. In the desktop app it can perform the restart itself; in the
 * browser it is informational only (the user restarts Mandate however they
 * run it).
 */
export function RestartBanner() {
  const { restartReasons, clearRestartReasons, reload } = useSettingsConfig();
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState("");

  if (restartReasons.length === 0) return null;

  const onRestart = () => {
    if (restarting) return;
    setRestarting(true);
    setError("");
    void (async () => {
      try {
        const result = await restartBackendIfAvailable();
        if (result === "restarted") {
          clearRestartReasons();
          await reload();
        }
        // "unavailable": nothing restarted — keep the reasons, no error.
      } catch (err) {
        // Restart attempted but the backend never came back healthy; the
        // reasons stay because the change still needs a (successful) restart.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRestarting(false);
      }
    })();
  };

  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-status-review/35 bg-status-review/10 px-3.5 py-2 text-sm">
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-review" />
      <span className="min-w-0">
        <b>{restartReasons.join(", ")}</b> changed — restart Mandate to apply.
      </span>
      {isTauriRuntime() ? (
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          disabled={restarting}
          onClick={onRestart}
        >
          {restarting ? "Restarting…" : "Restart now"}
        </Button>
      ) : null}
      {error ? <span className="basis-full text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
