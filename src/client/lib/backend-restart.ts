import { api } from "./api-paths";
import { isTauriRuntime } from "./runtime";

type RestartResult = "restarted" | "unavailable";

export async function restartBackendIfAvailable(): Promise<RestartResult> {
  if (!isTauriRuntime()) return "unavailable";

  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_backend");
  await waitForBackend();
  return "restarted";
}

async function waitForBackend() {
  const deadline = Date.now() + 15000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(api.info, {
        method: "HEAD", cache: "no-store",
        signal: AbortSignal.timeout(Math.min(3000, Math.max(1, deadline - Date.now())))
      });
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "timeout");
  throw new Error(`backend did not become ready after restart (${message})`);
}
