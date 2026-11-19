import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { restartBackendIfAvailable } from "@/lib/backend-restart";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";
import { setBackendStatus, useBackendStatus, type BackendStatus } from "@/shell/backend-status";

/** Desktop only: a band across the workspace while the sidecar server is
 *  down. Restarting is automatic (the shell retries up to three times a
 *  minute); Stopped means it gave up and the Restart here asks it to try
 *  once more. In use means another server holds the data directory: the
 *  shell does not retry, and the band says so, with that server's page to
 *  open. Nothing renders while the backend runs — network blips keep the
 *  generic "Reconnecting…" pill. */
export function BackendBanner() {
  const status = useBackendStatus();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[] | null>(null);
  if (!isTauriRuntime() || status.state === "running") return null;

  const restart = async () => {
    setBusy(true);
    const attempts = status.state === "stopped" ? status.attempts + 1 : 1;
    const code = status.state === "stopped" || status.state === "restarting" ? status.code : null;
    setBackendStatus({ state: "restarting", attempt: attempts, code });
    try {
      const result = await restartBackendIfAvailable();
      if (result !== "restarted") setBackendStatus({ state: "stopped", attempts, code });
    } catch {
      // Not back: the shell says why (another server still holds the data
      // directory, or it stopped again).
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setBackendStatus(await invoke<BackendStatus>("backend_status"));
      } catch {
        setBackendStatus({ state: "stopped", attempts, code });
      }
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
  const detail = status.state === "stopped" ? [
    status.code !== null ? `exit code ${status.code}` : null,
    `${status.attempts} ${status.attempts === 1 ? "attempt" : "attempts"}`
  ].filter(Boolean).join(" · ") : "";
  // A narrow workspace wraps the words in their own column and moves the
  // buttons to a line of their own, never past the edge.
  const words = "flex min-w-[min(14rem,100%)] flex-1 basis-0 flex-wrap items-baseline gap-x-2.5";
  const actions = "ml-auto flex shrink-0 items-center gap-2.5";

  return (
    <div
      role="status"
      data-slot="backend-banner"
      data-state={status.state}
      className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border-soft bg-amber/10 px-3.5 py-2 text-xs text-foreground"
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full bg-amber", status.state === "restarting" && "animate-live")} />
      {status.state === "restarting" ? (
        <span className={words}>
          <span className="font-medium">Backend stopped.</span>
          <span className="text-muted-foreground">Restarting…</span>
        </span>
      ) : status.state === "in_use" ? (
        <>
          <span className={words}>
            <span className="font-medium">Another Mandate server is using this data directory.</span>
            <span className="text-muted-foreground">Quit it, then Restart.</span>
          </span>
          <span className={actions}>
            <Button size="xs" variant="outline" onClick={() => void restart()} disabled={busy}>Restart</Button>
            <Button size="xs" variant="ghost" onClick={() => void showLog()}>Show log</Button>
            {status.url && (
              <Button size="xs" variant="ghost" onClick={() => window.open(status.url!, "_blank", "noopener")}>Open the running one</Button>
            )}
          </span>
        </>
      ) : (
        <>
          <span className={words}>
            <span className="font-medium">Backend stopped and could not be restarted.</span>
            {detail && <span className="text-muted-foreground">{detail}</span>}
          </span>
          <span className={actions}>
            <Button size="xs" variant="outline" onClick={() => void restart()} disabled={busy}>Restart</Button>
            <Button size="xs" variant="ghost" onClick={() => void showLog()}>Show log</Button>
          </span>
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
