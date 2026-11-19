import { useSyncExternalStore } from "react";
import { isTauriRuntime } from "@/lib/runtime";

/** What the desktop shell reports about its sidecar server. `running` is the
 *  silent default; the others drive the banner. `in_use`: another server
 *  holds the data directory, at `url` when it says where it listens. Mirrors
 *  `BackendStatus` in src-tauri/src/lib.rs. */
export type BackendStatus =
  | { state: "running" }
  | { state: "restarting"; attempt: number; code: number | null }
  | { state: "stopped"; attempts: number; code: number | null }
  | { state: "in_use"; url: string | null };

type Listener = () => void;
let status: BackendStatus = { state: "running" };
const listeners = new Set<Listener>();

export function setBackendStatus(next: BackendStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackendStatus(): BackendStatus {
  return useSyncExternalStore(subscribe, () => status, () => status);
}

/** Boot-time wiring: no-op in the browser. The shell may have reported a
 *  status before this page could hear it (a server that stopped at start,
 *  before the window opened), so the page also asks for the current one; an
 *  event heard meanwhile is newer and wins. */
export function trackBackendStatusIfDesktop(): void {
  if (!isTauriRuntime()) return;
  void Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/api/core")]).then(async ([{ listen }, { invoke }]) => {
    let heard = false;
    await listen<BackendStatus>("mandate:backend", (event) => {
      heard = true;
      setBackendStatus(event.payload);
    });
    const now = await invoke<BackendStatus>("backend_status");
    if (!heard) setBackendStatus(now);
  }).catch((error: unknown) => {
    console.warn("[mandate-desktop] backend status unavailable", error);
  });
}

/** For tests and re-installs. */
export function resetBackendStatus(): void {
  setBackendStatus({ state: "running" });
}
