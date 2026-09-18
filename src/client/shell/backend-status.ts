import { useSyncExternalStore } from "react";
import { isTauriRuntime } from "@/lib/runtime";

/** What the desktop shell reports about its sidecar server. `running` is the
 *  silent default; the other two drive the banner. Mirrors `BackendStatus` in
 *  src-tauri/src/lib.rs. */
export type BackendStatus =
  | { state: "running" }
  | { state: "restarting"; attempt: number; code: number | null }
  | { state: "stopped"; attempts: number; code: number | null };

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

/** Boot-time wiring: no-op in the browser. */
export function trackBackendStatusIfDesktop(): void {
  if (!isTauriRuntime()) return;
  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<BackendStatus>("mandate:backend", (event) => setBackendStatus(event.payload))
  ).catch((error: unknown) => {
    console.warn("[mandate-desktop] backend status events unavailable", error);
  });
}

/** For tests and re-installs. */
export function resetBackendStatus(): void {
  setBackendStatus({ state: "running" });
}
