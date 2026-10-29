import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { restartBackendIfAvailable } from "@/lib/backend-restart";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";
import { setBackendStatus, useBackendStatus } from "@/shell/backend-status";

/** Desktop only: a band across the workspace while the sidecar server is
 *  down. Restarting is automatic (the shell retries up to three times a
 *  minute); Stopped means it gave up and the Restart here asks it to try
 *  once more. Nothing renders while the backend runs — network blips keep
 *  the generic "Reconnecting…" pill. */
export function BackendBanner() {
  const status = useBackendStatus();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  if (!isTauriRuntime() || status.state === "running") return null;

  const restart = async () => {
    setBusy(true);
    setBackendStatus({ state: "restarting", attempt: status.state === "stopped" ? status.attempts + 1 : 1, code: status.code });
    try {
      const result = await restartBackendIfAvailable();
      if (result !== "restarted") setBackendStatus({ state: "stopped", attempts: status.state === "stopped" ? status.attempts + 1 : 1, code: status.code });
    } finally {
      setBusy(false);
    }
  };
  const showLog = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setLog(await invoke<string[]>("backend_log"));
    } catch {
      setLog(["(log unavailable)"]);
    }
  };
  const detail = [
    status.code !== null ? `exit code ${status.code}` : null,
    status.state === "stopped" ? `${status.attempts} ${status.attempts === 1 ? "attempt" : "attempts"}` : null
  ].filter(Boolean).join(" · ");

  return (
    <div
      role="status"
      data-slot="backend-banner"
      data-state={status.state}
      className="flex shrink-0 items-center gap-2.5 border-b border-border-soft bg-amber/10 px-3.5 py-2 text-xs text-foreground"
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full bg-amber", status.state === "restarting" && "animate-live")} />
      {status.state === "restarting" ? (
        <>
          <span className="font-medium">Backend stopped.</span>
          <span className="text-muted-foreground">Restarting…</span>
        </>
      ) : (
        <>
          <span className="font-medium">Backend stopped and could not be restarted.</span>
          {detail && <span className="text-muted-foreground">{detail}</span>}
          <span className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => void restart()} disabled={busy}>Restart</Button>
          <Button size="xs" variant="ghost" onClick={() => void showLog()}>Show log</Button>
        </>
      )}
      <Dialog open={log !== null} onOpenChange={(open) => { if (!open) setLog(null); }}>
        <DialogContent className="sm:max-w-[44rem]">
          <DialogHeader><DialogTitle>Backend log</DialogTitle></DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-code-bg p-3 font-mono text-xs leading-[1.55] text-muted-foreground whitespace-pre-wrap break-words">
            {log?.length ? log.join("\n") : "(empty)"}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}
